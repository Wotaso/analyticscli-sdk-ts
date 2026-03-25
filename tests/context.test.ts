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
        ['session_start', 'paywall:shown', 'purchase:success'],
      );
      const paywallEntryId = payload.events[1]?.properties?.paywallEntryId;
      assert.equal(typeof paywallEntryId, 'string');
      assert.equal(payload.events[2]?.properties?.paywallEntryId, paywallEntryId);
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

test('createAnalyticsContext() emits session_start once per client instance', async () => {
  await withMockedGlobals(async (calls) => {
    const client = init({
      apiKey: 'pi_live_test',
      flushIntervalMs: 60_000,
      maxRetries: 0,
    });

    const contextA = createAnalyticsContext({ client });
    const contextB = createAnalyticsContext({ client });

    try {
      await contextA.flush();
      assert.equal(calls.length, 1);
      const payload = JSON.parse(String(calls[0]?.init?.body)) as {
        events: Array<{ eventName: string }>;
      };
      assert.deepEqual(payload.events.map((event) => event.eventName), ['session_start']);
    } finally {
      contextA.shutdown();
      contextB.shutdown();
    }
  });
});

test('createAnalyticsContext() forwards wrapper APIs for tracking, consent, user, and scoped factories', async () => {
  await withMockedGlobals(async (calls) => {
    const context = createAnalyticsContext({
      client: 'pi_live_test',
      onboarding: {
        onboardingFlowId: 'flow_default',
        onboardingFlowVersion: '1',
        isNewUser: true,
      },
      paywall: {
        source: 'onboarding',
        paywallId: 'paywall_default',
      },
    });

    try {
      await context.ready();

      context.setContext({
        appBuild: '100',
        osName: 'ios',
        osVersion: '17',
        region: 'BE',
        city: 'Berlin',
      });

      assert.equal(context.consent.get(), true);
      context.consent.optOut();
      context.consent.optIn();
      context.consent.set(true);
      assert.equal(context.consent.getState(), 'granted');
      context.consent.setFullTracking(false);
      context.consent.optInFullTracking();
      context.consent.optOutFullTracking();
      assert.equal(typeof context.consent.isFullTrackingEnabled(), 'boolean');

      context.user.identify('user-1', { plan: 'pro' });
      context.user.set('user-2', { role: 'owner' });
      context.user.clear();

      context.track('custom:event', { origin: 'context' });
      context.trackOnboardingEvent('onboarding:start', {
        onboardingFlowId: 'flow_default',
      });
      context.trackOnboardingSurveyResponse({
        surveyKey: 'onboarding',
        questionKey: 'intent',
        answerType: 'single_choice',
        responseKey: 'growth',
      });
      context.trackPaywallEvent('paywall:shown', {
        source: 'onboarding',
      });
      context.screen('home');
      context.page('home_alt');
      context.feedback('great sdk', 5, { channel: 'test' });

      const onboarding = context.createOnboarding({
        onboardingFlowId: 'flow_custom',
        onboardingFlowVersion: '2',
        stepCount: 3,
      });
      onboarding.start();
      onboarding.step('welcome', 0).complete();

      context.configureOnboarding({
        onboardingFlowId: 'flow_reconfigured',
        onboardingFlowVersion: '3',
      });
      context.onboarding.start();

      const paywall = context.createPaywall({
        source: 'onboarding',
        paywallId: 'paywall_custom',
      });
      paywall.shown({ fromScreen: 'onboarding_offer' });
      context.configurePaywall({
        source: 'onboarding',
        paywallId: 'paywall_reconfigured',
      });
      context.paywall?.shown({ fromScreen: 'reconfigured_offer' });

      await context.flush();

      assert.ok(calls.length >= 1);
      const payload = JSON.parse(String(calls[0]?.init?.body)) as {
        events: Array<{ eventName: string }>;
      };
      assert.ok(payload.events.length > 0);
    } finally {
      context.shutdown();
    }
  });
});

test('createAnalyticsContext() handles null client input as safe no-op context', () => {
  const context = createAnalyticsContext({
    client: null,
  });

  try {
    context.track('onboarding:start');
    assert.equal(context.paywall, null);
  } finally {
    context.shutdown();
  }
});
