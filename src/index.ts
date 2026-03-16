export {
  ONBOARDING_EVENTS,
  PAYWALL_EVENTS,
  PURCHASE_EVENTS,
  ONBOARDING_PROGRESS_EVENT_ORDER,
  PAYWALL_JOURNEY_EVENT_ORDER,
  ONBOARDING_SCREEN_EVENT_PREFIXES,
  ONBOARDING_SURVEY_EVENTS,
  PAYWALL_ANCHOR_EVENT_CANDIDATES,
  PAYWALL_SKIP_EVENT_CANDIDATES,
  PURCHASE_SUCCESS_EVENT_CANDIDATES,
} from './sdk-contract.js';

export type {
  OnboardingEventName,
  PaywallEventName,
  PurchaseEventName,
  PaywallJourneyEventName,
  OnboardingSurveyEventName,
} from './sdk-contract.js';

export type {
  AnalyticsClientOptions,
  AnalyticsStorageAdapter,
  EventContext,
  EventProperties,
  InitInput,
  InitFromEnvMissingConfig,
  InitFromEnvMissingConfigMode,
  InitFromEnvOptions,
  InitOptions,
  OnboardingEventProperties,
  OnboardingStepTracker,
  OnboardingTracker,
  OnboardingTrackerDefaults,
  OnboardingTrackerSurveyInput,
  OnboardingSurveyAnswerType,
  OnboardingSurveyResponseInput,
  PaywallEventProperties,
  PaywallTracker,
  PaywallTrackerDefaults,
  PaywallTrackerProperties,
} from './types.js';

export { AnalyticsClient } from './analytics-client.js';
export {
  DEFAULT_API_KEY_ENV_KEYS,
  initFromEnv,
} from './bootstrap.js';
import { AnalyticsClient } from './analytics-client.js';
import { initFromEnv } from './bootstrap.js';
import type { InitFromEnvOptions, InitInput, InitOptions } from './types.js';

const normalizeInitInput = (input: InitInput): InitOptions => {
  if (typeof input === 'string') {
    return { apiKey: input };
  }
  if (input === null || input === undefined) {
    return {};
  }
  return input;
};

/**
 * Creates a browser analytics client instance.
 */
export const init = (input: InitInput = {}): AnalyticsClient => {
  return new AnalyticsClient(normalizeInitInput(input));
};

/**
 * Creates an analytics client and waits for async storage hydration.
 * Prefer this in React Native when using async persistence (for example AsyncStorage).
 */
export const initAsync = async (input: InitInput = {}): Promise<AnalyticsClient> => {
  const client = new AnalyticsClient(normalizeInitInput(input));
  await client.ready();
  return client;
};

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

export type BrowserInitFromEnvOptions = Omit<InitFromEnvOptions, 'apiKeyEnvKeys'> & {
  apiKeyEnvKeys?: readonly string[];
};

export type ReactNativeInitFromEnvOptions = Omit<InitFromEnvOptions, 'apiKeyEnvKeys'> & {
  apiKeyEnvKeys?: readonly string[];
};

/**
 * Browser-focused env bootstrap.
 * Supports common env prefixes across Next.js, Astro/Vite and Expo web.
 */
export const initBrowserFromEnv = (options: BrowserInitFromEnvOptions = {}) => {
  const { apiKeyEnvKeys, ...rest } = options;
  return initFromEnv({
    ...rest,
    apiKeyEnvKeys: [...(apiKeyEnvKeys ?? BROWSER_API_KEY_ENV_KEYS)],
  });
};

/**
 * React Native-focused env bootstrap.
 * Defaults to native-friendly env keys while still allowing explicit overrides.
 */
export const initReactNativeFromEnv = (options: ReactNativeInitFromEnvOptions = {}) => {
  const { apiKeyEnvKeys, ...rest } = options;
  return initFromEnv({
    ...rest,
    apiKeyEnvKeys: [...(apiKeyEnvKeys ?? REACT_NATIVE_API_KEY_ENV_KEYS)],
  });
};
