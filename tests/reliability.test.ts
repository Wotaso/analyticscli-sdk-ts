import assert from 'node:assert/strict';
import test from 'node:test';
import { init } from '../src/index.js';
import type {
  AnalyticsDropDiagnostic,
  AnalyticsIngestError,
} from '../src/index.js';

type FetchCall = {
  input: RequestInfo | URL;
  init?: RequestInit;
};

const acceptedResponse = (): Response =>
  new Response(JSON.stringify({ accepted: true }), {
    status: 202,
    headers: { 'content-type': 'application/json' },
  });

const readEventNames = (call: FetchCall | undefined): string[] => {
  const payload = JSON.parse(String(call?.init?.body)) as {
    events: Array<{ eventName: string }>;
  };
  return payload.events.map((event) => event.eventName);
};

test('maxQueueSize evicts oldest queued events and reports payload-free diagnostics', async () => {
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  const dropped: AnalyticsDropDiagnostic[] = [];
  let releaseFirstRequest: (() => void) | undefined;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    if (calls.length === 1) {
      return new Promise<Response>((resolve) => {
        releaseFirstRequest = () => resolve(acceptedResponse());
      });
    }
    return acceptedResponse();
  }) as typeof globalThis.fetch;

  const client = init({
    apiKey: 'pi_live_queue_limit',
    batchSize: 2,
    maxQueueSize: 3,
    flushIntervalMs: 60_000,
    maxRetries: 0,
    onEventsDropped: (diagnostic) => dropped.push(diagnostic),
  });

  try {
    client.track('initial_trigger');
    assert.equal(calls.length, 1);

    client.track('queued_1');
    client.track('queued_2');
    client.track('queued_3');
    client.track('queued_4');
    client.track('queued_5');

    assert.deepEqual(
      dropped.map((diagnostic) => diagnostic.reason),
      ['queue_overflow', 'queue_overflow'],
    );
    assert.deepEqual(
      dropped.flatMap((diagnostic) => diagnostic.eventNames),
      ['queued_1', 'queued_2'],
    );
    assert.ok(dropped.every((diagnostic) => diagnostic.maxQueueSize === 3));
    assert.ok(
      dropped.every(
        (diagnostic) =>
          !Object.hasOwn(diagnostic, 'properties') &&
          !Object.hasOwn(diagnostic, 'eventIds'),
      ),
    );

    releaseFirstRequest?.();
    const result = await client.flushAll({ timeoutMs: 1000 });

    assert.deepEqual(result, {
      completed: true,
      timedOut: false,
      reason: 'drained',
      remainingEvents: 0,
    });
    const deliveredNames = calls.flatMap(readEventNames);
    assert.ok(deliveredNames.includes('session_start'));
    assert.ok(deliveredNames.includes('initial_trigger'));
    assert.ok(deliveredNames.includes('queued_3'));
    assert.ok(deliveredNames.includes('queued_4'));
    assert.ok(deliveredNames.includes('queued_5'));
    assert.ok(!deliveredNames.includes('queued_1'));
    assert.ok(!deliveredNames.includes('queued_2'));
  } finally {
    releaseFirstRequest?.();
    client.shutdown();
    globalThis.fetch = originalFetch;
  }
});

test('retryable failures keep the batch queued while permanent drops stay opt-in observable', async () => {
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  const errors: AnalyticsIngestError[] = [];
  const dropped: AnalyticsDropDiagnostic[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    if (calls.length === 1) {
      return new Response(
        JSON.stringify({ error: { code: 'TEMPORARILY_UNAVAILABLE' } }),
        { status: 503, headers: { 'content-type': 'application/json' } },
      );
    }
    return acceptedResponse();
  }) as typeof globalThis.fetch;

  const client = init({
    apiKey: 'pi_live_retry',
    batchSize: 20,
    flushIntervalMs: 60_000,
    maxRetries: 0,
    onIngestError: (error) => errors.push(error),
    onEventsDropped: (diagnostic) => dropped.push(diagnostic),
  });

  try {
    client.track('checkout_started');
    await client.flush();
    await client.flush();

    assert.equal(calls.length, 2);
    assert.deepEqual(readEventNames(calls[0]), readEventNames(calls[1]));
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.retryable, true);
    assert.equal(errors[0]?.queueSize, 2);
    assert.equal(dropped.length, 0);
  } finally {
    client.shutdown();
    globalThis.fetch = originalFetch;
  }
});

test('flushAll stops after a retryable delivery failure instead of hot-looping', async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;

  globalThis.fetch = (async () => {
    requestCount += 1;
    return new Response(
      JSON.stringify({ error: { code: 'TEMPORARILY_UNAVAILABLE' } }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof globalThis.fetch;

  const client = init({
    apiKey: 'pi_live_no_hot_loop',
    batchSize: 20,
    flushIntervalMs: 60_000,
    maxRetries: 0,
  });

  try {
    client.track('queued_for_retry');
    const result = await client.flushAll({ timeoutMs: 1000 });

    assert.equal(requestCount, 1);
    assert.deepEqual(result, {
      completed: false,
      timedOut: false,
      reason: 'retryable_failure',
      remainingEvents: 2,
    });
  } finally {
    client.shutdown();
    globalThis.fetch = originalFetch;
  }
});

test('maxQueueSize also bounds events waiting for async identity hydration', async () => {
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  const dropped: AnalyticsDropDiagnostic[] = [];
  let releaseStorage: (() => void) | undefined;
  const storageGate = new Promise<void>((resolve) => {
    releaseStorage = resolve;
  });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return acceptedResponse();
  }) as typeof globalThis.fetch;

  const client = init({
    apiKey: 'pi_live_hydration_limit',
    identityTrackingMode: 'always_on',
    storage: {
      getItem: async () => {
        await storageGate;
        return null;
      },
      setItem: async () => undefined,
      removeItem: async () => undefined,
    },
    batchSize: 20,
    maxQueueSize: 2,
    flushIntervalMs: 60_000,
    maxRetries: 0,
    onEventsDropped: (diagnostic) => dropped.push(diagnostic),
  });

  try {
    const deferredProperties = {
      nested: {
        api_key: 'must-not-remain-in-the-deferred-closure',
        plan: 'starter',
      },
    };
    client.track('deferred_1');
    client.track('deferred_2');
    client.track('deferred_3', deferredProperties);
    deferredProperties.nested.plan = 'mutated_after_track';

    assert.deepEqual(
      dropped.flatMap((diagnostic) => diagnostic.eventNames),
      ['session_start', 'deferred_1'],
    );

    releaseStorage?.();
    await client.ready();
    const result = await client.flushAll({ timeoutMs: 1000 });

    assert.equal(result.completed, true);
    assert.deepEqual(calls.flatMap(readEventNames), ['deferred_2', 'deferred_3']);
    const delivered = calls
      .flatMap((call) => {
        const payload = JSON.parse(String(call.init?.body)) as {
          events: Array<{ eventName: string; properties: Record<string, unknown> }>;
        };
        return payload.events;
      })
      .find((event) => event.eventName === 'deferred_3');
    assert.deepEqual(delivered?.properties.nested, {
      plan: 'starter',
    });
  } finally {
    releaseStorage?.();
    client.shutdown();
    globalThis.fetch = originalFetch;
  }
});

test('serialization and oversize poison events are isolated from valid events', async () => {
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  const dropped: AnalyticsDropDiagnostic[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return acceptedResponse();
  }) as typeof globalThis.fetch;

  const client = init({
    apiKey: 'pi_live_payload_safety',
    batchSize: 20,
    flushIntervalMs: 60_000,
    maxRetries: 0,
    onEventsDropped: (diagnostic) => dropped.push(diagnostic),
  });

  try {
    client.track('bad_unserializable', { value: BigInt(1) });
    client.track('bad_oversize', { blob: 'x'.repeat(140 * 1024) });
    client.track('valid_after_poison', { source: 'test' });

    const result = await client.flushAll({ timeoutMs: 1000 });

    assert.equal(result.completed, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(readEventNames(calls[0]), ['session_start', 'valid_after_poison']);
    assert.deepEqual(
      dropped.map((diagnostic) => [diagnostic.reason, diagnostic.eventNames]),
      [
        ['serialization_error', ['bad_unserializable']],
        ['payload_too_large', ['bad_oversize']],
      ],
    );
  } finally {
    client.shutdown();
    globalThis.fetch = originalFetch;
  }
});

test('flushAll splits valid events across the collector byte limit and drains every batch', async () => {
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return acceptedResponse();
  }) as typeof globalThis.fetch;

  const client = init({
    apiKey: 'pi_live_batch_split',
    batchSize: 20,
    flushIntervalMs: 60_000,
    maxRetries: 0,
  });

  try {
    const multibytePayload = 'ü'.repeat(40_000);
    client.track('large_valid_1', { blob: multibytePayload });
    client.track('large_valid_2', { blob: multibytePayload });
    client.track('large_valid_3', { blob: multibytePayload });

    const result = await client.flushAll({ timeoutMs: 1000 });

    assert.deepEqual(result, {
      completed: true,
      timedOut: false,
      reason: 'drained',
      remainingEvents: 0,
    });
    assert.ok(calls.length >= 3);
    assert.deepEqual(calls.flatMap(readEventNames), [
      'session_start',
      'large_valid_1',
      'large_valid_2',
      'large_valid_3',
    ]);
    for (const call of calls) {
      assert.ok(new TextEncoder().encode(String(call.init?.body)).byteLength <= 128 * 1024);
    }
  } finally {
    client.shutdown();
    globalThis.fetch = originalFetch;
  }
});

test('shutdownAsync aborts a hanging request at timeout and reports remaining events', async () => {
  const originalFetch = globalThis.fetch;
  let requestWasAborted = false;

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        return;
      }
      signal.addEventListener(
        'abort',
        () => {
          requestWasAborted = true;
          reject(new Error('request aborted'));
        },
        { once: true },
      );
    });
  }) as typeof globalThis.fetch;

  const client = init({
    apiKey: 'pi_live_shutdown_timeout',
    batchSize: 20,
    flushIntervalMs: 60_000,
    maxRetries: 0,
  });

  try {
    client.track('pending_before_shutdown');
    const result = await client.shutdownAsync({ timeoutMs: 25 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(result.completed, false);
    assert.equal(result.timedOut, true);
    assert.equal(result.reason, 'timed_out');
    assert.equal(result.remainingEvents, 2);
    assert.equal(requestWasAborted, true);
  } finally {
    client.shutdown();
    globalThis.fetch = originalFetch;
  }
});

test('flush timeout accounting includes events waiting for async storage hydration', async () => {
  const originalFetch = globalThis.fetch;
  let releaseStorage: (() => void) | undefined;
  const storageGate = new Promise<void>((resolve) => {
    releaseStorage = resolve;
  });

  globalThis.fetch = (async () => acceptedResponse()) as typeof globalThis.fetch;

  const client = init({
    apiKey: 'pi_live_hydration_timeout',
    identityTrackingMode: 'always_on',
    storage: {
      getItem: async () => {
        await storageGate;
        return null;
      },
      setItem: async () => undefined,
    },
    flushIntervalMs: 60_000,
    maxRetries: 0,
  });

  try {
    client.track('waiting_for_hydration');
    const result = await client.shutdownAsync({ timeoutMs: 25 });

    assert.deepEqual(result, {
      completed: false,
      timedOut: true,
      reason: 'timed_out',
      remainingEvents: 2,
    });

    releaseStorage?.();
    await client.ready();
    await client.flush();
  } finally {
    releaseStorage?.();
    client.shutdown();
    globalThis.fetch = originalFetch;
  }
});

test('opting out aborts an in-flight request without requeueing the revoked batch', async () => {
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  let firstRequestWasAborted = false;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    if (calls.length > 1) {
      return acceptedResponse();
    }

    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        'abort',
        () => {
          firstRequestWasAborted = true;
          reject(new Error('request aborted after opt-out'));
        },
        { once: true },
      );
    });
  }) as typeof globalThis.fetch;

  const client = init({
    apiKey: 'pi_live_opt_out_abort',
    batchSize: 2,
    flushIntervalMs: 60_000,
    maxRetries: 0,
  });

  try {
    client.track('before_opt_out');
    assert.equal(calls.length, 1);

    client.optOut();
    await client.flush();
    assert.equal(firstRequestWasAborted, true);

    client.optIn();
    client.track('after_opt_in');
    await client.flush();

    assert.equal(calls.length, 2);
    assert.deepEqual(readEventNames(calls[1]), ['after_opt_in']);
  } finally {
    client.shutdown();
    globalThis.fetch = originalFetch;
  }
});
