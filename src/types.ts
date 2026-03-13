import type {
  OnboardingEventName,
  OnboardingSurveyEventName,
  PaywallJourneyEventName,
} from './sdk-contract.js';

/**
 * Arbitrary key/value payload sent with an event.
 */
export type EventProperties = Record<string, unknown>;

export type AnalyticsStorageAdapter = {
  /**
   * Storage APIs can be sync or async.
   * This allows plugging in AsyncStorage (React Native), MMKV wrappers, or custom secure stores.
   */
  getItem: (key: string) => string | null | Promise<string | null>;
  setItem: (key: string, value: string) => void | Promise<void>;
  removeItem?: (key: string) => void | Promise<void>;
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
  stepKey?: string;
  stepIndex?: number;
  stepCount?: number;
};

export type PaywallEventProperties = EventProperties & {
  source: string;
  fromScreen?: string;
  paywallId?: string;
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

export type AnalyticsClientOptions = {
  /**
   * Write key (long API key).
   * If omitted, the client becomes a safe no-op until a valid key is provided.
   */
  apiKey?: string;
  /**
   * Optional collector override reserved for SDK/internal testing.
   * Host app integrations should not set this option.
   */
  endpoint?: string;
  batchSize?: number;
  flushIntervalMs?: number;
  maxRetries?: number;
  /**
   * Enables SDK debug logs (`console.debug`).
   * Defaults to `false`.
   *
   * React Native/Expo recommendation:
   * `debug: typeof __DEV__ === 'boolean' ? __DEV__ : false`
   */
  debug?: boolean;
  platform?: string;
  appVersion?: string;
  context?: EventContext;
  /**
   * Optional custom persistence adapter.
   * If omitted, browser storage/cookies are used when available; otherwise in-memory IDs are used.
   */
  storage?: AnalyticsStorageAdapter;
  anonId?: string;
  sessionId?: string;
  sessionTimeoutMs?: number;
  /**
   * Drops duplicate `onboarding:step_view` events for the same step within one session.
   * This only affects the dedicated onboarding step-view event, not `screen(...)` or paywall events.
   */
  dedupeOnboardingStepViewsPerSession?: boolean;
  /**
   * Optional cookie domain to persist device/session ids across subdomains.
   * Example: `.analyticscli.com`
   */
  cookieDomain?: string;
  cookieMaxAgeSeconds?: number;
  /**
   * Enables cookie-backed id/session persistence.
   * Defaults to true when `cookieDomain` is provided, otherwise false.
   */
  useCookieStorage?: boolean;
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
  env?: Record<string, unknown>;
  /**
   * Explicit api key override.
   */
  apiKey?: string;
  /**
   * Candidate env keys resolved in order.
   */
  apiKeyEnvKeys?: string[];
  /**
   * How missing config is handled.
   * - `noop` (default): returns a safe no-op client
   * - `throw`: throws when required config is missing
   */
  missingConfigMode?: InitFromEnvMissingConfigMode;
  /**
   * Optional callback for custom logging when config is missing.
   */
  onMissingConfig?: (details: InitFromEnvMissingConfig) => void;
};

export type InitInput = InitOptions | string;
