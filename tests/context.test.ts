import assert from 'node:assert/strict';
import test from 'node:test';
import { createAnalyticsContext, init } from '../src/index.js';

const createMemoryStorage = (): Storage => {
  const map = new Map<string, string>();

  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
};

const withMockedGlobals = async (
  fn: (calls: Array<{ input: RequestInfo | URL; init?: RequestInit }>) => Promise<void>,
): Promise<void> => {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return new Response(JSON.stringify({ accepted: true }), {
      status: 202,
      headers: {
        'content-type': 'application/json',
      },
    });
  }) as typeof globalThis.fetch;

  Object.defineProperty(globalThis, 'localStorage', {
    value: createMemoryStorage(),
    configurable: true,
    writable: true,
  });

  try {
    await fn(calls);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalLocalStorage) {
      Object.defineProperty(globalThis, 'localStorage', {
        value: originalLocalStorage,
        configurable: true,
        writable: true,
      });
    } else {
      Reflect.deleteProperty(globalThis, 'localStorage');
    }
  }
};

test('createAnalyticsContext() provides onboarding + consent controls with minimal host-app wiring', async () => {
  await withMockedGlobals(async (calls) => {
    const context = createAnalyticsContext({
      client: {
        apiKey: 'pi_live_test',
        flushIntervalMs: 60_000,
        maxRetries: 0,
      },
      onboarding: {
        onboardingFlowId: 'onboarding_v1',
        onboardingFlowVersion: '1.0.0',
        isNewUser: true,
      },
    });

    try {
      assert.equal(context.consent.get(), true);
      context.consent.set(false);
      assert.equal(context.consent.get(), false);
      context.consent.set(true);

      context.onboarding.start();
      context.onboarding.step('welcome', 0).view();
      await context.flush();

      assert.equal(calls.length, 1);
      const payload = JSON.parse(String(calls[0]?.init?.body)) as {
        events: Array<{ eventName: string; properties?: Record<string, unknown> }>;
      };
      assert.deepEqual(
        payload.events.map((event) => event.eventName),
        ['onboarding:start', 'onboarding:step_view'],
      );
      assert.equal(payload.events[0]?.properties?.onboardingFlowId, 'onboarding_v1');
    } finally {
      context.shutdown();
    }
  });
});

test('createAnalyticsContext() can bind an exported paywall tracker instance later', async () => {
  await withMockedGlobals(async (calls) => {
    const context = createAnalyticsContext({
      client: {
        apiKey: 'pi_live_test',
        flushIntervalMs: 60_000,
        maxRetries: 0,
      },
    });

    try {
      assert.equal(context.paywall, null);
      context.configurePaywall({
        source: 'onboarding',
        paywallId: 'default_paywall',
        offering: 'rc_main',
      });

      assert.ok(context.paywall);
      context.paywall?.shown({ fromScreen: 'onboarding_offer' });
      context.paywall?.purchaseSuccess({ packageId: 'annual' });
      await context.flush();

      assert.equal(calls.length, 1);
      const payload = JSON.parse(String(calls[0]?.init?.body)) as {
        events: Array<{ eventName: string; properties?: Record<string, unknown> }>;
      };
      assert.deepEqual(
        payload.events.map((event) => event.eventName),
        ['paywall:shown', 'purchase:success'],
      );
      const paywallEntryId = payload.events[0]?.properties?.paywallEntryId;
      assert.equal(typeof paywallEntryId, 'string');
      assert.equal(payload.events[1]?.properties?.paywallEntryId, paywallEntryId);
    } finally {
      context.shutdown();
    }
  });
});

test('createAnalyticsContext() accepts an existing AnalyticsClient instance', () => {
  const client = init({
    apiKey: 'pi_live_test',
    flushIntervalMs: 60_000,
    maxRetries: 0,
  });

  const context = createAnalyticsContext({
    client,
  });

  try {
    assert.equal(context.client, client);
  } finally {
    context.shutdown();
  }
});
