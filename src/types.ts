import type {
  OnboardingEventName,
  OnboardingSurveyEventName,
  PaywallJourneyEventName,
} from './sdk-contract.js';

/**
 * Arbitrary key/value payload sent with an event.
 */
export type EventProperties = Record<string, unknown>;
export type FeedbackMetadataValue = string | number | boolean | null;
export type FeedbackMetadata = Record<string, FeedbackMetadataValue>;

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
  offeringId?: string;
  fromScreen?: string;
  paywallId?: string;
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
  privacyMode?: 'aggregate' | 'strict' | 'full';
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
  type: 'track' | 'screen' | 'identify';
};

export type FeedbackClientOptions = {
  /**
   * Preferred tenant-owned feedback endpoint or external feedback service base URL.
   * Defaults to the AnalyticsCLI feedback API. You can point this at your own backend/proxy
   * when you need additional moderation, routing, or data-governance controls.
   */
  serviceUrl?: string | null;
  /**
   * Optional API key/header value for external feedback services.
   * Defaults to the SDK publishable API key. Avoid overriding this in mobile client code
   * unless the key is app-scoped and intended for public use.
   */
  apiKey?: string | null;
  /**
   * Header used when `apiKey` is set. Defaults to `x-feedback-key`.
   */
  apiKeyHeader?: string | null;
  /**
   * Feedback application identifier expected by the target feedback endpoint.
   */
  appId?: string | null;
  /**
   * Default surface label, for example `ios_app`, `android_app`, or `web_app`.
   */
  surface?: string | null;
  /**
   * Default location identifier for shared call sites.
   */
  locationId?: string | null;
  /**
   * Default human-readable origin label describing where the feedback entry originated in the product.
   */
  originName?: string | null;
  /**
   * Optional default user id for the feedback endpoint.
   * If omitted, the SDK uses the current identified user id or current anon id.
   */
  userId?: string | null;
  /**
   * Additional default metadata sent with every feedback submission.
   */
  metadata?: FeedbackMetadata | null;
  /**
   * Optional timeout for network submission.
   */
  timeoutMs?: number | null;
  /**
   * Track a lightweight analytics event (`feedback:submitted` / `feedback:submission_failed`) after submission attempts.
   * Defaults to `true`.
   */
  trackEvents?: boolean | null;
};

export type FeedbackSubmissionInput = {
  message: string;
  locationId?: string;
  originName?: string;
  category?: 'bug' | 'feature' | 'ux' | 'performance' | 'other';
  rating?: number;
  surface?: string;
  context?: string;
  userId?: string;
  metadata?: FeedbackMetadata;
};

export type FeedbackSubmissionResult = {
  ok: boolean;
  delivery: 'external_feedback_service' | 'analytics_only';
  serviceUrl?: string;
  appId?: string;
  locationId: string;
  surface: string;
  originName: string | null;
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
   * Current queue size after the failed batch was either requeued or dropped.
   */
  queueSize: number;
  /**
   * ISO timestamp when the failure was surfaced to host-app callbacks.
   */
  timestamp: string;
};

export type AnalyticsIngestErrorHandler = (error: AnalyticsIngestError) => void;

export type AnalyticsDropReason =
  | 'queue_overflow'
  | 'invalid_event'
  | 'serialization_error'
  | 'payload_too_large'
  | 'permanent_ingest_error';

/**
 * Payload-free delivery diagnostic emitted when the SDK intentionally drops events.
 *
 * Event properties and identifiers are deliberately omitted so this object can be
 * forwarded to host-app monitoring without leaking analytics payload data.
 */
export type AnalyticsDropDiagnostic = {
  name: 'AnalyticsDropDiagnostic';
  reason: AnalyticsDropReason;
  message: string;
  droppedCount: number;
  eventNames: string[];
  queueSize: number;
  maxQueueSize: number;
  status?: number;
  errorCode?: string;
  requestId?: string;
  timestamp: string;
};

export type AnalyticsDropHandler = (diagnostic: AnalyticsDropDiagnostic) => void;

export type AnalyticsFlushOptions = {
  /**
   * Maximum time to spend draining the queue.
   * Defaults to `10000`. Set to `0` to return immediately without waiting.
   */
  timeoutMs?: number | null;
};

export type AnalyticsFlushResult = {
  /**
   * `true` when no queued or in-flight events remain.
   */
  completed: boolean;
  /**
   * `true` when draining stopped because the configured timeout elapsed.
   */
  timedOut: boolean;
  /**
   * Why draining stopped.
   */
  reason: 'drained' | 'timed_out' | 'retryable_failure' | 'auth_pause';
  /**
   * Queued and in-flight event count when draining stopped.
   */
  remainingEvents: number;
};

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
  /**
   * Maximum number of events retained in memory.
   *
   * Defaults to `1000` and is capped at `100000`. When the queue is full, the
   * oldest event is evicted so current product activity can still be observed.
   */
  maxQueueSize?: number | null;
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
   * Optional payload-free hook for events intentionally dropped because of queue
   * pressure, invalid/oversize payloads, or permanent collector rejections.
   */
  onEventsDropped?: AnalyticsDropHandler | null;
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
   * - `consent_gated` (default): starts in strict mode and enables persistence only after full-tracking consent
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
   * Revoking full-tracking consent removes SDK identity/session keys from configured storage
   * and rotates in-memory identifiers.
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
   * Optional tenant feedback transport configuration.
   * Recommended for mobile apps only when routed through a tenant-owned backend/proxy.
   */
  feedback?: FeedbackClientOptions | null;
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
   * Drops immediate duplicate `screen(...)` events for the same screen key within one session.
   * This guards against double-fired focus/mount hooks while keeping intentional revisits intact.
   * Defaults to `true`. Set to `false` to disable this behavior.
   */
  dedupeScreenViewsPerSession?: boolean | null;
  /**
   * Drops overlapping onboarding `screen:*` + `onboarding:step_view` duplicates for the same step
   * inside one session.
   * This helps when host apps track both route-level screen views and dedicated onboarding step views.
   * Defaults to `true`. Set to `false` to keep both events.
   */
  dedupeOnboardingScreenStepViewOverlapsPerSession?: boolean | null;
  /**
   * Time window used by `dedupeScreenViewsPerSession` and onboarding screen/step overlap dedupe.
   * A duplicate screen event emitted again within this window is dropped.
   * Defaults to `1200`.
   */
  screenViewDedupeWindowMs?: number | null;
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

export type InitFromEnvMissingConfigMode = 'noop' | 'throw';

export type InitFromEnvMissingConfig = {
  /**
   * Environment keys checked while resolving the publishable API key.
   */
  checkedKeys: string[];
  /**
   * Human-readable setup message safe to show in logs or setup tooling.
   */
  message: string;
};

export type InitFromEnvOptions = InitOptions & {
  /**
   * Explicit env object for bundlers/frameworks where public env values are not available on process.env.
   * Examples: `import.meta.env`, Next public runtime config, or a test env object.
   */
  env?: Record<string, unknown> | null;
  /**
   * API key env names to check before falling back to SDK defaults.
   */
  envKeys?: readonly string[] | null;
  /**
   * Missing-config behavior. Defaults to `noop`, which creates a safe no-op client.
   */
  missingConfigMode?: InitFromEnvMissingConfigMode | null;
  /**
   * Optional hook for setup tooling or app diagnostics when no publishable API key is found.
   */
  onMissingConfig?: ((missing: InitFromEnvMissingConfig) => void) | null;
};

export type BrowserInitFromEnvOptions = InitFromEnvOptions;

export type ReactNativeInitFromEnvOptions = InitFromEnvOptions;

export type SDKEventName = OnboardingEventName | PaywallJourneyEventName | OnboardingSurveyEventName;

export type InitInput = InitOptions | string | null | undefined;
