import assert from 'node:assert/strict';
import test from 'node:test';
import {
  init,
  initConsentFirst,
  initAsync,
  ONBOARDING_EVENTS,
  ONBOARDING_SURVEY_EVENTS,
  PAYWALL_EVENTS,
  PURCHASE_EVENTS,
} from '../src/index.js';
import type { AnalyticsIngestError } from '../src/index.js';

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

const withMockedConsoleError = async (
  fn: (calls: unknown[][]) => Promise<void>,
): Promise<void> => {
  const calls: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    calls.push(args);
  };

  try {
    await fn(calls);
  } finally {
    console.error = originalConsoleError;
  }
};

const withoutSessionStart = <T extends { eventName: string }>(events: T[]): T[] =>
  events.filter((event) => event.eventName !== 'session_start');

const eventNamesWithoutSessionStart = (events: Array<{ eventName: string }>): string[] =>
  withoutSessionStart(events).map((event) => event.eventName);

const createCookieDocument = (): { cookie: string } => {
  const store = new Map<string, string>();

  return {
    get cookie() {
      return Array.from(store.entries())
        .map(([key, value]) => `${key}=${value}`)
        .join('; ');
    },
    set cookie(value: string) {
      const [pair, ...attributes] = value.split(';').map((part) => part.trim());
      const [key, raw] = pair.split('=');
      const maxAge = attributes.find((attribute) => attribute.toLowerCase().startsWith('max-age='));
      const isDelete = maxAge?.toLowerCase() === 'max-age=0';

      if (!key) {
        return;
      }

      if (isDelete) {
        store.delete(key);
        return;
      }

      store.set(key, raw ?? '');
    },
  };
};

test('track() flushes a valid ingest batch', async () => {
  await withMockedGlobals(async (calls) => {
    const client = init({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.analyticscli.com',
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
    });

    try {
      client.track('onboarding:start', {
        appVersion: '1.0.0',
      });
      await client.flush();

      assert.equal(calls.length, 1);
      assert.equal(String(calls[0]?.input), 'https://collector.analyticscli.com/v1/collect');

      const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
      assert.equal(headers['x-api-key'], 'pi_live_test');

      const payload = JSON.parse(String(calls[0]?.init?.body)) as {
        events: Array<{ eventName: string; properties?: Record<string, unknown> }>;
      };

      const onboardingStartEvent = payload.events.find((event) => event.eventName === 'onboarding:start');
      assert.ok(onboardingStartEvent);
      assert.equal(typeof onboardingStartEvent.properties?.runtimeEnv, 'string');
    } finally {
      client.shutdown();
    }
  });
});

test('init() supports the short apiKey form', async () => {
  await withMockedGlobals(async (calls) => {
    const client = init('pi_live_test');

    try {
      client.track('onboarding:start');
      await client.flush();

      assert.equal(calls.length, 1);
      const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
      assert.equal(headers['x-api-key'], 'pi_live_test');
    } finally {
      client.shutdown();
    }
  });
});

test('initConsentFirst() starts with tracking disabled until optIn()', async () => {
  await withMockedGlobals(async (calls) => {
    const client = initConsentFirst('pi_live_test');

    try {
      client.track('onboarding:start');
      await client.flush();
      assert.equal(calls.length, 0);

      client.optIn();
      client.track('onboarding:complete');
      await client.flush();
      assert.equal(calls.length, 1);
    } finally {
      client.shutdown();
    }
  });
});

test('init() tolerates window objects without addEventListener', () => {
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const originalWindow = (globalThis as { window?: unknown }).window;

  Object.defineProperty(globalThis, 'window', {
    value: {},
    configurable: true,
    writable: true,
  });

  let client: ReturnType<typeof init> | null = null;

  try {
    assert.doesNotThrow(() => {
      client = init({
        apiKey: 'pi_live_test',
        flushIntervalMs: 60_000,
        maxRetries: 0,
      });
    });
  } finally {
    client?.shutdown();

    if (hadWindow) {
      Object.defineProperty(globalThis, 'window', {
        value: originalWindow,
        configurable: true,
        writable: true,
      });
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  }
});

test('uses the default collector endpoint when endpoint is omitted', async () => {
  await withMockedGlobals(async (calls) => {
    const client = init({
      apiKey: 'pi_live_test',
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
    });

    try {
      client.track('onboarding:start');
      await client.flush();

      assert.equal(calls.length, 1);
      assert.equal(String(calls[0]?.input), 'https://collector.analyticscli.com/v1/collect');
    } finally {
      client.shutdown();
    }
  });
});

test('apiKey-only init payload is valid', async () => {
  await withMockedGlobals(async (calls) => {
    const client = init({
      apiKey: 'pi_live_test',
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
    });

    try {
      client.track('onboarding:start');
      await client.flush();

      assert.equal(calls.length, 1);
      const payload = JSON.parse(String(calls[0]?.init?.body)) as {
        events: Array<{ eventName: string }>;
      };
      assert.deepEqual(eventNamesWithoutSessionStart(payload.events), ['onboarding:start']);
    } finally {
      client.shutdown();
    }
  });
});

test('uses a custom collector endpoint override when provided', async () => {
  await withMockedGlobals(async (calls) => {
    const client = init({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.staging.analyticscli.com/',
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
    });

    try {
      client.track('onboarding:start');
      await client.flush();

      assert.equal(calls.length, 1);
      assert.equal(String(calls[0]?.input), 'https://collector.staging.analyticscli.com/v1/collect');
    } finally {
      client.shutdown();
    }
  });
});

test('normalizes macos platform option to canonical mac', async () => {
  await withMockedGlobals(async (calls) => {
    const client = init({
      apiKey: 'pi_live_test',
      platform: 'macos',
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
    });

    try {
      client.track('onboarding:start');
      await client.flush();

      assert.equal(calls.length, 1);
      const payload = JSON.parse(String(calls[0]?.init?.body)) as {
        events: Array<{ eventName: string; platform?: string }>;
      };
      const onboardingStartEvent = payload.events.find((event) => event.eventName === 'onboarding:start');
      assert.equal(onboardingStartEvent?.platform, 'mac');
    } finally {
      client.shutdown();
    }
  });
});

test('includes projectSurface on emitted events when configured', async () => {
  await withMockedGlobals(async (calls) => {
    const client = init({
      apiKey: 'pi_live_test',
      projectSurface: 'Dashboard',
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
    });

    try {
      client.track('onboarding:start');
      await client.flush();

      assert.equal(calls.length, 1);
      const payload = JSON.parse(String(calls[0]?.init?.body)) as {
        events: Array<{ eventName: string; projectSurface?: string }>;
      };
      const onboardingStartEvent = payload.events.find((event) => event.eventName === 'onboarding:start');
      assert.equal(onboardingStartEvent?.projectSurface, 'dashboard');
    } finally {
      client.shutdown();
    }
  });
});

test('accepts null appVersion option without requiring undefined coalescing', async () => {
  await withMockedGlobals(async (calls) => {
    const client = init({
      apiKey: 'pi_live_test',
      appVersion: null,
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
    });

    try {
      client.track('onboarding:start');
      await client.flush();

      assert.equal(calls.length, 1);
      const payload = JSON.parse(String(calls[0]?.init?.body)) as {
        events: Array<{ eventName: string; appVersion?: string }>;
      };
      const onboardingStartEvent = payload.events.find((event) => event.eventName === 'onboarding:start');
      assert.equal(onboardingStartEvent?.appVersion, undefined);
    } finally {
      client.shutdown();
    }
  });
});

test('init() without credentials is a safe no-op client', async () => {
  await withMockedConsoleError(async (errorCalls) => {
    await withMockedGlobals(async (calls) => {
      const client = init({
        batchSize: 20,
        flushIntervalMs: 60_000,
        maxRetries: 0,
      });

      try {
        client.track('onboarding:start');
        client.screen('welcome');
        client.feedback('hi');
        client.identify('user-1');
        client.optIn();
        await client.flush();

        assert.equal(calls.length, 0);
        assert.equal(errorCalls.length, 1);
        assert.match(String(errorCalls[0]?.[0] ?? ''), /Missing required `apiKey`/);
      } finally {
        client.shutdown();
      }
    });
  });
});

test('init() with empty apiKey string logs a configuration error and stays no-op', async () => {
  await withMockedConsoleError(async (errorCalls) => {
    await withMockedGlobals(async (calls) => {
      const client = init('   ');

      try {
        client.track('onboarding:start');
        await client.flush();

        assert.equal(calls.length, 0);
        assert.equal(errorCalls.length, 1);
        assert.match(String(errorCalls[0]?.[0] ?? ''), /Missing required `apiKey`/);
      } finally {
        client.shutdown();
      }
    });
  });
});

test('optOut() disables enqueue and prevents network calls', async () => {
  await withMockedGlobals(async (calls) => {
    const client = init({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.analyticscli.com',
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
    });

    try {
      client.optOut();
      client.track('onboarding:start');
      await client.flush();

      assert.equal(calls.length, 0);
    } finally {
      client.shutdown();
    }
  });
});

test('initialConsentGranted=false requires explicit optIn() before tracking', async () => {
  await withMockedGlobals(async (calls) => {
    const client = init({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.analyticscli.com',
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
      initialConsentGranted: false,
    });

    try {
      client.track('onboarding:start');
      await client.flush();
      assert.equal(calls.length, 0);

      client.optIn();
      client.track('onboarding:complete');
      await client.flush();

      assert.equal(calls.length, 1);
      const payload = JSON.parse(String(calls[0]?.init?.body)) as {
        events: Array<{ eventName: string }>;
      };
      assert.deepEqual(eventNamesWithoutSessionStart(payload.events), ['onboarding:complete']);
    } finally {
      client.shutdown();
    }
  });
});

test('persisted consent in storage is ignored in strict-only mode', async () => {
  await withMockedGlobals(async (calls) => {
    globalThis.localStorage.setItem('analyticscli:consent:v1', 'denied');
    const storage = globalThis.localStorage as unknown as {
      getItem: (key: string) => string | null;
      setItem: (key: string, value: string) => void;
      removeItem: (key: string) => void;
    };

    const client = init({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.analyticscli.com',
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
      storage,
    });

    try {
      assert.equal(client.getConsent(), true);
      assert.equal(client.getConsentState(), 'granted');
      client.track('onboarding:start');
      await client.flush();
      assert.equal(calls.length, 1);
    } finally {
      client.shutdown();
    }
  });
});

test('consent changes do not persist across client instances in strict-only mode', async () => {
  await withMockedGlobals(async (calls) => {
    const storage = globalThis.localStorage as unknown as {
      getItem: (key: string) => string | null;
      setItem: (key: string, value: string) => void;
      removeItem: (key: string) => void;
    };

    const first = init({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.analyticscli.com',
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
      storage,
    });

    try {
      first.optOut();
      assert.equal(globalThis.localStorage.getItem('analyticscli:consent:v1'), null);
    } finally {
      first.shutdown();
    }

    const second = init({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.analyticscli.com',
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
      storage,
    });

    try {
      assert.equal(second.getConsent(), true);
      second.track('onboarding:start');
      await second.flush();
      assert.equal(calls.length, 1);
      second.optIn();
      assert.equal(globalThis.localStorage.getItem('analyticscli:consent:v1'), null);
    } finally {
      second.shutdown();
    }
  });
});

test('screen() and feedback() use canonical event names', async () => {
  await withMockedGlobals(async (calls) => {
    const client = init({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.analyticscli.com',
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
    });

    try {
      client.screen('welcome');
      client.feedback('great app', 5);
      await client.flush();

      assert.equal(calls.length, 1);
      const payload = JSON.parse(String(calls[0]?.init?.body)) as {
        events: Array<{ eventName: string }>;
      };

      const eventNames = eventNamesWithoutSessionStart(payload.events);
      assert.deepEqual(eventNames, ['screen:welcome', 'feedback_submitted']);
    } finally {
      client.shutdown();
    }
  });
});

test('screen() normalizes route-like names before enqueueing', async () => {
  await withMockedGlobals(async (calls) => {
    const client = init({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.analyticscli.com',
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
    });

    try {
      client.screen('/onboarding/welcome');
      client.screen('/');
      await client.flush();

      assert.equal(calls.length, 1);
      const payload = JSON.parse(String(calls[0]?.init?.body)) as {
        events: Array<{ eventName: string }>;
      };

      const eventNames = eventNamesWithoutSessionStart(payload.events);
      assert.deepEqual(eventNames, ['screen:onboarding_welcome', 'screen:root']);
    } finally {
      client.shutdown();
    }
  });
});

test('typed onboarding/paywall wrappers emit canonical event names', async () => {
  await withMockedGlobals(async (calls) => {
    const client = init({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.analyticscli.com',
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
    });

    try {
      client.trackOnboardingEvent(ONBOARDING_EVENTS.START, {
        isNewUser: true,
        onboardingFlowId: 'onboarding_v4',
        onboardingExperimentId: 'exp_onboarding_v4',
        stepIndex: 0,
        stepCount: 5,
      });
      client.trackPaywallEvent(PAYWALL_EVENTS.SHOWN, {
        source: 'onboarding',
        paywallId: 'default_paywall',
        offering: 'rc_main',
        paywallEntryId: 'manual_entry',
        fromScreen: 'onboarding_paywall',
      });
      client.trackPaywallEvent(PURCHASE_EVENTS.SUCCESS, {
        source: 'onboarding',
        paywallId: 'default_paywall',
        offering: 'rc_main',
        paywallEntryId: 'manual_entry',
        packageId: 'annual',
      });

      await client.flush();

      assert.equal(calls.length, 1);
      const payload = JSON.parse(String(calls[0]?.init?.body)) as {
        events: Array<{ eventName: string; properties?: Record<string, unknown> }>;
      };
      const trackedEvents = withoutSessionStart(payload.events);

      assert.deepEqual(
        trackedEvents.map((event) => event.eventName),
        [
          ONBOARDING_EVENTS.START,
          PAYWALL_EVENTS.SHOWN,
          PURCHASE_EVENTS.SUCCESS,
        ],
      );
      assert.deepEqual(
        trackedEvents.map((event) => event.properties?.sessionEventIndex),
        [2, 3, 4],
      );
      assert.equal(trackedEvents[0]?.properties?.onboardingExperimentId, 'exp_onboarding_v4');
      assert.equal(trackedEvents[1]?.properties?.offering, 'rc_main');
      assert.equal(trackedEvents[2]?.properties?.offering, 'rc_main');
      assert.equal(trackedEvents[1]?.properties?.paywallEntryId, undefined);
      assert.equal(trackedEvents[2]?.properties?.paywallEntryId, undefined);
    } finally {
      client.shutdown();
    }
  });
});

test('createPaywallTracker() applies shared defaults and supports all journey helpers', async () => {
  await withMockedGlobals(async (calls) => {
    const client = init({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.analyticscli.com',
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
    });

    try {
      const paywall = client.createPaywallTracker({
        source: 'onboarding',
        paywallId: 'default_paywall',
        offering: 'rc_main',
        appVersion: '2.1.0',
        experimentVariant: 'B',
      });

      paywall.shown({ fromScreen: 'onboarding_offer' });
      paywall.purchaseStarted({ packageId: 'annual' });
      paywall.purchaseSuccess({ packageId: 'annual' });
      paywall.track(PAYWALL_EVENTS.SKIP, { source: 'settings' });

      await client.flush();

      assert.equal(calls.length, 1);
      const payload = JSON.parse(String(calls[0]?.init?.body)) as {
        events: Array<{ eventName: string; properties?: Record<string, unknown> }>;
      };
      const trackedEvents = withoutSessionStart(payload.events);

      assert.deepEqual(
        trackedEvents.map((event) => event.eventName),
        [
          PAYWALL_EVENTS.SHOWN,
          PURCHASE_EVENTS.STARTED,
          PURCHASE_EVENTS.SUCCESS,
          PAYWALL_EVENTS.SKIP,
        ],
      );

      const first = trackedEvents[0]?.properties ?? {};
      assert.equal(first.source, 'onboarding');
      assert.equal(first.paywallId, 'default_paywall');
      assert.equal(first.offering, 'rc_main');
      assert.equal(first.appVersion, '2.1.0');
      assert.equal(first.experimentVariant, 'B');
      assert.equal(first.fromScreen, 'onboarding_offer');
      assert.equal(typeof first.paywallEntryId, 'string');
      assert.ok(String(first.paywallEntryId).length > 0);

      const firstEntryId = String(first.paywallEntryId);
      const second = trackedEvents[1]?.properties ?? {};
      const third = trackedEvents[2]?.properties ?? {};
      assert.equal(second.paywallEntryId, firstEntryId);
      assert.equal(third.paywallEntryId, firstEntryId);
      assert.equal(second.offering, undefined);
      assert.equal(third.offering, undefined);

      const override = trackedEvents[3]?.properties ?? {};
      assert.equal(override.source, 'settings');
      assert.equal(override.paywallId, 'default_paywall');
      assert.equal(override.paywallEntryId, firstEntryId);
      assert.equal(override.offering, undefined);
    } finally {
      client.shutdown();
    }
  });
});

test('createPaywallTracker() rotates paywallEntryId per shown event and keeps offering on shown only', async () => {
  await withMockedGlobals(async (calls) => {
    const client = init({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.analyticscli.com',
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
    });

    try {
      const paywall = client.createPaywallTracker({
        source: 'onboarding',
        paywallId: 'default_paywall',
        offering: 'rc_main',
      });

      paywall.shown();
      paywall.purchaseStarted({ packageId: 'annual' });
      paywall.shown({ offering: 'rc_alt' });
      paywall.purchaseCancel({ packageId: 'annual' });

      await client.flush();

      assert.equal(calls.length, 1);
      const payload = JSON.parse(String(calls[0]?.init?.body)) as {
        events: Array<{ eventName: string; properties?: Record<string, unknown> }>;
      };
      const trackedEvents = withoutSessionStart(payload.events);

      assert.deepEqual(
        trackedEvents.map((event) => event.eventName),
        [
          PAYWALL_EVENTS.SHOWN,
          PURCHASE_EVENTS.STARTED,
          PAYWALL_EVENTS.SHOWN,
          PURCHASE_EVENTS.CANCEL,
        ],
      );

      const firstShown = trackedEvents[0]?.properties ?? {};
      const firstPurchase = trackedEvents[1]?.properties ?? {};
      const secondShown = trackedEvents[2]?.properties ?? {};
      const secondPurchase = trackedEvents[3]?.properties ?? {};

      assert.equal(firstShown.offering, 'rc_main');
      assert.equal(secondShown.offering, 'rc_alt');
      assert.equal(firstPurchase.offering, undefined);
      assert.equal(secondPurchase.offering, undefined);

      const firstEntryId = String(firstShown.paywallEntryId ?? '');
      const secondEntryId = String(secondShown.paywallEntryId ?? '');
      assert.ok(firstEntryId.length > 0);
      assert.ok(secondEntryId.length > 0);
      assert.notEqual(firstEntryId, secondEntryId);
      assert.equal(firstPurchase.paywallEntryId, firstEntryId);
      assert.equal(secondPurchase.paywallEntryId, secondEntryId);
    } finally {
      client.shutdown();
    }
  });
});

test('setUser()/identify() are blocked before full-tracking consent in consent-gated mode', async () => {
  await withMockedGlobals(async (calls) => {
    const client = init({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.analyticscli.com',
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
    });

    try {
      client.setUser(' user_123 ', { plan: 'pro' });
      client.identify('user_999', { plan: 'enterprise' });
      client.track('feature:opened');
      client.setUser('');
      client.track('feature:closed');

      await client.flush();

      assert.equal(calls.length, 1);
      const payload = JSON.parse(String(calls[0]?.init?.body)) as {
        events: Array<{ eventName: string; userId?: string | null; properties?: Record<string, unknown> }>;
      };
      const trackedEvents = withoutSessionStart(payload.events);

      assert.deepEqual(
        trackedEvents.map((event) => event.eventName),
        ['feature:opened', 'feature:closed'],
      );
      assert.equal(trackedEvents[0]?.userId, null);
      assert.equal(trackedEvents[1]?.userId, null);
    } finally {
      client.shutdown();
    }
  });
});

test('consent-gated default keeps identity ephemeral and ignores explicit identity overrides before full-tracking consent', async () => {
  await withMockedGlobals(async (calls) => {
    const client = init({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.analyticscli.com',
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
      anonId: 'shared-anon',
      sessionId: 'shared-session',
    });

    try {
      client.setUser('user_123', { plan: 'pro' });
      client.identify('user_456');
      client.track('feature:opened');

      await client.flush();

      assert.equal(calls.length, 1);
      const payload = JSON.parse(String(calls[0]?.init?.body)) as {
        events: Array<{
          eventName: string;
          anonId: string;
          sessionId: string;
          userId?: string | null;
          properties?: Record<string, unknown>;
        }>;
      };
      const trackedEvents = withoutSessionStart(payload.events);
      const featureOpenedEvent = trackedEvents.find((event) => event.eventName === 'feature:opened');

      assert.equal(trackedEvents.length, 1);
      assert.ok(featureOpenedEvent);
      assert.equal(featureOpenedEvent.userId, null);
      assert.notEqual(featureOpenedEvent.anonId, 'shared-anon');
      assert.notEqual(featureOpenedEvent.sessionId, 'shared-session');
      assert.equal(globalThis.localStorage.length, 0);
    } finally {
      client.shutdown();
    }
  });
});

test('setFullTrackingConsent(true) enables persistence and identity linkage', async () => {
  await withMockedGlobals(async (calls) => {
    const storage = globalThis.localStorage as unknown as {
      getItem: (key: string) => string | null;
      setItem: (key: string, value: string) => void;
      removeItem: (key: string) => void;
    };
    const client = init({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.analyticscli.com',
      storage,
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
    });

    try {
      client.setFullTrackingConsent(true);
      client.setUser('user_123', { plan: 'pro' });
      client.track('feature:opened');
      await client.flush();

      assert.equal(calls.length, 1);
      const payload = JSON.parse(String(calls[0]?.init?.body)) as {
        events: Array<{ eventName: string; userId?: string | null }>;
      };
      const trackedEvents = withoutSessionStart(payload.events);

      assert.deepEqual(
        trackedEvents.map((event) => event.eventName),
        ['identify', 'feature:opened'],
      );
      assert.equal(trackedEvents[0]?.userId, 'user_123');
      assert.equal(trackedEvents[1]?.userId, 'user_123');
      assert.equal(typeof globalThis.localStorage.getItem('pi_device_id'), 'string');
      assert.equal(typeof globalThis.localStorage.getItem('pi_session_id'), 'string');
    } finally {
      client.shutdown();
    }
  });
});

test('enableFullTrackingWithoutConsent=true enables full tracking immediately', async () => {
  await withMockedGlobals(async (calls) => {
    const storage = globalThis.localStorage as unknown as {
      getItem: (key: string) => string | null;
      setItem: (key: string, value: string) => void;
      removeItem: (key: string) => void;
    };
    const client = init({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.analyticscli.com',
      storage,
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
      enableFullTrackingWithoutConsent: true,
    });

    try {
      client.identify('user_999', { plan: 'enterprise' });
      client.track('feature:opened');
      await client.flush();

      assert.equal(calls.length, 1);
      const payload = JSON.parse(String(calls[0]?.init?.body)) as {
        events: Array<{ eventName: string; userId?: string | null }>;
      };
      const trackedEvents = withoutSessionStart(payload.events);
      assert.deepEqual(
        trackedEvents.map((event) => event.eventName),
        ['identify', 'feature:opened'],
      );
      assert.equal(trackedEvents[0]?.userId, 'user_999');
      assert.equal(trackedEvents[1]?.userId, 'user_999');
      assert.equal(typeof globalThis.localStorage.getItem('pi_device_id'), 'string');
    } finally {
      client.shutdown();
    }
  });
});

test('setFullTrackingConsent() is a no-op in strict and always_on identity modes', async () => {
  await withMockedGlobals(async (calls) => {
    const storage = globalThis.localStorage as unknown as {
      getItem: (key: string) => string | null;
      setItem: (key: string, value: string) => void;
      removeItem: (key: string) => void;
    };

    const strictClient = init({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.analyticscli.com',
      storage,
      identityTrackingMode: 'strict',
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
    });
    const alwaysOnClient = init({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.analyticscli.com',
      storage,
      identityTrackingMode: 'always_on',
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
    });

    try {
      strictClient.setFullTrackingConsent(true);
      strictClient.identify('strict_user');
      strictClient.track('strict:event');
      await strictClient.flush();

      alwaysOnClient.setFullTrackingConsent(false);
      alwaysOnClient.identify('always_user');
      alwaysOnClient.track('always:event');
      await alwaysOnClient.flush();

      assert.equal(calls.length, 2);

      const strictPayload = JSON.parse(String(calls[0]?.init?.body)) as {
        events: Array<{ eventName: string; userId?: string | null }>;
      };
      const strictEvents = withoutSessionStart(strictPayload.events);
      assert.deepEqual(strictEvents.map((event) => event.eventName), ['strict:event']);
      assert.equal(strictEvents[0]?.userId, null);

      const alwaysPayload = JSON.parse(String(calls[1]?.init?.body)) as {
        events: Array<{ eventName: string; userId?: string | null }>;
      };
      const alwaysEvents = withoutSessionStart(alwaysPayload.events);
      assert.deepEqual(alwaysEvents.map((event) => event.eventName), ['identify', 'always:event']);
      assert.equal(alwaysEvents[0]?.userId, 'always_user');
      assert.equal(alwaysEvents[1]?.userId, 'always_user');
    } finally {
      strictClient.shutdown();
      alwaysOnClient.shutdown();
    }
  });
});

test('debug logging is disabled by default and enabled with debug=true', async () => {
  const originalConsoleDebug = console.debug;
  const debugCalls: unknown[][] = [];

  console.debug = (...args: unknown[]) => {
    debugCalls.push(args);
  };

  try {
    const defaultClient = init({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.analyticscli.com',
      flushIntervalMs: 60_000,
      maxRetries: 0,
    });

    const explicitDebugClient = init({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.analyticscli.com',
      flushIntervalMs: 60_000,
      maxRetries: 0,
      debug: true,
    });

    try {
      defaultClient.trackPaywallEvent(PAYWALL_EVENTS.SHOWN, {} as never);
      explicitDebugClient.trackPaywallEvent(PAYWALL_EVENTS.SHOWN, {} as never);

      assert.equal(debugCalls.length, 1);
      assert.equal(debugCalls[0]?.[0], '[analyticscli-sdk]');
      assert.equal(
        debugCalls[0]?.[1],
        'Dropping paywall event without required `source` property',
      );
    } finally {
      defaultClient.shutdown();
      explicitDebugClient.shutdown();
    }
  } finally {
    console.debug = originalConsoleDebug;
  }
});

test('onIngestError reports structured diagnostics for 401 and pauses repeated flush attempts', async () => {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const reportedErrors: AnalyticsIngestError[] = [];
  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return new Response(
      JSON.stringify({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid public api key',
        },
      }),
      {
        status: 401,
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'req_401_test',
        },
      },
    );
  }) as typeof globalThis.fetch;

  Object.defineProperty(globalThis, 'localStorage', {
    value: createMemoryStorage(),
    configurable: true,
    writable: true,
  });

  const client = init({
    apiKey: 'pi_live_test',
    endpoint: 'https://collector.analyticscli.com',
    batchSize: 20,
    flushIntervalMs: 60_000,
    maxRetries: 4,
    onIngestError: (error) => {
      reportedErrors.push(error);
    },
  });

  try {
    client.track('onboarding:start');
    await client.flush();
    await client.flush();

    assert.equal(calls.length, 1);
    assert.equal(reportedErrors.length, 1);

    const first = reportedErrors[0];
    assert.ok(first);
    assert.equal(first.name, 'AnalyticsIngestError');
    assert.equal(first.endpoint, 'https://collector.analyticscli.com');
    assert.equal(first.path, '/v1/collect');
    assert.equal(first.status, 401);
    assert.equal(first.errorCode, 'UNAUTHORIZED');
    assert.equal(first.serverMessage, 'Invalid public api key');
    assert.equal(first.requestId, 'req_401_test');
    assert.equal(first.retryable, false);
    assert.equal(first.attempts, 1);
    assert.equal(first.maxRetries, 4);
    assert.equal(first.batchSize, 2);
    assert.equal(first.queueSize, 2);
    assert.equal(typeof first.timestamp, 'string');
  } finally {
    client.shutdown();
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
});

test('strict-only mode disables cookie-based persistence even when cookieDomain is provided', async () => {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  const originalDocument = (globalThis as typeof globalThis & { document?: unknown }).document;
  const originalLocation = (globalThis as typeof globalThis & { location?: unknown }).location;
  const originalLocalStorage = globalThis.localStorage;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return new Response(JSON.stringify({ accepted: true }), { status: 202 });
  }) as typeof globalThis.fetch;

  const cookieDocument = createCookieDocument();
  Object.defineProperty(globalThis, 'document', {
    value: cookieDocument,
    configurable: true,
    writable: true,
  });

  Object.defineProperty(globalThis, 'location', {
    value: { protocol: 'https:' },
    configurable: true,
    writable: true,
  });

  Reflect.deleteProperty(globalThis, 'localStorage');

  const client = init({
    apiKey: 'pi_live_test',
    endpoint: 'https://collector.analyticscli.com',
    cookieDomain: '.analyticscli.com',
    batchSize: 20,
    flushIntervalMs: 60_000,
    maxRetries: 0,
  });

  try {
    client.track('onboarding:start');
    await client.flush();

    assert.equal(calls.length, 1);
    assert.equal(cookieDocument.cookie, '');
  } finally {
    client.shutdown();
    globalThis.fetch = originalFetch;

    if (originalDocument) {
      Object.defineProperty(globalThis, 'document', {
        value: originalDocument,
        configurable: true,
        writable: true,
      });
    } else {
      Reflect.deleteProperty(globalThis, 'document');
    }

    if (originalLocation) {
      Object.defineProperty(globalThis, 'location', {
        value: originalLocation,
        configurable: true,
        writable: true,
      });
    } else {
      Reflect.deleteProperty(globalThis, 'location');
    }

    if (originalLocalStorage) {
      Object.defineProperty(globalThis, 'localStorage', {
        value: originalLocalStorage,
        configurable: true,
        writable: true,
      });
    }
  }
});

test('dedupeOnboardingStepViewsPerSession is enabled by default and drops repeated onboarding:step_view events in one session', async () => {
  await withMockedGlobals(async (calls) => {
    const client = init({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.analyticscli.com',
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
    });

    try {
      client.trackOnboardingEvent(ONBOARDING_EVENTS.STEP_VIEW, {
        onboardingFlowId: 'onboarding_v4',
        onboardingFlowVersion: '4.0.0',
        stepKey: 'welcome',
        stepIndex: 0,
      });
      client.trackOnboardingEvent(ONBOARDING_EVENTS.STEP_VIEW, {
        onboardingFlowId: 'onboarding_v4',
        onboardingFlowVersion: '4.0.0',
        stepKey: 'welcome',
        stepIndex: 0,
      });
      client.trackOnboardingEvent(ONBOARDING_EVENTS.STEP_VIEW, {
        onboardingFlowId: 'onboarding_v4',
        onboardingFlowVersion: '4.0.0',
        stepKey: 'goal',
        stepIndex: 1,
      });
      client.trackPaywallEvent(PAYWALL_EVENTS.SHOWN, {
        source: 'onboarding',
        paywallId: 'default_paywall',
      });
      client.trackPaywallEvent(PAYWALL_EVENTS.SHOWN, {
        source: 'onboarding',
        paywallId: 'default_paywall',
      });

      await client.flush();

      assert.equal(calls.length, 1);
      const payload = JSON.parse(String(calls[0]?.init?.body)) as {
        events: Array<{ eventName: string; properties?: Record<string, unknown> }>;
      };
      const trackedEvents = withoutSessionStart(payload.events);

      assert.deepEqual(
        trackedEvents.map((event) => event.eventName),
        [
          ONBOARDING_EVENTS.STEP_VIEW,
          ONBOARDING_EVENTS.STEP_VIEW,
          PAYWALL_EVENTS.SHOWN,
          PAYWALL_EVENTS.SHOWN,
        ],
      );
      assert.deepEqual(
        trackedEvents.map((event) => event.properties?.sessionEventIndex),
        [2, 3, 4, 5],
      );
    } finally {
      client.shutdown();
    }
  });
});

test('dedupeOnboardingStepViewsPerSession=false keeps repeated onboarding:step_view events in one session', async () => {
  await withMockedGlobals(async (calls) => {
    const client = init({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.analyticscli.com',
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
      dedupeOnboardingStepViewsPerSession: false,
    });

    try {
      client.trackOnboardingEvent(ONBOARDING_EVENTS.STEP_VIEW, {
        onboardingFlowId: 'onboarding_v4',
        onboardingFlowVersion: '4.0.0',
        stepKey: 'welcome',
        stepIndex: 0,
      });
      client.trackOnboardingEvent(ONBOARDING_EVENTS.STEP_VIEW, {
        onboardingFlowId: 'onboarding_v4',
        onboardingFlowVersion: '4.0.0',
        stepKey: 'welcome',
        stepIndex: 0,
      });
      client.trackPaywallEvent(PAYWALL_EVENTS.SHOWN, {
        source: 'onboarding',
        paywallId: 'default_paywall',
      });

      await client.flush();

      assert.equal(calls.length, 1);
      const payload = JSON.parse(String(calls[0]?.init?.body)) as {
        events: Array<{ eventName: string; properties?: Record<string, unknown> }>;
      };
      const trackedEvents = withoutSessionStart(payload.events);

      assert.deepEqual(
        trackedEvents.map((event) => event.eventName),
        [ONBOARDING_EVENTS.STEP_VIEW, ONBOARDING_EVENTS.STEP_VIEW, PAYWALL_EVENTS.SHOWN],
      );
      assert.deepEqual(
        trackedEvents.map((event) => event.properties?.sessionEventIndex),
        [2, 3, 4],
      );
    } finally {
      client.shutdown();
    }
  });
});

test('dedupeScreenViewsPerSession is enabled by default and drops immediate duplicate screen events', async () => {
  await withMockedGlobals(async (calls) => {
    const client = init({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.analyticscli.com',
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
    });

    try {
      client.screen('paywall', {
        screen_class: '/paywall',
        origin: 'onboarding',
      });
      client.screen('paywall', {
        screen_class: '/paywall',
      });
      client.screen('home', {
        screen_class: '/home',
      });

      await client.flush();

      assert.equal(calls.length, 1);
      const payload = JSON.parse(String(calls[0]?.init?.body)) as {
        events: Array<{ eventName: string; properties?: Record<string, unknown> }>;
      };
      const trackedEvents = withoutSessionStart(payload.events);

      assert.deepEqual(
        trackedEvents.map((event) => event.eventName),
        ['screen:paywall', 'screen:home'],
      );
      assert.deepEqual(
        trackedEvents.map((event) => event.properties?.sessionEventIndex),
        [2, 3],
      );
    } finally {
      client.shutdown();
    }
  });
});

test('dedupeScreenViewsPerSession=false keeps immediate duplicate screen events', async () => {
  await withMockedGlobals(async (calls) => {
    const client = init({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.analyticscli.com',
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
      dedupeScreenViewsPerSession: false,
    });

    try {
      client.screen('paywall', {
        screen_class: '/paywall',
      });
      client.screen('paywall', {
        screen_class: '/paywall',
      });

      await client.flush();

      assert.equal(calls.length, 1);
      const payload = JSON.parse(String(calls[0]?.init?.body)) as {
        events: Array<{ eventName: string; properties?: Record<string, unknown> }>;
      };
      const trackedEvents = withoutSessionStart(payload.events);

      assert.deepEqual(
        trackedEvents.map((event) => event.eventName),
        ['screen:paywall', 'screen:paywall'],
      );
      assert.deepEqual(
        trackedEvents.map((event) => event.properties?.sessionEventIndex),
        [2, 3],
      );
    } finally {
      client.shutdown();
    }
  });
});

test('screenViewDedupeWindowMs only drops screen duplicates inside the configured window', async () => {
  await withMockedGlobals(async (calls) => {
    const client = init({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.analyticscli.com',
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
      screenViewDedupeWindowMs: 500,
    });

    const originalNow = Date.now;
    let nowMs = 1_000;
    Date.now = () => nowMs;

    try {
      client.screen('paywall', {
        screen_class: '/paywall',
      });
      nowMs = 1_300;
      client.screen('paywall', {
        screen_class: '/paywall',
      });
      nowMs = 1_800;
      client.screen('paywall', {
        screen_class: '/paywall',
      });

      await client.flush();

      assert.equal(calls.length, 1);
      const payload = JSON.parse(String(calls[0]?.init?.body)) as {
        events: Array<{ eventName: string; properties?: Record<string, unknown> }>;
      };
      const trackedEvents = withoutSessionStart(payload.events);

      assert.deepEqual(
        trackedEvents.map((event) => event.eventName),
        ['screen:paywall', 'screen:paywall'],
      );
      assert.deepEqual(
        trackedEvents.map((event) => event.properties?.sessionEventIndex),
        [2, 3],
      );
    } finally {
      Date.now = originalNow;
      client.shutdown();
    }
  });
});

test('dedupeOnboardingStepViewsPerSession resets across sessions', async () => {
  const storage = createMemoryStorage();
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
    value: storage,
    configurable: true,
    writable: true,
  });

  const createClient = (sessionId: string) =>
    init({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.analyticscli.com',
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
      dedupeOnboardingStepViewsPerSession: true,
      sessionId,
      storage,
    });

  const firstClient = createClient('session-1');
  const secondClient = createClient('session-2');

  try {
    firstClient.trackOnboardingEvent(ONBOARDING_EVENTS.STEP_VIEW, {
      onboardingFlowId: 'onboarding_v4',
      onboardingFlowVersion: '4.0.0',
      stepKey: 'welcome',
      stepIndex: 0,
    });
    firstClient.trackOnboardingEvent(ONBOARDING_EVENTS.STEP_VIEW, {
      onboardingFlowId: 'onboarding_v4',
      onboardingFlowVersion: '4.0.0',
      stepKey: 'welcome',
      stepIndex: 0,
    });
    await firstClient.flush();

    secondClient.trackOnboardingEvent(ONBOARDING_EVENTS.STEP_VIEW, {
      onboardingFlowId: 'onboarding_v4',
      onboardingFlowVersion: '4.0.0',
      stepKey: 'welcome',
      stepIndex: 0,
    });
    await secondClient.flush();

    assert.equal(calls.length, 2);

    const firstPayload = JSON.parse(String(calls[0]?.init?.body)) as {
      events: Array<{ eventName: string }>;
    };
    const secondPayload = JSON.parse(String(calls[1]?.init?.body)) as {
      events: Array<{ eventName: string }>;
    };

    assert.deepEqual(eventNamesWithoutSessionStart(firstPayload.events), [
      ONBOARDING_EVENTS.STEP_VIEW,
    ]);
    assert.deepEqual(eventNamesWithoutSessionStart(secondPayload.events), [
      ONBOARDING_EVENTS.STEP_VIEW,
    ]);
  } finally {
    firstClient.shutdown();
    secondClient.shutdown();
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
});

test('createOnboardingTracker() applies shared onboarding defaults without affecting payload completeness', async () => {
  await withMockedGlobals(async (calls) => {
    const client = init({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.analyticscli.com',
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
      dedupeOnboardingStepViewsPerSession: true,
    });

    try {
      const onboarding = client.createOnboardingTracker({
        appVersion: '2.0.0',
        isNewUser: true,
        onboardingFlowId: 'onboarding_v5',
        onboardingFlowVersion: '5.0.0',
        stepCount: 4,
        surveyKey: 'onboarding_v5',
        experimentVariant: 'B',
      });
      const welcomeStep = onboarding.step('welcome', 0);

      onboarding.start();
      welcomeStep.view();
      welcomeStep.view();
      welcomeStep.complete();
      welcomeStep.surveyResponse({
        questionKey: 'primary_goal',
        answerType: 'single_choice',
        responseKey: 'growth',
      });
      onboarding.complete();

      await client.flush();

      assert.equal(calls.length, 1);
      const payload = JSON.parse(String(calls[0]?.init?.body)) as {
        events: Array<{ eventName: string; properties?: Record<string, unknown> }>;
      };
      const trackedEvents = withoutSessionStart(payload.events);

      assert.deepEqual(
        trackedEvents.map((event) => event.eventName),
        [
          ONBOARDING_EVENTS.START,
          ONBOARDING_EVENTS.STEP_VIEW,
          ONBOARDING_EVENTS.STEP_COMPLETE,
          ONBOARDING_SURVEY_EVENTS.RESPONSE,
          ONBOARDING_EVENTS.COMPLETE,
        ],
      );

      const startEvent = trackedEvents[0];
      assert.equal(startEvent?.properties?.onboardingFlowId, 'onboarding_v5');
      assert.equal(startEvent?.properties?.onboardingFlowVersion, '5.0.0');
      assert.equal(startEvent?.properties?.isNewUser, true);
      assert.equal(startEvent?.properties?.stepCount, 4);
      assert.equal(startEvent?.properties?.experimentVariant, 'B');

      const surveyEvent = trackedEvents[3];
      assert.equal(surveyEvent?.properties?.surveyKey, 'onboarding_v5');
      assert.equal(surveyEvent?.properties?.questionKey, 'primary_goal');
      assert.equal(surveyEvent?.properties?.stepKey, 'welcome');
      assert.equal(surveyEvent?.properties?.stepIndex, 0);
      assert.equal(surveyEvent?.properties?.experimentVariant, 'B');
    } finally {
      client.shutdown();
    }
  });
});

test('trackPaywallEvent() drops events missing required source property', async () => {
  await withMockedGlobals(async (calls) => {
    const client = init({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.analyticscli.com',
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
    });

    try {
      client.trackPaywallEvent(PAYWALL_EVENTS.SHOWN, {
        paywallId: 'default_paywall',
      } as any);

      await client.flush();

      assert.equal(calls.length, 1);
      const payload = JSON.parse(String(calls[0]?.init?.body)) as {
        events: Array<{ eventName: string }>;
      };
      assert.deepEqual(eventNamesWithoutSessionStart(payload.events), []);
    } finally {
      client.shutdown();
    }
  });
});

test('trackPaywallEvent() ignores paywallEntryId in direct calls', async () => {
  await withMockedGlobals(async (calls) => {
    const client = init({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.analyticscli.com',
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
    });

    try {
      client.trackPaywallEvent(PURCHASE_EVENTS.SUCCESS, {
        source: 'onboarding',
        paywallId: 'default_paywall',
        paywallEntryId: 'manual_entry',
        packageId: 'annual',
      });

      await client.flush();

      assert.equal(calls.length, 1);
      const payload = JSON.parse(String(calls[0]?.init?.body)) as {
        events: Array<{ eventName: string; properties?: Record<string, unknown> }>;
      };
      const purchaseSuccessEvent = payload.events.find((event) => event.eventName === PURCHASE_EVENTS.SUCCESS);
      assert.ok(purchaseSuccessEvent);
      assert.equal(purchaseSuccessEvent.properties?.paywallEntryId, undefined);
    } finally {
      client.shutdown();
    }
  });
});

test('strict-only mode ignores cookieDomain and does not persist ids via cookies', async () => {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  const originalDocument = (globalThis as typeof globalThis & { document?: unknown }).document;
  const originalLocation = (globalThis as typeof globalThis & { location?: unknown }).location;
  const originalLocalStorage = globalThis.localStorage;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return new Response(JSON.stringify({ accepted: true }), { status: 202 });
  }) as typeof globalThis.fetch;

  Object.defineProperty(globalThis, 'document', {
    value: createCookieDocument(),
    configurable: true,
    writable: true,
  });

  Object.defineProperty(globalThis, 'location', {
    value: { protocol: 'https:' },
    configurable: true,
    writable: true,
  });

  Reflect.deleteProperty(globalThis, 'localStorage');

  const client = init({
    apiKey: 'pi_live_test',
    endpoint: 'https://collector.analyticscli.com',
    cookieDomain: '.analyticscli.com',
    batchSize: 20,
    flushIntervalMs: 60_000,
    maxRetries: 0,
  });

  try {
    client.track('onboarding:start');
    await client.flush();

    assert.equal(calls.length, 1);
    const cookie = String((globalThis as typeof globalThis & { document: { cookie: string } }).document.cookie);
    assert.equal(cookie, '');
  } finally {
    client.shutdown();
    globalThis.fetch = originalFetch;

    if (originalDocument) {
      Object.defineProperty(globalThis, 'document', {
        value: originalDocument,
        configurable: true,
        writable: true,
      });
    } else {
      Reflect.deleteProperty(globalThis, 'document');
    }

    if (originalLocation) {
      Object.defineProperty(globalThis, 'location', {
        value: originalLocation,
        configurable: true,
        writable: true,
      });
    } else {
      Reflect.deleteProperty(globalThis, 'location');
    }

    if (originalLocalStorage) {
      Object.defineProperty(globalThis, 'localStorage', {
        value: originalLocalStorage,
        configurable: true,
        writable: true,
      });
    }
  }
});

test('does not write cookies by default when cookie storage is not enabled', async () => {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  const originalDocument = (globalThis as typeof globalThis & { document?: unknown }).document;
  const originalLocation = (globalThis as typeof globalThis & { location?: unknown }).location;
  const originalLocalStorage = globalThis.localStorage;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return new Response(JSON.stringify({ accepted: true }), { status: 202 });
  }) as typeof globalThis.fetch;

  const cookieDocument = createCookieDocument();
  Object.defineProperty(globalThis, 'document', {
    value: cookieDocument,
    configurable: true,
    writable: true,
  });

  Object.defineProperty(globalThis, 'location', {
    value: { protocol: 'https:' },
    configurable: true,
    writable: true,
  });

  Reflect.deleteProperty(globalThis, 'localStorage');

  const client = init({
    apiKey: 'pi_live_test',
    endpoint: 'https://collector.analyticscli.com',
    batchSize: 20,
    flushIntervalMs: 60_000,
    maxRetries: 0,
  });

  try {
    client.track('onboarding:start');
    await client.flush();

    assert.equal(calls.length, 1);
    assert.equal(cookieDocument.cookie, '');
  } finally {
    client.shutdown();
    globalThis.fetch = originalFetch;

    if (originalDocument) {
      Object.defineProperty(globalThis, 'document', {
        value: originalDocument,
        configurable: true,
        writable: true,
      });
    } else {
      Reflect.deleteProperty(globalThis, 'document');
    }

    if (originalLocation) {
      Object.defineProperty(globalThis, 'location', {
        value: originalLocation,
        configurable: true,
        writable: true,
      });
    } else {
      Reflect.deleteProperty(globalThis, 'location');
    }

    if (originalLocalStorage) {
      Object.defineProperty(globalThis, 'localStorage', {
        value: originalLocalStorage,
        configurable: true,
        writable: true,
      });
    }
  }
});

test('setContext() only emits allowed context fields', async () => {
  await withMockedGlobals(async (calls) => {
    const client = init({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.analyticscli.com',
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
    });

    try {
      client.setContext({
        osName: 'iOS',
        osVersion: '18.2',
      });
      client.setContext(
        {
          deviceModel: 'iPhone16,2',
          locale: 'en-US',
        } as unknown as Parameters<typeof client.setContext>[0],
      );
      client.track('app_open');
      await client.flush();

      const payload = JSON.parse(String(calls[0]?.init?.body)) as {
        events: Array<{
          eventName: string;
          osName?: string;
          osVersion?: string;
          deviceModel?: string;
          locale?: string;
          country?: string;
        }>;
      };
      const event = payload.events.find((entry) => entry.eventName === 'app_open');

      assert.equal(event?.osName, 'iOS');
      assert.equal(event?.osVersion, '18.2');
      assert.equal(event?.country, undefined);
      assert.equal(event?.deviceModel, undefined);
      assert.equal(event?.locale, undefined);
    } finally {
      client.shutdown();
    }
  });
});

test('trackOnboardingSurveyResponse() emits anonymized survey response payloads', async () => {
  await withMockedGlobals(async (calls) => {
    const client = init({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.analyticscli.com',
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
    });

    try {
      client.trackOnboardingSurveyResponse({
        surveyKey: 'onboarding-v4',
        questionKey: 'motivation',
        answerType: 'single_choice',
        responseKey: 'growth',
        isNewUser: true,
        onboardingFlowId: 'onboarding_v4',
        properties: {
          email: 'should_be_filtered@example.com',
          source: 'welcome_screen',
        },
      });
      client.trackOnboardingSurveyResponse({
        surveyKey: 'onboarding-v4',
        questionKey: 'use_cases',
        answerType: 'multiple_choice',
        responseKeys: ['pricing', 'analytics'],
      });
      client.trackOnboardingSurveyResponse({
        surveyKey: 'onboarding-v4',
        questionKey: 'team_size',
        answerType: 'numeric',
        responseNumber: 27,
      });
      client.trackOnboardingSurveyResponse({
        surveyKey: 'onboarding-v4',
        questionKey: 'feedback',
        answerType: 'text',
        responseText: 'This should never be sent as raw text',
      });

      await client.flush();

      assert.equal(calls.length, 1);
      const payload = JSON.parse(String(calls[0]?.init?.body)) as {
        events: Array<{ eventName: string; properties?: Record<string, unknown> }>;
      };
      const responseEvents = withoutSessionStart(payload.events);

      assert.ok(responseEvents.length >= 5);
      assert.ok(responseEvents.every((event) => event.eventName === ONBOARDING_SURVEY_EVENTS.RESPONSE));

      const first = responseEvents[0]?.properties ?? {};
      assert.equal(first.surveyKey, 'onboarding-v4');
      assert.equal(first.questionKey, 'motivation');
      assert.equal(first.responseKey, 'growth');
      assert.equal(first.isNewUser, true);
      assert.equal(first.source, 'welcome_screen');
      assert.equal('email' in first, false);

      const numeric = responseEvents.find((event) => event.properties?.questionKey === 'team_size');
      assert.equal(numeric?.properties?.responseKey, '21_30');

      const text = responseEvents.find((event) => event.properties?.questionKey === 'feedback');
      assert.equal(text?.properties?.responseKey, 'text_len:31_80');
      assert.equal('responseText' in (text?.properties ?? {}), false);
    } finally {
      client.shutdown();
    }
  });
});

test('initAsync() ignores persisted ids from async storage adapters in strict-only mode', async () => {
  await withMockedGlobals(async (calls) => {
    const now = Date.now();
    const backingStore = new Map<string, string>([
      ['pi_device_id', 'persisted-device-id'],
      ['pi_session_id', 'persisted-session-id'],
      ['pi_last_seen', String(now)],
      ['pi_session_event_seq:persisted-session-id', '41'],
    ]);

    const client = await initAsync({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.analyticscli.com',
      storage: {
        getItem: async (key: string) => backingStore.get(key) ?? null,
        setItem: async (key: string, value: string) => {
          backingStore.set(key, value);
        },
      },
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
    });

    try {
      client.track('app_open');
      await client.flush();

      assert.equal(calls.length, 1);
      const payload = JSON.parse(String(calls[0]?.init?.body)) as {
        events: Array<{ eventName: string; anonId: string; sessionId: string; properties?: Record<string, unknown> }>;
      };
      const event = payload.events.find((entry) => entry.eventName === 'app_open');

      assert.notEqual(event?.anonId, 'persisted-device-id');
      assert.notEqual(event?.sessionId, 'persisted-session-id');
      assert.equal(event?.properties?.sessionEventIndex, 2);
    } finally {
      client.shutdown();
    }
  });
});

test('init() does not defer identity/session binding to async storage in strict-only mode', async () => {
  await withMockedGlobals(async (calls) => {
    const now = Date.now();
    const backingStore = new Map<string, string>([
      ['pi_device_id', 'persisted-device-id'],
      ['pi_session_id', 'persisted-session-id'],
      ['pi_last_seen', String(now)],
      ['pi_session_event_seq:persisted-session-id', '41'],
    ]);

    const client = init({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.analyticscli.com',
      storage: {
        getItem: async (key: string) => backingStore.get(key) ?? null,
        setItem: async (key: string, value: string) => {
          backingStore.set(key, value);
        },
      },
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
    });

    try {
      // Event is tracked before hydration settles.
      client.track('app_open');
      await client.flush();

      assert.equal(calls.length, 1);
      const payload = JSON.parse(String(calls[0]?.init?.body)) as {
        events: Array<{ eventName: string; anonId: string; sessionId: string; properties?: Record<string, unknown> }>;
      };
      const event = payload.events.find((entry) => entry.eventName === 'app_open');

      assert.notEqual(event?.anonId, 'persisted-device-id');
      assert.notEqual(event?.sessionId, 'persisted-session-id');
      assert.equal(event?.properties?.sessionEventIndex, 2);
    } finally {
      client.shutdown();
    }
  });
});

test('ignores AsyncStorage-style storage objects in strict-only mode', async () => {
  await withMockedGlobals(async (calls) => {
    const now = Date.now();
    const backingStore = new Map<string, string>([
      ['pi_device_id', 'persisted-device-id'],
      ['pi_session_id', 'persisted-session-id'],
      ['pi_last_seen', String(now)],
      ['pi_session_event_seq:persisted-session-id', '41'],
    ]);

    const asyncStorageLike = {
      getItem: async (
        key: string,
        callback?: (error?: Error | null, value?: string | null) => void,
      ): Promise<string | null> => {
        const value = backingStore.get(key) ?? null;
        callback?.(null, value);
        return value;
      },
      setItem: async (
        key: string,
        value: string,
        callback?: (error?: Error | null) => void,
      ): Promise<void> => {
        backingStore.set(key, value);
        callback?.(null);
      },
      removeItem: async (key: string, callback?: (error?: Error | null) => void): Promise<void> => {
        backingStore.delete(key);
        callback?.(null);
      },
    };

    const client = init({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.analyticscli.com',
      storage: asyncStorageLike,
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
    });

    try {
      client.track('app_open');
      await client.flush();

      assert.equal(calls.length, 1);
      const payload = JSON.parse(String(calls[0]?.init?.body)) as {
        events: Array<{ eventName: string; anonId: string; sessionId: string; properties?: Record<string, unknown> }>;
      };
      const event = payload.events.find((entry) => entry.eventName === 'app_open');

      assert.notEqual(event?.anonId, 'persisted-device-id');
      assert.notEqual(event?.sessionId, 'persisted-session-id');
      assert.equal(event?.properties?.sessionEventIndex, 2);
    } finally {
      client.shutdown();
    }
  });
});

test('storage adapter errors never crash the host app', async () => {
  await withMockedGlobals(async (calls) => {
    const client = init({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.analyticscli.com',
      storage: {
        getItem: () => {
          throw new Error('read failed');
        },
        setItem: () => {
          throw new Error('write failed');
        },
      },
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
    });

    try {
      client.track('app_open');
      await client.flush();
      assert.equal(calls.length, 1);
    } finally {
      client.shutdown();
    }
  });
});

test('invalid event names are dropped without throwing', async () => {
  await withMockedGlobals(async (calls) => {
    const client = init({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.analyticscli.com',
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
    });

    try {
      client.track('invalid event');
      await client.flush();
      assert.equal(calls.length, 0);
    } finally {
      client.shutdown();
    }
  });
});
