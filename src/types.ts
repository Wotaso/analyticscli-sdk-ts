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
  country?: string;
  region?: string;
  city?: string;
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
export type IdentityTrackingMode = 'strict' | 'consent_gated' | 'always_on';

export type AnalyticsIngestError = {
  /**
   * Stable error name for host-app monitoring.
   */
  name: 'AnalyticsIngestError';
  /**
   * Human-readable summary of the ingest failure.
   */
  message: string;
  /**
   * Collector endpoint base URL configured in the SDK client.
   */
  endpoint: string;
  /**
   * Collector path that failed.
   */
  path: '/v1/collect';
  /**
   * HTTP status when available.
   */
  status?: number;
  /**
   * Structured server error code when available.
   */
  errorCode?: string;
  /**
   * Structured server message when available.
   */
  serverMessage?: string;
  /**
   * Request correlation id when exposed by the collector response.
   */
  requestId?: string;
  /**
   * Whether retrying can help (`true` for network/5xx/429 class failures).
   */
  retryable: boolean;
  /**
   * Number of attempts that were made for this batch.
   */
  attempts: number;
  /**
   * SDK max retries configured on the client.
   */
  maxRetries: number;
  /**
   * Number of events in the failed batch.
   */
  batchSize: number;
  /**
   * Current queue size after requeue.
   */
  queueSize: number;
  /**
   * ISO timestamp when the failure was surfaced to host-app callbacks.
   */
  timestamp: string;
};

export type AnalyticsIngestErrorHandler = (error: AnalyticsIngestError) => void;

export type SetConsentOptions = {
  /**
   * Whether consent state should be persisted to storage when enabled.
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
   * Optional host-app hook for ingest delivery failures.
   * Use this to forward operational diagnostics to your own monitoring stack.
   *
   * GDPR recommendation:
   * forward this structured metadata only and avoid attaching event payloads or raw identifiers.
   */
  onIngestError?: AnalyticsIngestErrorHandler | null;
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
   * Initial event-collection consent state.
   * Defaults to `true` when `apiKey` is present.
   * Set to `false` to enforce explicit `optIn()` / `setConsent(true)` before event collection.
   */
  initialConsentGranted?: boolean | null;
  /**
   * Controls identity persistence behavior.
   * - `consent_gated` (default): starts in strict mode and enables persistence only after consent
   * - `always_on`: enables persistence immediately
   * - `strict`: disables persistence and identity linkage
   */
  identityTrackingMode?: IdentityTrackingMode | null;
  /**
   * Boolean shortcut for `identityTrackingMode: 'always_on'`.
   * Kept for host-app ergonomics.
   */
  enableFullTrackingWithoutConsent?: boolean | null;
  /**
   * Initial consent state for identity persistence when `identityTrackingMode='consent_gated'`.
   * Defaults to `false`.
   */
  initialFullTrackingConsentGranted?: boolean | null;
  /**
   * Persist full-tracking consent in configured storage.
   */
  persistConsentState?: boolean | null;
  /**
   * Storage key for persisted full-tracking consent state.
   * Defaults to `analyticscli:consent:v1`.
   */
  consentStorageKey?: string | null;
  context?: EventContext | null;
  /**
   * Optional custom persistence adapter used when identity persistence is active.
   */
  storage?: AnalyticsStorageAdapter | null;
  /**
   * Optional explicit anonymous device id when identity persistence is active.
   */
  anonId?: string | null;
  /**
   * Optional explicit session id when identity persistence is active.
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
   * Cookie domain for optional cookie-backed persistence.
   */
  cookieDomain?: string | null;
  cookieMaxAgeSeconds?: number | null;
  /**
   * Enables cookie-backed persistence in browsers.
   */
  useCookieStorage?: boolean | null;
};

export type InitOptions = AnalyticsClientOptions;

export type SDKEventName = OnboardingEventName | PaywallJourneyEventName | OnboardingSurveyEventName;

export type InitInput = InitOptions | string | null | undefined;
