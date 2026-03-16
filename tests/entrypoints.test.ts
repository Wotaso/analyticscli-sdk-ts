import assert from 'node:assert/strict';
import test from 'node:test';
import { initBrowserFromEnv } from '../src/browser.js';
import { initReactNativeFromEnv } from '../src/react-native.js';

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

test('browser entrypoint resolves PUBLIC_ANALYTICSCLI_PUBLISHABLE_API_KEY by default', async () => {
  await withMockedFetch(async (calls) => {
    const originalLocalStorage = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      value: createMemoryStorage(),
      configurable: true,
      writable: true,
    });

    const client = initBrowserFromEnv({
      env: {
        PUBLIC_ANALYTICSCLI_PUBLISHABLE_API_KEY: 'pi_live_browser',
      },
      flushIntervalMs: 60_000,
      maxRetries: 0,
    });

    try {
      client.track('onboarding:start');
      await client.flush();

      assert.equal(calls.length, 1);
      const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
      assert.equal(headers['x-api-key'], 'pi_live_browser');
    } finally {
      client.shutdown();
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

test('react-native entrypoint resolves EXPO_PUBLIC_ANALYTICSCLI_PUBLISHABLE_API_KEY by default', async () => {
  await withMockedFetch(async (calls) => {
    const client = initReactNativeFromEnv({
      env: {
        EXPO_PUBLIC_ANALYTICSCLI_PUBLISHABLE_API_KEY: 'pi_live_react_native',
      },
      flushIntervalMs: 60_000,
      maxRetries: 0,
    });

    try {
      client.track('onboarding:start');
      await client.flush();

      assert.equal(calls.length, 1);
      const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
      assert.equal(headers['x-api-key'], 'pi_live_react_native');
    } finally {
      client.shutdown();
    }
  });
});
