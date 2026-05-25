import { AnalyticsClient } from './analytics-client.js';
import type {
  BrowserInitFromEnvOptions,
  InitFromEnvMissingConfig,
  InitFromEnvOptions,
  InitOptions,
  ReactNativeInitFromEnvOptions,
} from './types.js';

export const DEFAULT_API_KEY_ENV_KEYS = [
  'ANALYTICSCLI_PUBLISHABLE_API_KEY',
  'NEXT_PUBLIC_ANALYTICSCLI_PUBLISHABLE_API_KEY',
  'PUBLIC_ANALYTICSCLI_PUBLISHABLE_API_KEY',
  'VITE_ANALYTICSCLI_PUBLISHABLE_API_KEY',
  'EXPO_PUBLIC_ANALYTICSCLI_PUBLISHABLE_API_KEY',
] as const;

export const BROWSER_API_KEY_ENV_KEYS = [
  'ANALYTICSCLI_PUBLISHABLE_API_KEY',
  'NEXT_PUBLIC_ANALYTICSCLI_PUBLISHABLE_API_KEY',
  'PUBLIC_ANALYTICSCLI_PUBLISHABLE_API_KEY',
  'VITE_ANALYTICSCLI_PUBLISHABLE_API_KEY',
  'EXPO_PUBLIC_ANALYTICSCLI_PUBLISHABLE_API_KEY',
] as const;

export const REACT_NATIVE_API_KEY_ENV_KEYS = [
  'ANALYTICSCLI_PUBLISHABLE_API_KEY',
  'EXPO_PUBLIC_ANALYTICSCLI_PUBLISHABLE_API_KEY',
] as const;

type EnvInitOptions = InitFromEnvOptions & {
  defaultEnvKeys: readonly string[];
  defaults?: Partial<InitOptions>;
};

const readTrimmedString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const getProcessEnv = (): Record<string, unknown> | null => {
  const globalWithProcess = globalThis as typeof globalThis & {
    process?: { env?: Record<string, unknown> };
  };
  return globalWithProcess.process?.env ?? null;
};

const resolveEnvSources = (env: Record<string, unknown> | null | undefined): Record<string, unknown>[] => {
  const sources: Record<string, unknown>[] = [];
  if (env && typeof env === 'object') {
    sources.push(env);
  }

  const processEnv = getProcessEnv();
  if (processEnv && processEnv !== env) {
    sources.push(processEnv);
  }

  return sources;
};

const resolveEnvKeys = (
  envKeys: readonly string[] | null | undefined,
  defaultEnvKeys: readonly string[],
): string[] => {
  const keys = envKeys && envKeys.length > 0 ? envKeys : defaultEnvKeys;
  return Array.from(new Set(keys.map((key) => key.trim()).filter(Boolean)));
};

const readApiKeyFromEnv = (
  sources: Record<string, unknown>[],
  keys: readonly string[],
): string | undefined => {
  for (const source of sources) {
    for (const key of keys) {
      const value = readTrimmedString(source[key]);
      if (value) {
        return value;
      }
    }
  }

  return undefined;
};

const stripEnvOptions = (options: InitFromEnvOptions): InitOptions => {
  const clientOptions: InitFromEnvOptions = { ...options };
  delete clientOptions.env;
  delete clientOptions.envKeys;
  delete clientOptions.missingConfigMode;
  delete clientOptions.onMissingConfig;
  return clientOptions;
};

const createMissingConfig = (checkedKeys: string[]): InitFromEnvMissingConfig => ({
  checkedKeys,
  message:
    'Missing AnalyticsCLI publishable API key. Pass `apiKey` explicitly or expose one of the checked publishable env keys.',
});

const initFromEnvWithDefaults = (input: EnvInitOptions): AnalyticsClient => {
  const { defaultEnvKeys, defaults, ...options } = input;
  const clientOptions = stripEnvOptions(options);
  const explicitApiKey = readTrimmedString(clientOptions.apiKey);
  const checkedKeys = resolveEnvKeys(options.envKeys, defaultEnvKeys);
  const apiKey = explicitApiKey ?? readApiKeyFromEnv(resolveEnvSources(options.env), checkedKeys);

  if (!apiKey) {
    const missingConfig = createMissingConfig(checkedKeys);
    options.onMissingConfig?.(missingConfig);
    if (options.missingConfigMode === 'throw') {
      throw new Error(missingConfig.message);
    }
  }

  return new AnalyticsClient({
    ...defaults,
    ...clientOptions,
    apiKey: apiKey ?? '',
  });
};

export const initFromEnv = (options: InitFromEnvOptions = {}): AnalyticsClient =>
  initFromEnvWithDefaults({
    ...options,
    defaultEnvKeys: DEFAULT_API_KEY_ENV_KEYS,
  });

export const initBrowserFromEnv = (options: BrowserInitFromEnvOptions = {}): AnalyticsClient =>
  initFromEnvWithDefaults({
    platform: 'web',
    ...options,
    defaultEnvKeys: BROWSER_API_KEY_ENV_KEYS,
  });

export const initReactNativeFromEnv = (
  options: ReactNativeInitFromEnvOptions = {},
): AnalyticsClient =>
  initFromEnvWithDefaults({
    ...options,
    defaultEnvKeys: REACT_NATIVE_API_KEY_ENV_KEYS,
  });
