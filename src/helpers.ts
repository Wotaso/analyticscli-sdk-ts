import { RESERVED_PII_KEYS } from './sdk-contract.js';
import type { AnalyticsStorageAdapter, EventProperties } from './types.js';

export const nowIso = (): string => new Date().toISOString();

const isPromiseLike = <T>(value: unknown): value is PromiseLike<T> => {
  return typeof value === 'object' && value !== null && 'then' in value;
};

const normalizeStoredValue = (value: unknown): string | null => {
  if (typeof value === 'string' || value === null) {
    return value;
  }
  return null;
};

export const randomId = (): string => {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  // RFC 4122 v4 UUID bits.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  let output = '';
  for (let index = 0; index < bytes.length; index += 1) {
    const hex = bytes[index].toString(16).padStart(2, '0');
    output += hex;
    if (index === 3 || index === 5 || index === 7 || index === 9) {
      output += '-';
    }
  }

  return output;
};

export const readStorageSync = (storage: AnalyticsStorageAdapter | null, key: string): string | null => {
  if (!storage) {
    return null;
  }

  try {
    const value = storage.getItem(key);
    if (isPromiseLike<string | null>(value)) {
      void value.catch(() => {
        // ignore async storage read failures in sync call sites
      });
      return null;
    }
    return normalizeStoredValue(value);
  } catch {
    return null;
  }
};

export const readStorageAsync = async (
  storage: AnalyticsStorageAdapter | null,
  key: string,
): Promise<string | null> => {
  if (!storage) {
    return null;
  }

  try {
    const value = storage.getItem(key);
    if (isPromiseLike<string | null>(value)) {
      return normalizeStoredValue(await value.catch(() => null));
    }
    return normalizeStoredValue(value);
  } catch {
    return null;
  }
};

export const writeStorageSync = (
  storage: AnalyticsStorageAdapter | null,
  key: string,
  value: string,
): void => {
  if (!storage) {
    return;
  }

  try {
    const result = storage.setItem(key, value);
    if (isPromiseLike<void>(result)) {
      void result.catch(() => {
        // ignore async storage failures in private mode/server environment
      });
    }
  } catch {
    // ignore storage failures in private mode/server environment
  }
};

const readTrimmedString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const normalizePlatformValue = (
  value: unknown,
): 'web' | 'ios' | 'android' | 'mac' | 'windows' | undefined => {
  const normalized = readTrimmedString(value)?.toLowerCase();
  if (
    normalized === 'web' ||
    normalized === 'ios' ||
    normalized === 'android' ||
    normalized === 'mac' ||
    normalized === 'windows'
  ) {
    return normalized;
  }
  if (normalized === 'macos' || normalized === 'osx' || normalized === 'darwin') {
    return 'mac';
  }
  if (normalized === 'win32') {
    return 'windows';
  }
  return undefined;
};

const readGlobalPlatformOs = (): 'web' | 'ios' | 'android' | 'mac' | 'windows' | undefined => {
  const withPlatform = globalThis as typeof globalThis & {
    Platform?: { OS?: unknown };
  };

  const fromPlatform = normalizePlatformValue(withPlatform.Platform?.OS);
  if (fromPlatform) {
    return fromPlatform;
  }

  const withExpoPlatform = globalThis as typeof globalThis & {
    expo?: { modules?: { ExpoPlatform?: { osName?: unknown } } };
  };

  return normalizePlatformValue(withExpoPlatform.expo?.modules?.ExpoPlatform?.osName);
};

export const detectDefaultPlatform = (): string | undefined => {
  const detectedNativePlatform = readGlobalPlatformOs();
  if (detectedNativePlatform) {
    return detectedNativePlatform;
  }

  if (typeof navigator === 'undefined') {
    return undefined;
  }

  if (navigator.product === 'ReactNative') {
    return undefined;
  }

  return 'web';
};

export const detectDefaultAppVersion = (): string | undefined => {
  const withExpoModules = globalThis as typeof globalThis & {
    expo?: {
      modules?: {
        ExpoApplication?: {
          nativeApplicationVersion?: unknown;
          applicationVersion?: unknown;
          version?: unknown;
        };
      };
    };
  };

  const expoApp = withExpoModules.expo?.modules?.ExpoApplication;
  const candidates: unknown[] = [
    expoApp?.nativeApplicationVersion,
    expoApp?.applicationVersion,
    expoApp?.version,
  ];

  for (const candidate of candidates) {
    const value = readTrimmedString(candidate);
    if (value) {
      return value;
    }
  }

  return undefined;
};

export const detectRuntimeEnv = (): 'production' | 'development' => {
  const globalWithDevFlag = globalThis as typeof globalThis & { __DEV__?: boolean };
  if (typeof globalWithDevFlag.__DEV__ === 'boolean') {
    return globalWithDevFlag.__DEV__ ? 'development' : 'production';
  }

  const globalWithProcess = globalThis as typeof globalThis & {
    process?: { env?: { NODE_ENV?: string } };
  };
  const nodeEnv = globalWithProcess.process?.env?.NODE_ENV;
  if (nodeEnv) {
    return nodeEnv === 'production' ? 'production' : 'development';
  }

  if (typeof window !== 'undefined' && typeof window.location?.hostname === 'string') {
    const hostname = window.location.hostname.toLowerCase();
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.test') ||
      hostname.includes('dev') ||
      hostname.includes('staging') ||
      hostname.includes('preview')
    ) {
      return 'development';
    }
  }

  return 'production';
};

const decodeComponentSafe = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export const resolveCookieStorageAdapter = (
  enabled: boolean,
  cookieDomain: string | undefined,
  cookieMaxAgeSeconds: number,
): AnalyticsStorageAdapter | null => {
  if (!enabled || typeof document === 'undefined') {
    return null;
  }

  const normalizedDomain = cookieDomain?.trim();

  const getCookie = (key: string): string | null => {
    const encodedKey = encodeURIComponent(key);
    const cookies = document.cookie ? document.cookie.split(';') : [];

    for (const rawCookie of cookies) {
      const cookie = rawCookie.trim();
      if (!cookie.startsWith(`${encodedKey}=`)) {
        continue;
      }

      const rawValue = cookie.slice(encodedKey.length + 1);
      return decodeComponentSafe(rawValue);
    }

    return null;
  };

  const setCookie = (key: string, value: string): void => {
    const attributes = [
      'Path=/',
      'SameSite=Lax',
      `Max-Age=${cookieMaxAgeSeconds}`,
      ...(normalizedDomain ? [`Domain=${normalizedDomain}`] : []),
      ...(typeof location !== 'undefined' && location.protocol === 'https:' ? ['Secure'] : []),
    ];

    document.cookie = `${encodeURIComponent(key)}=${encodeURIComponent(value)}; ${attributes.join('; ')}`;
  };

  const removeCookie = (key: string): void => {
    const attributes = [
      'Path=/',
      'SameSite=Lax',
      'Max-Age=0',
      ...(normalizedDomain ? [`Domain=${normalizedDomain}`] : []),
      ...(typeof location !== 'undefined' && location.protocol === 'https:' ? ['Secure'] : []),
    ];
    document.cookie = `${encodeURIComponent(key)}=; ${attributes.join('; ')}`;
  };

  return {
    getItem: (key: string) => getCookie(key),
    setItem: (key: string, value: string) => setCookie(key, value),
    removeItem: (key: string) => removeCookie(key),
  };
};

export const resolveBrowserStorageAdapter = (): AnalyticsStorageAdapter | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  let storage: Storage;
  try {
    storage = window.localStorage;
  } catch {
    return null;
  }

  if (!storage) {
    return null;
  }

  return {
    getItem: (key: string) => storage.getItem(key),
    setItem: (key: string, value: string) => storage.setItem(key, value),
    removeItem: (key: string) => storage.removeItem(key),
  };
};

export const combineStorageAdapters = (
  primary: AnalyticsStorageAdapter,
  secondary: AnalyticsStorageAdapter,
): AnalyticsStorageAdapter => {
  return {
    getItem: (key: string) => {
      const primaryValue = primary.getItem(key);
      if (typeof primaryValue === 'string') {
        return primaryValue;
      }

      if (primaryValue === null) {
        const secondaryValue = secondary.getItem(key);
        if (typeof secondaryValue === 'string') {
          return secondaryValue;
        }
        return secondaryValue === null ? null : null;
      }

      return null;
    },
    setItem: (key: string, value: string) => {
      primary.setItem(key, value);
      secondary.setItem(key, value);
    },
    removeItem: (key: string) => {
      primary.removeItem?.(key);
      secondary.removeItem?.(key);
    },
  };
};

export const sanitizeProperties = (properties: EventProperties | undefined): EventProperties => {
  if (!properties) {
    return {};
  }

  const entries = Object.entries(properties).filter(([key]) => !RESERVED_PII_KEYS.has(key));
  return Object.fromEntries(entries);
};

export const toStableKey = (value: string | undefined): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_\-:.]/g, '_');
  if (!normalized) return undefined;
  return normalized.slice(0, 80);
};

export const toNumericBucket = (value: number): string => {
  if (!Number.isFinite(value)) return 'nan';
  if (value < 0) return 'lt_0';
  if (value <= 10) return '0_10';
  if (value <= 20) return '11_20';
  if (value <= 30) return '21_30';
  if (value <= 40) return '31_40';
  if (value <= 50) return '41_50';
  if (value <= 100) return '51_100';
  return 'gt_100';
};

export const toTextLengthBucket = (value: string): string => {
  const length = value.trim().length;
  if (length === 0) return 'empty';
  if (length <= 10) return '1_10';
  if (length <= 30) return '11_30';
  if (length <= 80) return '31_80';
  return 'gt_80';
};
