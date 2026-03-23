import assert from 'node:assert/strict';
import test from 'node:test';
import { createAnalyticsContext as createBrowserAnalyticsContext } from '../src/browser.js';
import { createAnalyticsContext as createReactNativeAnalyticsContext } from '../src/react-native.js';

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

const withMockedFetch = async (
  fn: (calls: Array<{ input: RequestInfo | URL; init?: RequestInit }>) => Promise<void>,
): Promise<void> => {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return new Response(JSON.stringify({ accepted: true }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;

  try {
    await fn(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
};

test('browser entrypoint exports createAnalyticsContext and sends events', async () => {
  await withMockedFetch(async (calls) => {
    const originalLocalStorage = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      value: createMemoryStorage(),
      configurable: true,
      writable: true,
    });

    const context = createBrowserAnalyticsContext({
      client: {
        apiKey: 'pi_live_browser',
        flushIntervalMs: 60_000,
        maxRetries: 0,
      },
    });

    try {
      context.track('onboarding:start');
      await context.flush();

      assert.equal(calls.length, 1);
      const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
      assert.equal(headers['x-api-key'], 'pi_live_browser');
    } finally {
      context.shutdown();
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
});

test('react-native entrypoint exports createAnalyticsContext and sends events', async () => {
  await withMockedFetch(async (calls) => {
    const context = createReactNativeAnalyticsContext({
      client: {
        apiKey: 'pi_live_react_native',
        flushIntervalMs: 60_000,
        maxRetries: 0,
      },
    });

    try {
      context.track('onboarding:start');
      await context.flush();

      assert.equal(calls.length, 1);
      const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
      assert.equal(headers['x-api-key'], 'pi_live_react_native');
    } finally {
      context.shutdown();
    }
  });
});
