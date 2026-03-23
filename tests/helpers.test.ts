import assert from 'node:assert/strict';
import test from 'node:test';
import {
  combineStorageAdapters,
  detectDefaultAppVersion,
  detectDefaultPlatform,
  detectRuntimeEnv,
  randomId,
  readStorageAsync,
  readStorageSync,
  resolveCookieStorageAdapter,
  resolveBrowserStorageAdapter,
  sanitizeProperties,
  toNumericBucket,
  toStableKey,
  toTextLengthBucket,
  writeStorageSync,
} from '../src/helpers.js';

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const withGlobalProperty = async <T>(
  key: keyof typeof globalThis,
  value: unknown,
  fn: () => Promise<T> | T,
): Promise<T> => {
  const hadOwn = Object.prototype.hasOwnProperty.call(globalThis, key);
  const original = (globalThis as Record<string, unknown>)[key as string];
  Object.defineProperty(globalThis, key, {
    value,
    configurable: true,
    writable: true,
  });

  try {
    return await fn();
  } finally {
    if (hadOwn) {
      Object.defineProperty(globalThis, key, {
        value: original,
        configurable: true,
        writable: true,
      });
    } else {
      Reflect.deleteProperty(globalThis, key);
    }
  }
};

test('readStorageSync and readStorageAsync support sync + async adapters', async () => {
  const syncStorage = {
    getItem: (key: string) => (key === 'present' ? 'value' : null),
    setItem: () => undefined,
  };
  const asyncStorage = {
    getItem: async (key: string) => (key === 'present' ? 'value' : null),
    setItem: async () => undefined,
  };

  assert.equal(readStorageSync(syncStorage, 'present'), 'value');
  assert.equal(readStorageSync(asyncStorage, 'present'), null);
  assert.equal(await readStorageAsync(syncStorage, 'present'), 'value');
  assert.equal(await readStorageAsync(asyncStorage, 'present'), 'value');
});

test('writeStorageSync swallows sync and async storage failures', async () => {
  const syncFailStorage = {
    getItem: () => null,
    setItem: () => {
      throw new Error('sync fail');
    },
  };

  const asyncFailStorage = {
    getItem: async () => null,
    setItem: async () => {
      throw new Error('async fail');
    },
  };

  assert.doesNotThrow(() => writeStorageSync(syncFailStorage, 'key', 'value'));
  assert.doesNotThrow(() => writeStorageSync(asyncFailStorage, 'key', 'value'));
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test('randomId() returns UUID v4 via crypto.randomUUID when available', async () => {
  await withGlobalProperty(
    'crypto' as keyof typeof globalThis,
    {
      randomUUID: () => '11111111-1111-4111-8111-111111111111',
    },
    () => {
      assert.equal(randomId(), '11111111-1111-4111-8111-111111111111');
    },
  );
});

test('randomId() fallback returns UUID v4 when randomUUID is unavailable', async () => {
  await withGlobalProperty('crypto' as keyof typeof globalThis, undefined, () => {
    const id = randomId();
    assert.match(id, UUID_V4_REGEX);
  });
});

test('detectDefaultPlatform returns undefined when only ReactNative product is known', async () => {
  await withGlobalProperty('navigator', { product: 'ReactNative' }, () => {
    assert.equal(detectDefaultPlatform(), undefined);
  });
});

test('detectDefaultPlatform resolves native os when Platform.OS is available', async () => {
  await withGlobalProperty('Platform' as keyof typeof globalThis, { OS: 'ios' }, () => {
    assert.equal(detectDefaultPlatform(), 'ios');
  });
});

test('detectDefaultPlatform normalizes macOS and Windows platform values', async () => {
  await withGlobalProperty('Platform' as keyof typeof globalThis, { OS: 'macos' }, () => {
    assert.equal(detectDefaultPlatform(), 'mac');
  });

  await withGlobalProperty('Platform' as keyof typeof globalThis, { OS: 'windows' }, () => {
    assert.equal(detectDefaultPlatform(), 'windows');
  });
});

test('detectDefaultAppVersion reads Expo application version hints', async () => {
  await withGlobalProperty(
    'expo' as keyof typeof globalThis,
    {
      modules: {
        ExpoApplication: {
          nativeApplicationVersion: '2.3.4',
        },
      },
    },
    () => {
      assert.equal(detectDefaultAppVersion(), '2.3.4');
    },
  );
});

test('detectDefaultAppVersion returns undefined when no runtime hint is present', () => {
  assert.equal(detectDefaultAppVersion(), undefined);
});

test('detectRuntimeEnv prioritizes __DEV__ then process env', async () => {
  await withGlobalProperty('__DEV__' as keyof typeof globalThis, true, () => {
    assert.equal(detectRuntimeEnv(), 'development');
  });

  await withGlobalProperty('__DEV__' as keyof typeof globalThis, false, () => {
    assert.equal(detectRuntimeEnv(), 'production');
  });

  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  try {
    assert.equal(detectRuntimeEnv(), 'development');
  } finally {
    process.env.NODE_ENV = originalNodeEnv;
  }
});

test('resolveBrowserStorageAdapter returns null when localStorage access throws', async () => {
  const brokenWindow = {};
  Object.defineProperty(brokenWindow, 'localStorage', {
    get() {
      throw new Error('denied');
    },
    configurable: true,
  });

  await withGlobalProperty('window', brokenWindow, () => {
    assert.equal(resolveBrowserStorageAdapter(), null);
  });
});

test('resolveBrowserStorageAdapter uses provided localStorage implementation', async () => {
  const backing = new Map<string, string>();
  const windowLike = {
    localStorage: {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => {
        backing.set(key, value);
      },
      removeItem: (key: string) => {
        backing.delete(key);
      },
    },
  };

  await withGlobalProperty('window', windowLike, () => {
    const storage = resolveBrowserStorageAdapter();
    assert.ok(storage);
    storage?.setItem('alpha', '1');
    assert.equal(storage?.getItem('alpha'), '1');
    storage?.removeItem?.('alpha');
    assert.equal(storage?.getItem('alpha'), null);
  });
});

test('resolveCookieStorageAdapter reads/writes/removes cookies and tolerates malformed encoding', async () => {
  const cookieStore = new Map<string, string>();
  const cookieWrites: string[] = [];
  const documentLike = {
    get cookie() {
      return Array.from(cookieStore.entries())
        .map(([key, value]) => `${key}=${value}`)
        .join('; ');
    },
    set cookie(value: string) {
      cookieWrites.push(value);
      const [pair, ...attributes] = value.split(';').map((part) => part.trim());
      const [encodedKey, encodedValue = ''] = pair.split('=');
      const maxAge = attributes.find((attribute) => attribute.toLowerCase().startsWith('max-age='));
      if (!encodedKey) {
        return;
      }
      if (maxAge?.toLowerCase() === 'max-age=0') {
        cookieStore.delete(encodedKey);
        return;
      }
      cookieStore.set(encodedKey, encodedValue);
    },
  };

  await withGlobalProperty('document' as keyof typeof globalThis, documentLike, async () => {
    await withGlobalProperty(
      'location' as keyof typeof globalThis,
      { protocol: 'https:' },
      () => {
        const storage = resolveCookieStorageAdapter(true, ' .example.com ', 60);
        assert.ok(storage);

        storage?.setItem('user id', 'hello/world');
        assert.equal(storage?.getItem('user id'), 'hello/world');
        assert.match(cookieWrites[0] ?? '', /Domain=\.example\.com/);
        assert.match(cookieWrites[0] ?? '', /Secure/);

        cookieStore.set('broken', '%E0%A4%A');
        assert.equal(storage?.getItem('broken'), '%E0%A4%A');

        storage?.removeItem?.('user id');
        assert.equal(storage?.getItem('user id'), null);
      },
    );
  });
});

test('combineStorageAdapters prefers primary values and mirrors writes/removals', () => {
  const primaryStore = new Map<string, string>([['primary', 'one']]);
  const secondaryStore = new Map<string, string>([['secondary', 'two']]);

  const combined = combineStorageAdapters(
    {
      getItem: (key: string) => primaryStore.get(key) ?? null,
      setItem: (key: string, value: string) => {
        primaryStore.set(key, value);
      },
      removeItem: (key: string) => {
        primaryStore.delete(key);
      },
    },
    {
      getItem: (key: string) => secondaryStore.get(key) ?? null,
      setItem: (key: string, value: string) => {
        secondaryStore.set(key, value);
      },
      removeItem: (key: string) => {
        secondaryStore.delete(key);
      },
    },
  );

  assert.equal(combined.getItem('primary'), 'one');
  assert.equal(combined.getItem('secondary'), 'two');
  assert.equal(combined.getItem('missing'), null);

  combined.setItem('shared', 'value');
  assert.equal(primaryStore.get('shared'), 'value');
  assert.equal(secondaryStore.get('shared'), 'value');

  combined.removeItem?.('shared');
  assert.equal(primaryStore.has('shared'), false);
  assert.equal(secondaryStore.has('shared'), false);
});

test('property and survey helpers normalize payload values', () => {
  assert.deepEqual(sanitizeProperties({ email: 'redacted@example.com', source: 'welcome' }), {
    source: 'welcome',
  });
  assert.equal(toStableKey(' Welcome Screen #1 '), 'welcome_screen__1');
  assert.equal(toNumericBucket(7), '0_10');
  assert.equal(toNumericBucket(999), 'gt_100');
  assert.equal(toTextLengthBucket(''), 'empty');
  assert.equal(toTextLengthBucket('hello world'), '11_30');
});
