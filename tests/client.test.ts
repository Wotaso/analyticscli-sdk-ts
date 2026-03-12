import assert from 'node:assert/strict';
import test from 'node:test';
import {
  init,
  initAsync,
  initFromEnv,
  ONBOARDING_EVENTS,
  ONBOARDING_SURVEY_EVENTS,
  PAYWALL_EVENTS,
  PURCHASE_EVENTS,
} from '../src/index.js';

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
      endpoint: 'https://collector.prodinfos.com',
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
      assert.equal(String(calls[0]?.input), 'https://collector.prodinfos.com/v1/collect');

      const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
      assert.equal(headers['x-api-key'], 'pi_live_test');

      const payload = JSON.parse(String(calls[0]?.init?.body)) as {
        events: Array<{ eventName: string; properties?: Record<string, unknown> }>;
      };

      assert.equal(payload.events[0]?.eventName, 'onboarding:start');
      assert.equal(typeof payload.events[0]?.properties?.runtimeEnv, 'string');
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
      assert.equal(String(calls[0]?.input), 'https://collector.prodinfos.com/v1/collect');
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
      assert.equal(payload.events[0]?.eventName, 'onboarding:start');
    } finally {
      client.shutdown();
    }
  });
});

test('uses a custom collector endpoint override when provided', async () => {
  await withMockedGlobals(async (calls) => {
    const client = init({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.staging.prodinfos.com/',
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
    });

    try {
      client.track('onboarding:start');
      await client.flush();

      assert.equal(calls.length, 1);
      assert.equal(String(calls[0]?.input), 'https://collector.staging.prodinfos.com/v1/collect');
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
        events: Array<{ platform?: string }>;
      };
      assert.equal(payload.events[0]?.platform, 'mac');
    } finally {
      client.shutdown();
    }
  });
});

test('initFromEnv() resolves credentials from default env keys', async () => {
  await withMockedGlobals(async (calls) => {
    const client = initFromEnv({
      env: {
        PRODINFOS_WRITE_KEY: 'pi_live_test',
      },
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
    });

    try {
      client.track('onboarding:start');
      await client.flush();

      assert.equal(calls.length, 1);
      assert.equal(String(calls[0]?.input), 'https://collector.prodinfos.com/v1/collect');
      const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
      assert.equal(headers['x-api-key'], 'pi_live_test');
    } finally {
      client.shutdown();
    }
  });
});

test('initFromEnv() works with api key only', async () => {
  await withMockedGlobals(async (calls) => {
    const client = initFromEnv({
      env: {
        PRODINFOS_WRITE_KEY: 'pi_live_test',
      },
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
      assert.equal(payload.events[0]?.eventName, 'onboarding:start');
    } finally {
      client.shutdown();
    }
  });
});

test('initFromEnv() supports explicit apiKey override', async () => {
  await withMockedGlobals(async (calls) => {
    const client = initFromEnv({
      env: {
        PRODINFOS_WRITE_KEY: 'pi_live_wrong',
      },
      apiKey: 'pi_live_test',
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
    });

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

test('initFromEnv() in noop mode returns a safe no-op client when config is missing', async () => {
  await withMockedGlobals(async (calls) => {
    let missingConfig: {
      missingApiKey: boolean;
      searchedApiKeyEnvKeys: string[];
    } | null = null;

    const client = initFromEnv({
      env: {},
      onMissingConfig: (details) => {
        missingConfig = details;
      },
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
    });

    try {
      client.track('onboarding:start');
      client.optIn();
      client.track('onboarding:complete');
      await client.flush();

      assert.equal(calls.length, 0);
      assert.equal(missingConfig?.missingApiKey, true);
      assert.deepEqual(missingConfig?.searchedApiKeyEnvKeys, ['PRODINFOS_WRITE_KEY', 'NEXT_PUBLIC_PRODINFOS_WRITE_KEY', 'EXPO_PUBLIC_PRODINFOS_WRITE_KEY', 'VITE_PRODINFOS_WRITE_KEY']);
    } finally {
      client.shutdown();
    }
  });
});

test('initFromEnv() throws when missingConfigMode is throw', () => {
  assert.throws(
    () =>
      initFromEnv({
        env: {},
        missingConfigMode: 'throw',
      }),
    /Missing required configuration: apiKey/,
  );
});

test('init() without credentials is a safe no-op client', async () => {
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
    } finally {
      client.shutdown();
    }
  });
});

test('optOut() disables enqueue and prevents network calls', async () => {
  await withMockedGlobals(async (calls) => {
    const client = init({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.prodinfos.com',
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

test('screen() and feedback() use canonical event names', async () => {
  await withMockedGlobals(async (calls) => {
    const client = init({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.prodinfos.com',
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

      const eventNames = payload.events.map((event) => event.eventName);
      assert.deepEqual(eventNames, ['screen:welcome', 'feedback_submitted']);
    } finally {
      client.shutdown();
    }
  });
});

test('typed onboarding/paywall wrappers emit canonical event names', async () => {
  await withMockedGlobals(async (calls) => {
    const client = init({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.prodinfos.com',
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
    });

    try {
      client.trackOnboardingEvent(ONBOARDING_EVENTS.START, {
        isNewUser: true,
        onboardingFlowId: 'onboarding_v4',
        stepIndex: 0,
        stepCount: 5,
      });
      client.trackPaywallEvent(PAYWALL_EVENTS.SHOWN, {
        source: 'onboarding',
        paywallId: 'default_paywall',
        fromScreen: 'onboarding_paywall',
      });
      client.trackPaywallEvent(PURCHASE_EVENTS.SUCCESS, {
        source: 'onboarding',
        paywallId: 'default_paywall',
        packageId: 'annual',
      });

      await client.flush();

      assert.equal(calls.length, 1);
      const payload = JSON.parse(String(calls[0]?.init?.body)) as {
        events: Array<{ eventName: string; properties?: Record<string, unknown> }>;
      };

      assert.deepEqual(
        payload.events.map((event) => event.eventName),
        [
          ONBOARDING_EVENTS.START,
          PAYWALL_EVENTS.SHOWN,
          PURCHASE_EVENTS.SUCCESS,
        ],
      );
      assert.deepEqual(
        payload.events.map((event) => event.properties?.sessionEventIndex),
        [1, 2, 3],
      );
    } finally {
      client.shutdown();
    }
  });
});

test('createPaywallTracker() applies shared defaults and supports all journey helpers', async () => {
  await withMockedGlobals(async (calls) => {
    const client = init({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.prodinfos.com',
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
    });

    try {
      const paywall = client.createPaywallTracker({
        source: 'onboarding',
        paywallId: 'default_paywall',
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

      assert.deepEqual(
        payload.events.map((event) => event.eventName),
        [
          PAYWALL_EVENTS.SHOWN,
          PURCHASE_EVENTS.STARTED,
          PURCHASE_EVENTS.SUCCESS,
          PAYWALL_EVENTS.SKIP,
        ],
      );

      const first = payload.events[0]?.properties ?? {};
      assert.equal(first.source, 'onboarding');
      assert.equal(first.paywallId, 'default_paywall');
      assert.equal(first.appVersion, '2.1.0');
      assert.equal(first.experimentVariant, 'B');
      assert.equal(first.fromScreen, 'onboarding_offer');

      const override = payload.events[3]?.properties ?? {};
      assert.equal(override.source, 'settings');
      assert.equal(override.paywallId, 'default_paywall');
    } finally {
      client.shutdown();
    }
  });
});

test('setUser() identifies on login and clears user linkage on logout-style calls', async () => {
  await withMockedGlobals(async (calls) => {
    const client = init({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.prodinfos.com',
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
    });

    try {
      client.setUser(' user_123 ', { plan: 'pro' });
      client.track('feature:opened');
      client.setUser('');
      client.track('feature:closed');

      await client.flush();

      assert.equal(calls.length, 1);
      const payload = JSON.parse(String(calls[0]?.init?.body)) as {
        events: Array<{ eventName: string; userId?: string | null; properties?: Record<string, unknown> }>;
      };

      assert.deepEqual(
        payload.events.map((event) => event.eventName),
        ['identify', 'feature:opened', 'feature:closed'],
      );
      assert.equal(payload.events[0]?.userId, 'user_123');
      assert.equal(payload.events[1]?.userId, 'user_123');
      assert.equal(payload.events[2]?.userId, null);
      assert.equal(payload.events[0]?.properties?.plan, 'pro');
    } finally {
      client.shutdown();
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
      endpoint: 'https://collector.prodinfos.com',
      flushIntervalMs: 60_000,
      maxRetries: 0,
    });

    const explicitDebugClient = init({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.prodinfos.com',
      flushIntervalMs: 60_000,
      maxRetries: 0,
      debug: true,
    });

    try {
      defaultClient.trackPaywallEvent(PAYWALL_EVENTS.SHOWN, {} as never);
      explicitDebugClient.trackPaywallEvent(PAYWALL_EVENTS.SHOWN, {} as never);

      assert.equal(debugCalls.length, 1);
      assert.equal(debugCalls[0]?.[0], '[prodinfos-sdk]');
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

test('dedupeOnboardingStepViewsPerSession drops repeated onboarding:step_view events in one session', async () => {
  await withMockedGlobals(async (calls) => {
    const client = init({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.prodinfos.com',
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
      dedupeOnboardingStepViewsPerSession: true,
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

      assert.deepEqual(
        payload.events.map((event) => event.eventName),
        [
          ONBOARDING_EVENTS.STEP_VIEW,
          ONBOARDING_EVENTS.STEP_VIEW,
          PAYWALL_EVENTS.SHOWN,
          PAYWALL_EVENTS.SHOWN,
        ],
      );
      assert.deepEqual(
        payload.events.map((event) => event.properties?.sessionEventIndex),
        [1, 2, 3, 4],
      );
    } finally {
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
      endpoint: 'https://collector.prodinfos.com',
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

    assert.deepEqual(firstPayload.events.map((event) => event.eventName), [
      ONBOARDING_EVENTS.STEP_VIEW,
    ]);
    assert.deepEqual(secondPayload.events.map((event) => event.eventName), [
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
      endpoint: 'https://collector.prodinfos.com',
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

      assert.deepEqual(
        payload.events.map((event) => event.eventName),
        [
          ONBOARDING_EVENTS.START,
          ONBOARDING_EVENTS.STEP_VIEW,
          ONBOARDING_EVENTS.STEP_COMPLETE,
          ONBOARDING_SURVEY_EVENTS.RESPONSE,
          ONBOARDING_EVENTS.COMPLETE,
        ],
      );

      const startEvent = payload.events[0];
      assert.equal(startEvent?.properties?.onboardingFlowId, 'onboarding_v5');
      assert.equal(startEvent?.properties?.onboardingFlowVersion, '5.0.0');
      assert.equal(startEvent?.properties?.isNewUser, true);
      assert.equal(startEvent?.properties?.stepCount, 4);
      assert.equal(startEvent?.properties?.experimentVariant, 'B');

      const surveyEvent = payload.events[3];
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
      endpoint: 'https://collector.prodinfos.com',
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
    });

    try {
      client.trackPaywallEvent(PAYWALL_EVENTS.SHOWN, {
        paywallId: 'default_paywall',
      } as any);

      await client.flush();

      assert.equal(calls.length, 0);
    } finally {
      client.shutdown();
    }
  });
});

test('cookieDomain enables cross-subdomain id persistence via cookies', async () => {
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
    endpoint: 'https://collector.prodinfos.com',
    cookieDomain: '.prodinfos.com',
    batchSize: 20,
    flushIntervalMs: 60_000,
    maxRetries: 0,
  });

  try {
    client.track('onboarding:start');
    await client.flush();

    assert.equal(calls.length, 1);
    const cookie = String((globalThis as typeof globalThis & { document: { cookie: string } }).document.cookie);
    assert.match(cookie, /pi_device_id=/);
    assert.match(cookie, /pi_session_id=/);
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
    endpoint: 'https://collector.prodinfos.com',
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

test('setContext() only emits allowed geo/os context fields', async () => {
  await withMockedGlobals(async (calls) => {
    const client = init({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.prodinfos.com',
      batchSize: 20,
      flushIntervalMs: 60_000,
      maxRetries: 0,
    });

    try {
      client.setContext({
        osName: 'iOS',
        osVersion: '18.2',
        deviceModel: 'iPhone16,2',
        locale: 'en-US',
        country: 'US',
      });
      client.track('app_open');
      await client.flush();

      const payload = JSON.parse(String(calls[0]?.init?.body)) as {
        events: Array<{
          osName?: string;
          osVersion?: string;
          deviceModel?: string;
          locale?: string;
          country?: string;
        }>;
      };
      const event = payload.events[0];

      assert.equal(event?.osName, 'iOS');
      assert.equal(event?.osVersion, '18.2');
      assert.equal(event?.country, 'US');
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
      endpoint: 'https://collector.prodinfos.com',
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

      assert.ok(payload.events.length >= 5);
      assert.ok(payload.events.every((event) => event.eventName === ONBOARDING_SURVEY_EVENTS.RESPONSE));

      const first = payload.events[0]?.properties ?? {};
      assert.equal(first.surveyKey, 'onboarding-v4');
      assert.equal(first.questionKey, 'motivation');
      assert.equal(first.responseKey, 'growth');
      assert.equal(first.isNewUser, true);
      assert.equal(first.source, 'welcome_screen');
      assert.equal('email' in first, false);

      const numeric = payload.events.find((event) => event.properties?.questionKey === 'team_size');
      assert.equal(numeric?.properties?.responseKey, '21_30');

      const text = payload.events.find((event) => event.properties?.questionKey === 'feedback');
      assert.equal(text?.properties?.responseKey, 'text_len:31_80');
      assert.equal('responseText' in (text?.properties ?? {}), false);
    } finally {
      client.shutdown();
    }
  });
});

test('initAsync() hydrates persisted ids from async storage adapters', async () => {
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
      endpoint: 'https://collector.prodinfos.com',
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
        events: Array<{ anonId: string; sessionId: string; properties?: Record<string, unknown> }>;
      };
      const event = payload.events[0];

      assert.equal(event?.anonId, 'persisted-device-id');
      assert.equal(event?.sessionId, 'persisted-session-id');
      assert.equal(event?.properties?.sessionEventIndex, 42);
    } finally {
      client.shutdown();
    }
  });
});

test('init() defers event identity/session binding until async storage hydration completes', async () => {
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
      endpoint: 'https://collector.prodinfos.com',
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
        events: Array<{ anonId: string; sessionId: string; properties?: Record<string, unknown> }>;
      };
      const event = payload.events[0];

      assert.equal(event?.anonId, 'persisted-device-id');
      assert.equal(event?.sessionId, 'persisted-session-id');
      assert.equal(event?.properties?.sessionEventIndex, 42);
    } finally {
      client.shutdown();
    }
  });
});

test('storage adapter errors never crash the host app', async () => {
  await withMockedGlobals(async (calls) => {
    const client = init({
      apiKey: 'pi_live_test',
      endpoint: 'https://collector.prodinfos.com',
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
      endpoint: 'https://collector.prodinfos.com',
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
