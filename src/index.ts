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
  AnalyticsConsentState,
  AnalyticsIngestError,
  AnalyticsIngestErrorHandler,
  AnalyticsStorageAdapter,
  EventContext,
  EventProperties,
  IdentityTrackingMode,
  InitInput,
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
  SetConsentOptions,
} from './types.js';

export { AnalyticsClient } from './analytics-client.js';
export {
  createAnalyticsContext,
  type AnalyticsContext,
  type AnalyticsContextConsentControls,
  type AnalyticsContextUserControls,
  type CreateAnalyticsContextOptions,
} from './context.js';
import { AnalyticsClient } from './analytics-client.js';
import type { InitInput, InitOptions } from './types.js';

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
 * Creates an analytics client with consent-first defaults.
 * Tracking stays disabled until `optIn()` / `setConsent(true)` is called.
 */
export const initConsentFirst = (input: InitInput = {}): AnalyticsClient => {
  const normalized = normalizeInitInput(input);
  return new AnalyticsClient({
    ...normalized,
    initialConsentGranted: false,
  });
};

/**
 * Creates an analytics client and resolves once client initialization completes.
 */
export const initAsync = async (input: InitInput = {}): Promise<AnalyticsClient> => {
  const client = new AnalyticsClient(normalizeInitInput(input));
  await client.ready();
  return client;
};

export const initConsentFirstAsync = async (input: InitInput = {}): Promise<AnalyticsClient> => {
  const client = initConsentFirst(input);
  await client.ready();
  return client;
};
