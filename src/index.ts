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
  DEFAULT_PROJECT_ID_ENV_KEYS,
  initFromEnv,
} from './bootstrap.js';
import { AnalyticsClient } from './analytics-client.js';
import type { InitOptions } from './types.js';

/**
 * Creates a browser analytics client instance.
 */
export const init = (options: InitOptions = {}): AnalyticsClient => {
  return new AnalyticsClient(options);
};

/**
 * Creates an analytics client and waits for async storage hydration.
 * Prefer this in React Native when using async persistence (for example AsyncStorage).
 */
export const initAsync = async (options: InitOptions = {}): Promise<AnalyticsClient> => {
  const client = new AnalyticsClient(options);
  await client.ready();
  return client;
};
