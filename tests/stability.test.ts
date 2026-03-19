import assert from 'node:assert/strict';
import test from 'node:test';
import { init, ONBOARDING_EVENTS, PAYWALL_EVENTS } from '../src/index.js';

test('public SDK API remains no-throw under transient network failures', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  let failNextRequest = true;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    if (failNextRequest) {
      failNextRequest = false;
      throw new Error('network unavailable');
    }

    return new Response(JSON.stringify({ accepted: true }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;

  const client = init({
    apiKey: 'pi_live_test',
    endpoint: 'https://collector.analyticscli.com',
    batchSize: 50,
    flushIntervalMs: 60_000,
    maxRetries: 0,
  });

  try {
    assert.doesNotThrow(() => client.identify('user-1', { plan: 'pro' }));
    assert.doesNotThrow(() => client.setUser('user-2', { plan: 'enterprise' }));
    assert.doesNotThrow(() => client.setUser(null));
    assert.doesNotThrow(() => client.clearUser());
    assert.doesNotThrow(() => client.track('app_open'));
    assert.doesNotThrow(() => client.screen('home'));
    assert.doesNotThrow(() => client.page('settings'));
    assert.doesNotThrow(() => client.feedback('great', 5));
    assert.doesNotThrow(() => client.trackOnboardingEvent(ONBOARDING_EVENTS.START));
    assert.doesNotThrow(() =>
      client.trackPaywallEvent(PAYWALL_EVENTS.SHOWN, {
        source: 'onboarding',
        paywallId: 'default',
      }),
    );
    assert.doesNotThrow(() => {
      const paywall = client.createPaywallTracker({
        source: 'onboarding',
        paywallId: 'default',
      });
      paywall.shown();
      paywall.purchaseSuccess({ packageId: 'annual' });
    });
    assert.doesNotThrow(() =>
      client.trackOnboardingSurveyResponse({
        surveyKey: 'onboarding',
        questionKey: 'goal',
        answerType: 'single_choice',
        responseKey: 'growth',
      }),
    );

    await assert.doesNotReject(client.flush());
    await assert.doesNotReject(client.flush());

    assert.equal(calls.length, 2);
    const secondPayload = JSON.parse(String(calls[1]?.init?.body)) as {
      events: Array<{ eventName: string }>;
    };
    // strict-only mode does not emit identity linkage events from identify()/setUser(...).
    assert.ok(secondPayload.events.length >= 9);
  } finally {
    client.shutdown();
    globalThis.fetch = originalFetch;
  }
});

test('ready() resolves even when async storage adapters fail', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({ accepted: true }), { status: 202 });
  }) as typeof globalThis.fetch;

  const client = init({
    apiKey: 'pi_live_test',
    endpoint: 'https://collector.analyticscli.com',
    storage: {
      getItem: async () => {
        throw new Error('storage read failed');
      },
      setItem: async () => {
        throw new Error('storage write failed');
      },
    },
    flushIntervalMs: 60_000,
    maxRetries: 0,
  });

  try {
    await assert.doesNotReject(client.ready());
    assert.doesNotThrow(() => client.track('app_open'));
    await assert.doesNotReject(client.flush());
  } finally {
    client.shutdown();
    globalThis.fetch = originalFetch;
  }
});

test('init() accepts nullable option values without manual type casts', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return new Response(JSON.stringify({ accepted: true }), { status: 202 });
  }) as typeof globalThis.fetch;

  const client = init({
    apiKey: null,
    endpoint: null,
    flushIntervalMs: 60_000,
    maxRetries: 0,
  });

  try {
    assert.doesNotThrow(() => client.track('app_open'));
    await assert.doesNotReject(client.flush());
    assert.equal(calls.length, 0);
  } finally {
    client.shutdown();
    globalThis.fetch = originalFetch;
  }
});

test('init() tolerates missing options object from untyped JS call sites', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return new Response(JSON.stringify({ accepted: true }), { status: 202 });
  }) as typeof globalThis.fetch;

  const client = init(undefined);

  try {
    assert.doesNotThrow(() => client.track('app_open'));
    await assert.doesNotReject(client.flush());
    assert.equal(calls.length, 0);
  } finally {
    client.shutdown();
    globalThis.fetch = originalFetch;
  }
});
