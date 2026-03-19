import type {
  OnboardingEventName,
  OnboardingSurveyEventName,
  PaywallJourneyEventName,
} from './sdk-contract.js';

/**
 * Arbitrary key/value payload sent with an event.
 */
export type EventProperties = Record<string, unknown>;

export type StorageGetItemCallback = (error?: Error | null, value?: string | null) => void;
export type StorageMutationCallback = (error?: Error | null) => void;

export type AnalyticsStorageAdapter = {
  /**
   * Storage APIs can be sync or async.
   * This allows passing AsyncStorage/localStorage directly, or custom adapters.
   */
  getItem: (
    key: string,
    callback?: StorageGetItemCallback,
  ) => string | null | Promise<string | null>;
  setItem: (
    key: string,
    value: string,
    callback?: StorageMutationCallback,
  ) => void | Promise<void>;
  removeItem?: (key: string, callback?: StorageMutationCallback) => void | Promise<void>;
};

export type EventContext = {
  appBuild?: string;
  osName?: string;
  osVersion?: string;
  deviceModel?: string;
  deviceManufacturer?: string;
  deviceType?: string;
  locale?: string;
  country?: string;
  region?: string;
  city?: string;
  timezone?: string;
  networkType?: string;
  carrier?: string;
  installSource?: string;
};

export type OnboardingEventProperties = EventProperties & {
  isNewUser?: boolean;
  onboardingFlowId?: string;
  onboardingFlowVersion?: string | number;
  onboardingExperimentId?: string;
  stepKey?: string;
  stepIndex?: number;
  stepCount?: number;
};

export type PaywallEventProperties = EventProperties & {
  source: string;
  fromScreen?: string;
  paywallId?: string;
  offering?: string;
  paywallEntryId?: string;
  packageId?: string;
  price?: number;
  currency?: string;
  experimentVariant?: string;
  entitlementKey?: string;
};

export type OnboardingSurveyAnswerType =
  | 'single_choice'
  | 'multiple_choice'
  | 'boolean'
  | 'numeric'
  | 'text'
  | 'unknown';

export type OnboardingSurveyResponseInput = {
  surveyKey: string;
  questionKey: string;
  answerType: OnboardingSurveyAnswerType;
  responseKey?: string;
  responseKeys?: string[];
  responseBoolean?: boolean;
  responseNumber?: number;
  responseText?: string;
  appVersion?: string;
  isNewUser?: boolean;
  onboardingFlowId?: string;
  onboardingFlowVersion?: string | number;
  onboardingExperimentId?: string;
  stepKey?: string;
  stepIndex?: number;
  stepCount?: number;
  experimentVariant?: string;
  paywallId?: string;
  properties?: EventProperties;
};

export type OnboardingTrackerDefaults = OnboardingEventProperties & {
  surveyKey?: string;
};

export type OnboardingTrackerSurveyInput = Omit<OnboardingSurveyResponseInput, 'surveyKey'> & {
  surveyKey?: string;
};

export type OnboardingStepTracker = {
  view: (properties?: Omit<OnboardingEventProperties, 'stepKey' | 'stepIndex'>) => void;
  complete: (properties?: Omit<OnboardingEventProperties, 'stepKey' | 'stepIndex'>) => void;
  surveyResponse: (
    input: Omit<OnboardingTrackerSurveyInput, 'stepKey' | 'stepIndex'>,
  ) => void;
};

export type OnboardingTracker = {
  track: (eventName: OnboardingEventName, properties?: OnboardingEventProperties) => void;
  start: (properties?: OnboardingEventProperties) => void;
  stepView: (properties: OnboardingEventProperties) => void;
  stepComplete: (properties: OnboardingEventProperties) => void;
  complete: (properties?: OnboardingEventProperties) => void;
  skip: (properties?: OnboardingEventProperties) => void;
  surveyResponse: (input: OnboardingTrackerSurveyInput) => void;
  step: (
    stepKey: string,
    stepIndex: number,
    properties?: Omit<OnboardingEventProperties, 'stepKey' | 'stepIndex'>,
  ) => OnboardingStepTracker;
};

export type PaywallTrackerDefaults = PaywallEventProperties;

export type PaywallTrackerProperties = Partial<PaywallEventProperties>;

export type PaywallTracker = {
  track: (eventName: PaywallJourneyEventName, properties?: PaywallTrackerProperties) => void;
  shown: (properties?: PaywallTrackerProperties) => void;
  skip: (properties?: PaywallTrackerProperties) => void;
  purchaseStarted: (properties?: PaywallTrackerProperties) => void;
  purchaseSuccess: (properties?: PaywallTrackerProperties) => void;
  purchaseFailed: (properties?: PaywallTrackerProperties) => void;
  purchaseCancel: (properties?: PaywallTrackerProperties) => void;
};

export type QueuedEvent = {
  eventId: string;
  eventName: string;
  ts: string;
  sessionId: string;
  anonId: string;
  userId?: string | null;
  properties: EventProperties;
  platform?: string;
  projectSurface?: string;
  appVersion?: string;
  appBuild?: string;
  osName?: string;
  osVersion?: string;
  deviceModel?: string;
  deviceManufacturer?: string;
  deviceType?: string;
  locale?: string;
  country?: string;
  region?: string;
  city?: string;
  timezone?: string;
  networkType?: string;
  carrier?: string;
  installSource?: string;
  type: 'track' | 'screen' | 'identify' | 'feedback';
};

export type AnalyticsConsentState = 'granted' | 'denied' | 'unknown';

export type SetConsentOptions = {
  /**
   * Persist consent state into configured storage.
   * Defaults to true when `persistConsentState` is enabled.
   */
  persist?: boolean;
};

export type AnalyticsClientOptions = {
  /**
   * Publishable ingest API key.
   * If omitted, the client becomes a safe no-op until a valid key is provided.
   */
  apiKey?: string | null;
  /**
   * Optional collector override reserved for SDK/internal testing.
   * Host app integrations should not set this option.
   */
  endpoint?: string | null;
  batchSize?: number | null;
  flushIntervalMs?: number | null;
  maxRetries?: number | null;
  /**
   * Enables SDK debug logs (`console.debug`).
   * Defaults to `false`.
   *
   * React Native/Expo recommendation:
   * `debug: __DEV__`
   */
  debug?: boolean | null;
  /**
   * Optional platform hint.
   * React Native/Expo: passing `Platform.OS` directly is supported.
   */
  platform?: string | null;
  /**
   * Optional app version hint.
   * Accepts nullable runtime values (for example Expo's `nativeApplicationVersion`).
   */
  appVersion?: string | null;
  /**
   * Optional project surface hint to separate product surfaces/channels
   * (for example `landing`, `dashboard`, `app`) from runtime `platform`.
   */
  projectSurface?: string | null;
  /**
   * Initial consent state.
   * Defaults to `true` when `apiKey` is present (backward-compatible behavior).
   * Set to `false` to enforce explicit `optIn()` / `setConsent(true)` before tracking.
   */
  initialConsentGranted?: boolean | null;
  /**
   * Ignored in current strict-only mode.
   */
  persistConsentState?: boolean | null;
  /**
   * Storage key for persisted consent state.
   * Defaults to `analyticscli:consent:v1`.
   * Ignored in current strict-only mode.
   */
  consentStorageKey?: string | null;
  context?: EventContext | null;
  /**
   * Optional custom persistence adapter.
   * Ignored in current strict-only mode.
   */
  storage?: AnalyticsStorageAdapter | null;
  /**
   * Ignored in current strict-only mode.
   */
  anonId?: string | null;
  /**
   * Ignored in current strict-only mode.
   */
  sessionId?: string | null;
  sessionTimeoutMs?: number | null;
  /**
   * Drops duplicate `onboarding:step_view` events for the same step within one session.
   * This only affects the dedicated onboarding step-view event, not `screen(...)` or paywall events.
   * Defaults to `true`. Set to `false` to disable this behavior.
   */
  dedupeOnboardingStepViewsPerSession?: boolean | null;
  /**
   * Optional cookie domain to persist device/session ids across subdomains.
   * Example: `.analyticscli.com`
   * Ignored in current strict-only mode.
   */
  cookieDomain?: string | null;
  cookieMaxAgeSeconds?: number | null;
  /**
   * Enables cookie-backed id/session persistence.
   * Defaults to true when `cookieDomain` is provided, otherwise false.
   * Ignored in current strict-only mode.
   */
  useCookieStorage?: boolean | null;
};

export type InitOptions = AnalyticsClientOptions;

export type SDKEventName = OnboardingEventName | PaywallJourneyEventName | OnboardingSurveyEventName;

export type InitFromEnvMissingConfigMode = 'noop' | 'throw';

export type InitFromEnvMissingConfig = {
  missingApiKey: boolean;
  searchedApiKeyEnvKeys: string[];
};

export type InitFromEnvOptions = Omit<AnalyticsClientOptions, 'apiKey'> & {
  /**
   * Optional environment-like object.
   * Defaults to `globalThis.process?.env` when available.
   */
  env?: Record<string, unknown> | null;
  /**
   * Explicit api key override.
   */
  apiKey?: string | null;
  /**
   * Candidate env keys resolved in order.
   */
  apiKeyEnvKeys?: string[] | null;
  /**
   * How missing config is handled.
   * - `noop` (default): returns a safe no-op client
   * - `throw`: throws when required config is missing
   */
  missingConfigMode?: InitFromEnvMissingConfigMode | null;
  /**
   * Optional callback for custom logging when config is missing.
   */
  onMissingConfig?: ((details: InitFromEnvMissingConfig) => void) | null;
};

export type InitInput = InitOptions | string | null | undefined;
