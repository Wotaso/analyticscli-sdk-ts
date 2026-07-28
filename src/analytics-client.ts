import {
  DEFAULT_INGEST_LIMITS,
  ONBOARDING_EVENTS,
  ONBOARDING_SURVEY_EVENTS,
  PAYWALL_EVENTS,
  PURCHASE_EVENTS,
  type OnboardingEventName,
  type OnboardingSurveyEventName,
  type PaywallJourneyEventName,
} from './sdk-contract.js';
import { validateIngestBatch, type IngestBatch } from './ingest-validation.js';
import {
  DEFAULT_COLLECTOR_ENDPOINT,
  DEFAULT_COOKIE_MAX_AGE_SECONDS,
  FEEDBACK_MESSAGE_MAX_LENGTH,
  DEFAULT_SCREEN_VIEW_DEDUPE_WINDOW_MS,
  DEFAULT_SESSION_TIMEOUT_MS,
  DEVICE_ID_KEY,
  LAST_SEEN_KEY,
  ONBOARDING_STEP_VIEW_STATE_KEY,
  SESSION_EVENT_SEQ_PREFIX,
  SESSION_ID_KEY,
} from './constants.js';
import {
  combineStorageAdapters,
  detectDefaultAppVersion,
  detectDefaultPlatform,
  detectRuntimeEnv,
  nowIso,
  randomId,
  readStorageAsync,
  readStorageSync,
  removeStorageSync,
  resolveBrowserStorageAdapter,
  resolveCookieStorageAdapter,
  sanitizeProperties,
  toStableKey,
  writeStorageSync,
} from './helpers.js';
import { sanitizeSurveyResponseInput } from './survey.js';
import type {
  AnalyticsConsentState,
  AnalyticsClientOptions,
  FeedbackClientOptions,
  FeedbackMetadata,
  FeedbackSubmissionInput,
  FeedbackSubmissionResult,
  AnalyticsDropDiagnostic,
  AnalyticsDropHandler,
  AnalyticsDropReason,
  AnalyticsFlushOptions,
  AnalyticsFlushResult,
  AnalyticsIngestError,
  AnalyticsIngestErrorHandler,
  AnalyticsStorageAdapter,
  EventContext,
  EventProperties,
  IdentityTrackingMode,
  OnboardingEventProperties,
  OnboardingStepTracker,
  OnboardingTracker,
  OnboardingTrackerDefaults,
  OnboardingTrackerSurveyInput,
  OnboardingSurveyResponseInput,
  PaywallEventProperties,
  PaywallTracker,
  PaywallTrackerDefaults,
  PaywallTrackerProperties,
  QueuedEvent,
  SetConsentOptions,
} from './types.js';

const DEFAULT_CONSENT_STORAGE_KEY = 'analyticscli:consent:v1';
const DEFAULT_FEEDBACK_SERVICE_URL = 'https://api.analyticscli.com';
const AUTH_FAILURE_FLUSH_PAUSE_MS = 60_000;
const DEFAULT_MAX_QUEUE_SIZE = 1000;
const MAX_CONFIGURED_QUEUE_SIZE = 100_000;
const DEFAULT_FLUSH_ALL_TIMEOUT_MS = 10_000;

const resolveDefaultOsNameFromPlatform = (platform: string | undefined): string | undefined => {
  if (!platform) {
    return undefined;
  }
  if (platform === 'ios') {
    return 'iOS';
  }
  if (platform === 'android') {
    return 'Android';
  }
  if (platform === 'web') {
    return 'Web';
  }
  if (platform === 'mac') {
    return 'macOS';
  }
  if (platform === 'windows') {
    return 'Windows';
  }
  return undefined;
};

type IngestErrorBody = {
  error?: {
    code?: unknown;
    message?: unknown;
  };
};

type IngestSendErrorInput = {
  message: string;
  retryable: boolean;
  timedOut?: boolean;
  attempts: number;
  status?: number;
  errorCode?: string;
  serverMessage?: string;
  requestId?: string;
  cause?: unknown;
};

type BrowserFlushEvent = 'beforeunload' | 'pagehide' | 'visibilitychange';

type BrowserLifecycleHandler = {
  target: Window;
  eventName: BrowserFlushEvent;
  handler: EventListener;
};

type DeferredEvent = {
  eventName: string;
  action: () => void;
};

type PreparedIngestBatch = {
  events: QueuedEvent[];
  payload: IngestBatch | null;
  serializedBody: string | null;
};

class IngestSendError extends Error {
  public readonly retryable: boolean;
  public readonly timedOut: boolean;
  public readonly attempts: number;
  public readonly status?: number;
  public readonly errorCode?: string;
  public readonly serverMessage?: string;
  public readonly requestId?: string;

  constructor(input: IngestSendErrorInput) {
    super(input.message);
    this.name = 'IngestSendError';
    this.retryable = input.retryable;
    this.timedOut = input.timedOut ?? false;
    this.attempts = input.attempts;
    this.status = input.status;
    this.errorCode = input.errorCode;
    this.serverMessage = input.serverMessage;
    this.requestId = input.requestId;
    if (input.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = input.cause;
    }
  }
}

export class AnalyticsClient {
  private readonly apiKey: string;
  private readonly hasIngestConfig: boolean;
  private readonly endpoint: string;
  private readonly batchSize: number;
  private readonly maxQueueSize: number;
  private readonly flushIntervalMs: number;
  private readonly maxRetries: number;
  private readonly debug: boolean;
  private readonly onIngestError: AnalyticsIngestErrorHandler | null;
  private readonly onEventsDropped: AnalyticsDropHandler | null;
  private readonly platform: string | undefined;
  private readonly projectSurface: string | undefined;
  private readonly appVersion: string | undefined;
  private readonly identityTrackingMode: IdentityTrackingMode;
  private readonly feedbackConfig: FeedbackClientOptions | null;
  private context: EventContext;
  private readonly configuredStorage: AnalyticsStorageAdapter | null;
  private storage: AnalyticsStorageAdapter | null;
  private storageReadsAreAsync: boolean;
  private readonly persistConsentState: boolean;
  private readonly consentStorageKey: string;
  private readonly hasExplicitInitialConsent: boolean;
  private readonly hasExplicitInitialFullTrackingConsent: boolean;
  private readonly sessionTimeoutMs: number;
  private readonly dedupeOnboardingStepViewsPerSession: boolean;
  private readonly dedupeScreenViewsPerSession: boolean;
  private readonly dedupeOnboardingScreenStepViewOverlapsPerSession: boolean;
  private readonly screenViewDedupeWindowMs: number;
  private readonly runtimeEnv: 'production' | 'development';
  private readonly hasExplicitAnonId: boolean;
  private readonly hasExplicitSessionId: boolean;
  private readonly hydrationPromise: Promise<void>;
  private readonly browserLifecycleHandlers: BrowserLifecycleHandler[] = [];

  private queue: QueuedEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private activeFlushPromise: Promise<void> | null = null;
  private activeFlushAbortController: AbortController | null = null;
  private inFlightBatch: QueuedEvent[] = [];
  private consentGranted = true;
  private fullTrackingConsentGranted = false;
  private userId: string | null = null;
  private anonId: string;
  private sessionId: string;
  private sessionEventSeq = 0;
  private inMemoryLastSeenMs = Date.now();
  private hydrationCompleted = false;
  private deferredEventsBeforeHydration: DeferredEvent[] = [];
  private onboardingStepViewStateSessionId: string | null = null;
  private onboardingStepViewsSeen = new Set<string>();
  private onboardingScreenStepViewOverlapSessionId: string | null = null;
  private onboardingStepViewsSeenAtMs = new Map<string, number>();
  private lastScreenViewDedupeSessionId: string | null = null;
  private lastScreenViewDedupeKey: string | null = null;
  private lastScreenViewDedupeTsMs = 0;
  private flushPausedUntilMs = 0;
  private retryableFailureCount = 0;
  private flushTimeoutCount = 0;

  constructor(options: AnalyticsClientOptions) {
    const normalizedOptions = this.normalizeOptions(options);

    this.apiKey = this.readRequiredStringOption(normalizedOptions.apiKey);
    this.hasIngestConfig = Boolean(this.apiKey);
    if (!this.hasIngestConfig) {
      this.reportMissingApiKey();
    }
    this.endpoint = (
      this.readRequiredStringOption(normalizedOptions.endpoint) || DEFAULT_COLLECTOR_ENDPOINT
    ).replace(/\/$/, '');
    this.batchSize = this.normalizePositiveIntegerOption(
      normalizedOptions.batchSize,
      20,
      DEFAULT_INGEST_LIMITS.maxBatchSize,
    );
    this.maxQueueSize = this.normalizePositiveIntegerOption(
      normalizedOptions.maxQueueSize,
      DEFAULT_MAX_QUEUE_SIZE,
      MAX_CONFIGURED_QUEUE_SIZE,
    );
    this.flushIntervalMs = normalizedOptions.flushIntervalMs ?? 5000;
    this.maxRetries = normalizedOptions.maxRetries ?? 4;
    this.debug = normalizedOptions.debug ?? false;
    this.onIngestError =
      typeof normalizedOptions.onIngestError === 'function'
        ? normalizedOptions.onIngestError
        : null;
    this.onEventsDropped =
      typeof normalizedOptions.onEventsDropped === 'function'
        ? normalizedOptions.onEventsDropped
        : null;
    this.platform =
      this.normalizePlatformOption(normalizedOptions.platform) ?? detectDefaultPlatform();
    this.projectSurface = this.normalizeProjectSurfaceOption(normalizedOptions.projectSurface);
    this.appVersion =
      this.readRequiredStringOption(normalizedOptions.appVersion) || detectDefaultAppVersion();
    this.identityTrackingMode = this.resolveIdentityTrackingModeOption(normalizedOptions);
    this.feedbackConfig = this.normalizeFeedbackConfig(normalizedOptions.feedback);
    const initialContext = { ...(normalizedOptions.context ?? {}) };
    const hasExplicitOsName = this.readRequiredStringOption(initialContext.osName).length > 0;
    this.context = {
      ...initialContext,
      osName: hasExplicitOsName
        ? initialContext.osName
        : (resolveDefaultOsNameFromPlatform(this.platform) ?? initialContext.osName),
    };
    this.runtimeEnv = detectRuntimeEnv();
    this.persistConsentState = normalizedOptions.persistConsentState ?? false;
    this.consentStorageKey =
      this.readRequiredStringOption(normalizedOptions.consentStorageKey) ||
      DEFAULT_CONSENT_STORAGE_KEY;
    this.hasExplicitInitialConsent = typeof normalizedOptions.initialConsentGranted === 'boolean';
    this.hasExplicitInitialFullTrackingConsent =
      typeof normalizedOptions.initialFullTrackingConsentGranted === 'boolean';
    this.sessionTimeoutMs = normalizedOptions.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
    this.dedupeOnboardingStepViewsPerSession =
      normalizedOptions.dedupeOnboardingStepViewsPerSession ?? true;
    this.dedupeScreenViewsPerSession = normalizedOptions.dedupeScreenViewsPerSession ?? true;
    this.dedupeOnboardingScreenStepViewOverlapsPerSession =
      normalizedOptions.dedupeOnboardingScreenStepViewOverlapsPerSession ?? true;
    this.screenViewDedupeWindowMs = this.normalizeScreenViewDedupeWindowMs(
      normalizedOptions.screenViewDedupeWindowMs,
    );
    this.configuredStorage = this.resolveConfiguredStorage(normalizedOptions);

    const persistedFullTrackingConsent = this.readPersistedConsentSync(this.configuredStorage);
    const configuredFullTrackingConsent = normalizedOptions.initialFullTrackingConsentGranted;
    const initialFullTrackingConsentGranted =
      typeof configuredFullTrackingConsent === 'boolean'
        ? configuredFullTrackingConsent
        : (persistedFullTrackingConsent ?? false);
    this.fullTrackingConsentGranted =
      this.identityTrackingMode === 'always_on' || initialFullTrackingConsentGranted;

    this.storage = this.isFullTrackingActive() ? this.configuredStorage : null;
    this.storageReadsAreAsync = this.detectAsyncStorageReads();

    const providedAnonId = this.isFullTrackingActive()
      ? this.readRequiredStringOption(normalizedOptions.anonId)
      : '';
    const providedSessionId = this.isFullTrackingActive()
      ? this.readRequiredStringOption(normalizedOptions.sessionId)
      : '';
    this.hasExplicitAnonId = Boolean(providedAnonId);
    this.hasExplicitSessionId = Boolean(providedSessionId);

    this.anonId = providedAnonId || this.ensureDeviceId();
    this.sessionId = providedSessionId || this.ensureSessionId();
    this.sessionEventSeq = this.readSessionEventSeq(this.sessionId);
    const persistedConsent = this.readPersistedConsentSync(this.storage);
    const configuredConsent = normalizedOptions.initialConsentGranted;
    const initialConsentGranted =
      typeof configuredConsent === 'boolean'
        ? configuredConsent
        : (persistedConsent ?? this.hasIngestConfig);
    this.consentGranted = this.hasIngestConfig && initialConsentGranted;
    if (this.hasExplicitInitialConsent && this.persistConsentState) {
      this.writePersistedConsent(this.storage, this.consentGranted);
    }
    if (this.hasExplicitInitialFullTrackingConsent && this.persistConsentState) {
      this.writePersistedConsent(this.configuredStorage, this.fullTrackingConsentGranted);
    }

    this.hydrationPromise = this.hydrateIdentityFromStorage();
    this.enqueueInitialSessionStart();
    this.startAutoFlush();
  }

  /**
   * Resolves once client initialization work completes.
   */
  public async ready(): Promise<void> {
    await this.hydrationPromise;
  }

  /**
   * Enables or disables event collection.
   * When disabled, queued events are dropped immediately.
   */
  public setConsent(granted: boolean, options: SetConsentOptions = {}): void {
    if (granted && !this.hasIngestConfig) {
      this.log('Ignoring consent opt-in because `apiKey` is missing');
      return;
    }

    this.consentGranted = granted;
    if ((options.persist ?? true) && this.persistConsentState) {
      this.writePersistedConsent(this.storage, granted);
    }
    if (!granted && this.identityTrackingMode === 'consent_gated') {
      this.setFullTrackingConsent(false, options);
    }
    if (!granted) {
      this.abortActiveFlush();
      this.queue = [];
      this.deferredEventsBeforeHydration = [];
    }
  }

  public optIn(options?: SetConsentOptions): void {
    this.setConsent(true, options);
  }

  public optOut(options?: SetConsentOptions): void {
    this.setConsent(false, options);
  }

  public getConsent(): boolean {
    return this.consentGranted;
  }

  public getConsentState(): AnalyticsConsentState {
    const persisted = this.readPersistedConsentSync(this.storage);
    if (persisted === true) {
      return 'granted';
    }
    if (persisted === false) {
      return 'denied';
    }
    return this.consentGranted ? 'granted' : 'unknown';
  }

  /**
   * Sets or updates shared event context fields (useful for mobile device/app metadata).
   */
  public setContext(context: EventContext): void {
    this.context = {
      ...this.context,
      ...context,
    };
  }

  private enqueueInitialSessionStart(): void {
    if (!this.consentGranted) {
      return;
    }

    if (this.shouldDeferEventsUntilHydrated()) {
      this.deferEventUntilHydrated('session_start', () => {
        this.enqueueInitialSessionStart();
      });
      return;
    }

    const sessionId = this.getSessionId();
    this.enqueue({
      eventId: randomId(),
      eventName: 'session_start',
      ts: nowIso(),
      sessionId,
      anonId: this.anonId,
      userId: this.getEventUserId(),
      properties: this.withRuntimeMetadata({ source: 'sdk_mount' }, sessionId),
      privacyMode: this.resolveEventPrivacyMode(),
      platform: this.platform,
      projectSurface: this.projectSurface,
      appVersion: this.appVersion,
      ...this.withEventContext(),
      type: 'track',
    });
  }

  /**
   * Associates following events with a known user id.
   * Anonymous history remains linked by anonId/sessionId.
   */
  public identify(userId: string, traits?: EventProperties): void {
    const normalizedUserId = this.readRequiredStringOption(userId);
    if (!normalizedUserId) {
      return;
    }
    if (!this.isFullTrackingActive()) {
      this.log('Ignoring identify() because identity persistence is not enabled');
      return;
    }

    this.userId = normalizedUserId;

    if (!this.consentGranted) {
      return;
    }

    const normalizedTraits = sanitizeProperties(traits);
    if (this.shouldDeferEventsUntilHydrated()) {
      this.deferEventUntilHydrated('identify', () => {
        this.identify(normalizedUserId, normalizedTraits);
      });
      return;
    }

    const sessionId = this.getSessionId();
    this.enqueue({
      eventId: randomId(),
      eventName: 'identify',
      ts: nowIso(),
      sessionId,
      anonId: this.anonId,
      userId: normalizedUserId,
      properties: this.withRuntimeMetadata(normalizedTraits, sessionId),
      privacyMode: this.resolveEventPrivacyMode(),
      platform: this.platform,
      projectSurface: this.projectSurface,
      appVersion: this.appVersion,
      ...this.withEventContext(),
      type: 'identify',
    });
  }

  /**
   * Convenience helper for login/logout boundaries.
   * - pass a non-empty user id to emit an identify event
   * - pass null/undefined/empty string to clear user linkage
   */
  public setUser(userId: string | null | undefined, traits?: EventProperties): void {
    const normalizedUserId = this.readRequiredStringOption(userId);
    if (!normalizedUserId) {
      this.clearUser();
      return;
    }
    this.identify(normalizedUserId, traits);
  }

  /**
   * Sets consent specifically for persistent identity tracking.
   * In `consent_gated` mode this toggles strict-vs-full identity behavior while generic event tracking can stay enabled.
   */
  public setFullTrackingConsent(granted: boolean, options: SetConsentOptions = {}): void {
    if (this.identityTrackingMode === 'strict') {
      return;
    }
    if (this.identityTrackingMode === 'always_on') {
      return;
    }

    const wasFullTrackingActive = this.isFullTrackingActive();
    const previousSessionId = this.sessionId;
    this.fullTrackingConsentGranted = granted;
    if ((options.persist ?? true) && this.persistConsentState) {
      this.writePersistedConsent(this.configuredStorage, granted);
    }
    if (!granted && wasFullTrackingActive) {
      removeStorageSync(this.configuredStorage, DEVICE_ID_KEY);
      removeStorageSync(this.configuredStorage, SESSION_ID_KEY);
      removeStorageSync(this.configuredStorage, LAST_SEEN_KEY);
      removeStorageSync(this.configuredStorage, `${SESSION_EVENT_SEQ_PREFIX}${previousSessionId}`);
      removeStorageSync(this.configuredStorage, ONBOARDING_STEP_VIEW_STATE_KEY);
      this.anonId = randomId();
      this.sessionId = randomId();
      this.sessionEventSeq = 0;
      this.inMemoryLastSeenMs = Date.now();
      this.resetSessionScopedDedupeState();
    }
    this.applyIdentityTrackingState();
  }

  public optInFullTracking(options?: SetConsentOptions): void {
    this.setFullTrackingConsent(true, options);
  }

  public optOutFullTracking(options?: SetConsentOptions): void {
    this.setFullTrackingConsent(false, options);
  }

  public isFullTrackingEnabled(): boolean {
    return this.isFullTrackingActive();
  }

  /**
   * Clears the current identified user from in-memory SDK state.
   */
  public clearUser(): void {
    this.userId = null;
  }

  /**
   * Sends a generic product event.
   */
  public track(eventName: string, properties?: EventProperties): void {
    if (!this.consentGranted) {
      return;
    }

    if (this.shouldDeferEventsUntilHydrated()) {
      const deferredProperties = sanitizeProperties(properties);
      this.deferEventUntilHydrated(eventName, () => {
        this.track(eventName, deferredProperties);
      });
      return;
    }

    const sessionId = this.getSessionId();
    this.resetOnboardingDedupeStateOnFlowStart(eventName, sessionId);
    if (this.shouldDropOnboardingStepView(eventName, properties, sessionId)) {
      return;
    }
    this.dedupeOnboardingScreenStepViewOverlap(eventName, properties, sessionId);
    this.enqueue({
      eventId: randomId(),
      eventName,
      ts: nowIso(),
      sessionId,
      anonId: this.anonId,
      userId: this.getEventUserId(),
      properties: this.withRuntimeMetadata(properties, sessionId),
      privacyMode: this.resolveEventPrivacyMode(),
      platform: this.platform,
      projectSurface: this.projectSurface,
      appVersion: this.appVersion,
      ...this.withEventContext(),
      type: 'track',
    });
  }

  /**
   * Sends a typed onboarding event with conventional onboarding metadata.
   */
  public trackOnboardingEvent(
    eventName: OnboardingEventName,
    properties?: OnboardingEventProperties,
  ): void {
    this.track(eventName, properties);
  }

  /**
   * Creates a scoped onboarding tracker that applies shared flow properties to every onboarding event.
   * This reduces app-side boilerplate while keeping each emitted event fully self-describing.
   */
  public createOnboardingTracker(defaults: OnboardingTrackerDefaults): OnboardingTracker {
    const {
      surveyKey: rawDefaultSurveyKey,
      appVersion: rawDefaultAppVersion,
      isNewUser: rawDefaultIsNewUser,
      onboardingFlowId: rawDefaultFlowId,
      onboardingFlowVersion: rawDefaultFlowVersion,
      stepKey: rawDefaultStepKey,
      stepIndex: rawDefaultStepIndex,
      stepCount: rawDefaultStepCount,
      ...defaultExtraProperties
    } = defaults;
    const defaultSurveyKey = this.readPropertyAsString(rawDefaultSurveyKey);
    const defaultAppVersion = this.readPropertyAsString(rawDefaultAppVersion);
    const defaultIsNewUser =
      typeof rawDefaultIsNewUser === 'boolean' ? rawDefaultIsNewUser : undefined;
    const defaultFlowId = this.readPropertyAsString(rawDefaultFlowId);
    const defaultFlowVersion =
      typeof rawDefaultFlowVersion === 'string' || typeof rawDefaultFlowVersion === 'number'
        ? rawDefaultFlowVersion
        : undefined;
    const defaultStepKey = this.readPropertyAsString(rawDefaultStepKey);
    const defaultStepIndex = this.readPropertyAsStepIndex(rawDefaultStepIndex);
    const defaultStepCount = this.readPropertyAsStepIndex(rawDefaultStepCount);

    const mergeEventProperties = (
      properties?: OnboardingEventProperties,
    ): OnboardingEventProperties => ({
      ...defaultExtraProperties,
      appVersion: defaultAppVersion,
      isNewUser: defaultIsNewUser,
      onboardingFlowId: defaultFlowId,
      onboardingFlowVersion: defaultFlowVersion,
      stepKey: defaultStepKey,
      stepIndex: defaultStepIndex,
      stepCount: defaultStepCount,
      ...(properties ?? {}),
    });

    const track = (eventName: OnboardingEventName, properties?: OnboardingEventProperties) => {
      this.trackOnboardingEvent(eventName, mergeEventProperties(properties));
    };

    const surveyResponse = (input: OnboardingTrackerSurveyInput) => {
      this.trackOnboardingSurveyResponse({
        ...input,
        surveyKey: input.surveyKey ?? defaultSurveyKey ?? defaultFlowId ?? 'onboarding',
        appVersion: input.appVersion ?? defaultAppVersion,
        isNewUser: input.isNewUser ?? defaultIsNewUser,
        onboardingFlowId: input.onboardingFlowId ?? defaultFlowId,
        onboardingFlowVersion: input.onboardingFlowVersion ?? defaultFlowVersion,
        stepKey: input.stepKey ?? defaultStepKey,
        stepIndex: input.stepIndex ?? defaultStepIndex,
        stepCount: input.stepCount ?? defaultStepCount,
        properties: {
          ...defaultExtraProperties,
          ...(input.properties ?? {}),
        },
      });
    };

    const step = (
      stepKey: string,
      stepIndex: number,
      properties?: Omit<OnboardingEventProperties, 'stepKey' | 'stepIndex'>,
    ): OnboardingStepTracker => {
      const stepProps = {
        ...(properties ?? {}),
        stepKey,
        stepIndex,
      } satisfies OnboardingEventProperties;

      return {
        view: (overrides) =>
          track(ONBOARDING_EVENTS.STEP_VIEW, { ...stepProps, ...(overrides ?? {}) }),
        complete: (overrides) =>
          track(ONBOARDING_EVENTS.STEP_COMPLETE, { ...stepProps, ...(overrides ?? {}) }),
        surveyResponse: (input) =>
          surveyResponse({
            ...input,
            stepKey,
            stepIndex,
          }),
      };
    };

    return {
      track,
      start: (properties) => track(ONBOARDING_EVENTS.START, properties),
      stepView: (properties) => track(ONBOARDING_EVENTS.STEP_VIEW, properties),
      stepComplete: (properties) => track(ONBOARDING_EVENTS.STEP_COMPLETE, properties),
      complete: (properties) => track(ONBOARDING_EVENTS.COMPLETE, properties),
      skip: (properties) => track(ONBOARDING_EVENTS.SKIP, properties),
      surveyResponse,
      step,
    };
  }

  /**
   * Creates a scoped paywall tracker that applies shared paywall defaults to every journey event.
   * Useful when a flow has a stable `source`, `paywallId`, `offeringId`, or experiment metadata.
   * Reuse the returned tracker for that flow context; creating a new tracker per event resets
   * paywall entry correlation.
   */
  public createPaywallTracker(defaults: PaywallTrackerDefaults): PaywallTracker {
    const {
      source: rawDefaultSource,
      offeringId: rawDefaultOfferingId,
      ...defaultProperties
    } = defaults;
    delete (defaultProperties as EventProperties & { offering?: unknown }).offering;
    const defaultSource = this.readRequiredStringOption(rawDefaultSource);
    const defaultOfferingId = this.readRequiredStringOption(rawDefaultOfferingId);
    let currentPaywallEntryId: string | undefined;
    let currentOfferingId: string | undefined = defaultOfferingId || undefined;
    if (!defaultSource) {
      this.log('createPaywallTracker() called without a valid default `source`');
    }
    if (!defaultOfferingId) {
      this.log(
        'createPaywallTracker() called without default `offeringId`; set it when available for better paywall analytics',
      );
    }

    const mergeProperties = (properties?: PaywallTrackerProperties): PaywallEventProperties => {
      const mergedSource = this.readRequiredStringOption(
        this.readPropertyAsString(properties?.source) ?? defaultSource,
      );
      const mergedOfferingId = this.readRequiredStringOption(
        this.readPropertyAsString(properties?.offeringId) ?? currentOfferingId ?? defaultOfferingId,
      );

      const merged: PaywallEventProperties = {
        ...defaultProperties,
        ...(properties ?? {}),
        source: mergedSource,
      };
      delete (merged as EventProperties & { offering?: unknown }).offering;

      if (mergedOfferingId) {
        merged.offeringId = mergedOfferingId;
      } else {
        delete merged.offeringId;
      }

      return merged;
    };

    const track = (eventName: PaywallJourneyEventName, properties?: PaywallTrackerProperties) => {
      const mergedProperties = mergeProperties(properties);
      delete mergedProperties.paywallEntryId;

      if (eventName === PAYWALL_EVENTS.SHOWN) {
        currentPaywallEntryId = randomId();
        currentOfferingId = mergedProperties.offeringId;
        mergedProperties.paywallEntryId = currentPaywallEntryId;
      } else {
        if (currentPaywallEntryId) {
          mergedProperties.paywallEntryId = currentPaywallEntryId;
        }
        if (properties?.offeringId === undefined && currentOfferingId) {
          mergedProperties.offeringId = currentOfferingId;
        }
      }

      this.sendPaywallEvent(eventName, mergedProperties, {
        allowPaywallEntryId: true,
      });
    };

    return {
      track,
      shown: (properties) => track(PAYWALL_EVENTS.SHOWN, properties),
      skip: (properties) => track(PAYWALL_EVENTS.SKIP, properties),
      purchaseStarted: (properties) => track(PURCHASE_EVENTS.STARTED, properties),
      purchaseSuccess: (properties) => track(PURCHASE_EVENTS.SUCCESS, properties),
      purchaseFailed: (properties) => track(PURCHASE_EVENTS.FAILED, properties),
      purchaseCancel: (properties) => track(PURCHASE_EVENTS.CANCEL, properties),
    };
  }

  /**
   * Sends a typed paywall/purchase journey event.
   * Direct calls ignore `paywallEntryId`; use `createPaywallTracker(...)` for entry correlation.
   */
  public trackPaywallEvent(
    eventName: PaywallJourneyEventName,
    properties: PaywallEventProperties,
  ): void {
    this.sendPaywallEvent(eventName, properties, {
      allowPaywallEntryId: false,
    });
  }

  private sendPaywallEvent(
    eventName: PaywallJourneyEventName,
    properties: PaywallEventProperties,
    options: { allowPaywallEntryId: boolean },
  ): void {
    const normalizedSource = this.readRequiredStringOption(
      this.readPropertyAsString(properties?.source),
    );
    if (!normalizedSource) {
      this.log('Dropping paywall event without required `source` property', { eventName });
      return;
    }

    const normalizedProperties = {
      ...properties,
      source: normalizedSource,
    };
    delete (normalizedProperties as EventProperties & { offering?: unknown }).offering;
    const normalizedOfferingId = this.readRequiredStringOption(
      this.readPropertyAsString(properties?.offeringId),
    );
    if (normalizedOfferingId) {
      normalizedProperties.offeringId = normalizedOfferingId;
    } else {
      delete normalizedProperties.offeringId;
    }

    if (!options.allowPaywallEntryId && normalizedProperties.paywallEntryId !== undefined) {
      this.log(
        'Ignoring `paywallEntryId` in direct trackPaywallEvent(); use createPaywallTracker()',
        { eventName },
      );
      delete normalizedProperties.paywallEntryId;
    }

    this.track(eventName, normalizedProperties);
  }

  /**
   * Sends anonymized onboarding survey responses using canonical event naming.
   * Free text and raw numeric values are reduced to coarse buckets.
   */
  public trackOnboardingSurveyResponse(
    input: OnboardingSurveyResponseInput,
    eventName: OnboardingSurveyEventName = ONBOARDING_SURVEY_EVENTS.RESPONSE,
  ): void {
    const rows = sanitizeSurveyResponseInput(input);
    for (const properties of rows) {
      this.track(eventName, properties);
    }
  }

  /**
   * Sends a screen-view style event using the `screen:<name>` convention.
   */
  public screen(name: string, properties?: EventProperties): void {
    if (!this.consentGranted) {
      return;
    }

    const normalizedScreenName = this.normalizeScreenName(name);
    if (!normalizedScreenName) {
      this.log('Dropping screen event with invalid name', { name });
      return;
    }

    if (this.shouldDeferEventsUntilHydrated()) {
      const deferredProperties = sanitizeProperties(properties);
      this.deferEventUntilHydrated(`screen:${normalizedScreenName}`, () => {
        this.screen(normalizedScreenName, deferredProperties);
      });
      return;
    }

    const sessionId = this.getSessionId();
    if (this.shouldDropScreenView(normalizedScreenName, properties, sessionId)) {
      return;
    }
    if (this.shouldDropOnboardingScreenViewOverlap(normalizedScreenName, properties, sessionId)) {
      return;
    }
    this.enqueue({
      eventId: randomId(),
      eventName: `screen:${normalizedScreenName}`,
      ts: nowIso(),
      sessionId,
      anonId: this.anonId,
      userId: this.getEventUserId(),
      properties: this.withRuntimeMetadata(properties, sessionId),
      privacyMode: this.resolveEventPrivacyMode(),
      platform: this.platform,
      projectSurface: this.projectSurface,
      appVersion: this.appVersion,
      ...this.withEventContext(),
      type: 'screen',
    });
  }

  /**
   * Alias of `screen(...)` for web-style naming.
   */
  public page(name: string, properties?: EventProperties): void {
    this.screen(name, properties);
  }

  /**
   * Sends tenant feedback to the configured feedback endpoint and optionally tracks a lightweight analytics event.
   * The raw feedback message is never added to analytics events.
   */
  public async submitFeedback(input: FeedbackSubmissionInput): Promise<FeedbackSubmissionResult> {
    const message = this.readRequiredStringOption(input?.message);
    if (!message) {
      throw new Error('Feedback message must not be empty.');
    }
    if (message.length > FEEDBACK_MESSAGE_MAX_LENGTH) {
      throw new Error(
        `Feedback message must not exceed ${FEEDBACK_MESSAGE_MAX_LENGTH} characters.`,
      );
    }

    const config = this.feedbackConfig;
    const locationId =
      this.readRequiredStringOption(input.locationId) ||
      this.readRequiredStringOption(config?.locationId) ||
      'feedback/unknown';
    const surface =
      this.normalizeProjectSurfaceOption(input.surface) ||
      this.normalizeProjectSurfaceOption(config?.surface) ||
      this.projectSurface ||
      this.platform ||
      'app';
    const originName =
      this.readRequiredStringOption(input.originName) ||
      this.readRequiredStringOption(config?.originName) ||
      null;
    const category =
      this.readRequiredStringOption(input.category || 'other').toLowerCase() || 'other';
    const context = this.readRequiredStringOption(input.context);
    const metadata = this.mergeFeedbackMetadata(config?.metadata, input.metadata, {
      category,
      ...(context ? { context } : {}),
    });

    let rating: number | undefined;
    if (input.rating !== undefined) {
      const parsedRating = Number(input.rating);
      if (!Number.isInteger(parsedRating) || parsedRating < 1 || parsedRating > 5) {
        throw new Error('Feedback rating must be an integer between 1 and 5.');
      }
      rating = parsedRating;
    }

    const shouldTrackEvents = config?.trackEvents !== false;
    const userId =
      this.readRequiredStringOption(input.userId) ||
      this.readRequiredStringOption(config?.userId) ||
      this.getEventUserId() ||
      this.anonId;

    const serviceUrl = this.readRequiredStringOption(config?.serviceUrl) || DEFAULT_FEEDBACK_SERVICE_URL;
    const feedbackApiKey = this.readRequiredStringOption(config?.apiKey) || this.apiKey;

    if (!serviceUrl || !feedbackApiKey) {
      if (shouldTrackEvents) {
        this.track('feedback:submitted', {
          category,
          ...(rating !== undefined ? { rating } : {}),
          locationId,
          ...(originName ? { originName } : {}),
          feedbackSurface: surface,
          feedbackDelivery: 'analytics_only',
        });
      }

      return {
        ok: true,
        delivery: 'analytics_only',
        locationId,
        surface,
        originName,
      };
    }

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeoutMs = config?.timeoutMs ?? 10_000;
    const timer =
      controller && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => controller.abort(), timeoutMs)
        : null;

    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };
      if (feedbackApiKey) {
        headers[this.readRequiredStringOption(config?.apiKeyHeader) || 'x-feedback-key'] =
          feedbackApiKey;
      }

      const response = await fetch(`${serviceUrl.replace(/\/$/, '')}/v1/feedback`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...(config?.appId ? { appId: config.appId } : {}),
          userId,
          feedback: message,
          category,
          ...(rating !== undefined ? { rating } : {}),
          ...(context ? { context } : {}),
          location: locationId,
          appSurface: surface,
          ...(originName ? { originName } : {}),
          metadata: {
            ...metadata,
            ...(rating !== undefined ? { rating } : {}),
          },
        }),
        ...(controller ? { signal: controller.signal } : {}),
      });

      if (!response.ok) {
        const errorPayload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        const nestedError =
          errorPayload.error &&
          typeof errorPayload.error === 'object' &&
          !Array.isArray(errorPayload.error)
            ? (errorPayload.error as Record<string, unknown>)
            : null;
        const details =
          nestedError?.details &&
          typeof nestedError.details === 'object' &&
          !Array.isArray(nestedError.details)
            ? (nestedError.details as Record<string, unknown>)
            : null;
        const issues = Array.isArray(details?.issues) ? details.issues : [];
        const firstIssue =
          issues[0] && typeof issues[0] === 'object' && !Array.isArray(issues[0])
            ? (issues[0] as Record<string, unknown>)
            : null;
        const errorMessage =
          (typeof firstIssue?.message === 'string' && firstIssue.message) ||
          (typeof nestedError?.message === 'string' && nestedError.message) ||
          (typeof errorPayload.error === 'string' && errorPayload.error) ||
          `Feedback submission failed with status ${response.status}`;
        throw new Error(errorMessage);
      }

      if (shouldTrackEvents) {
        this.track('feedback:submitted', {
          category,
          ...(rating !== undefined ? { rating } : {}),
          locationId,
          ...(originName ? { originName } : {}),
          feedbackSurface: surface,
          feedbackDelivery: 'external_feedback_service',
        });
      }

      return {
        ok: true,
        delivery: 'external_feedback_service',
        serviceUrl,
        appId: config?.appId || undefined,
        locationId,
        surface,
        originName,
      };
    } catch (error) {
      if (shouldTrackEvents) {
        this.track('feedback:submission_failed', {
          category,
          ...(rating !== undefined ? { rating } : {}),
          locationId,
          ...(originName ? { originName } : {}),
          feedbackSurface: surface,
        });
      }
      throw error;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Flushes current event queue to the ingest endpoint.
   */
  public flush(): Promise<void> {
    return this.startFlush();
  }

  /**
   * Drains all currently queued events, one bounded ingest batch at a time.
   *
   * Unlike `flush()`, this keeps flushing until the queue is empty or `timeoutMs`
   * elapses. Events from retryable failures remain queued; permanently rejected
   * batches are dropped and surfaced through delivery diagnostics.
   */
  public async flushAll(options: AnalyticsFlushOptions = {}): Promise<AnalyticsFlushResult> {
    const timeoutMs = this.normalizeNonNegativeIntegerOption(
      options.timeoutMs,
      DEFAULT_FLUSH_ALL_TIMEOUT_MS,
    );
    const deadlineMs = Date.now() + timeoutMs;

    while (this.getPendingEventCount() > 0) {
      if (Date.now() >= deadlineMs) {
        this.abortActiveFlush();
        return this.createFlushResult('timed_out');
      }

      if (!this.activeFlushPromise && Date.now() < this.flushPausedUntilMs) {
        return this.createFlushResult('auth_pause');
      }

      const retryableFailuresBeforeFlush = this.retryableFailureCount;
      const flushTimeoutsBeforeFlush = this.flushTimeoutCount;
      const flushCompleted = await this.waitForPromiseUntil(
        this.startFlush(deadlineMs),
        deadlineMs,
      );
      if (!flushCompleted) {
        this.abortActiveFlush();
        return this.createFlushResult('timed_out');
      }
      if (this.flushTimeoutCount > flushTimeoutsBeforeFlush) {
        return this.createFlushResult('timed_out');
      }
      if (this.retryableFailureCount > retryableFailuresBeforeFlush) {
        return this.createFlushResult('retryable_failure');
      }
    }

    return this.createFlushResult('drained');
  }

  private startFlush(deadlineMs?: number): Promise<void> {
    if (this.activeFlushPromise) {
      return this.activeFlushPromise;
    }

    const operation = this.performFlush(deadlineMs).finally(() => {
      this.activeFlushPromise = null;
    });
    this.activeFlushPromise = operation;
    return operation;
  }

  private async performFlush(deadlineMs?: number): Promise<void> {
    if (!this.hydrationCompleted && this.deferredEventsBeforeHydration.length > 0) {
      await this.hydrationPromise;
    }

    if (this.queue.length === 0 || !this.consentGranted) {
      return;
    }
    if (Date.now() < this.flushPausedUntilMs) {
      return;
    }

    const candidates = this.queue.splice(0, this.batchSize);
    const prepared = this.prepareIngestBatch(candidates);
    if (!prepared.payload || !prepared.serializedBody || prepared.events.length === 0) {
      return;
    }

    this.inFlightBatch = prepared.events;
    try {
      await this.sendWithRetry(prepared.serializedBody, deadlineMs);
      this.flushPausedUntilMs = 0;
    } catch (error) {
      if (!this.consentGranted) {
        this.log('Discarding in-flight batch after event collection consent was revoked');
        return;
      }

      const ingestError = this.toIngestSendError(error);
      if (ingestError.retryable) {
        if (ingestError.timedOut) {
          this.flushTimeoutCount += 1;
        } else {
          this.retryableFailureCount += 1;
        }
        this.requeueAtFront(prepared.events);
      } else {
        this.reportDroppedEvents(
          prepared.events,
          'permanent_ingest_error',
          `Collector permanently rejected ${prepared.events.length} event(s).`,
          {
            status: ingestError.status,
            errorCode: ingestError.errorCode,
            requestId: ingestError.requestId,
          },
        );
      }
      const diagnostics = this.createIngestDiagnostics(
        ingestError,
        prepared.events.length,
        this.queue.length,
      );
      if (ingestError.status === 401 || ingestError.status === 403) {
        this.flushPausedUntilMs = Date.now() + AUTH_FAILURE_FLUSH_PAUSE_MS;
        this.log('Pausing ingest flush after auth failure', {
          status: ingestError.status,
          retryAfterMs: AUTH_FAILURE_FLUSH_PAUSE_MS,
        });
      }
      this.log(
        ingestError.retryable
          ? 'Send failed after retries; batch remains queued'
          : 'Send failed permanently; batch was dropped',
        diagnostics,
      );
      this.reportIngestError(diagnostics);
    } finally {
      this.inFlightBatch = [];
    }
  }

  /**
   * Stops internal timers and unload handlers.
   */
  public shutdown(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    while (this.browserLifecycleHandlers.length > 0) {
      const listener = this.browserLifecycleHandlers.pop();
      if (!listener || typeof listener.target.removeEventListener !== 'function') {
        continue;
      }
      listener.target.removeEventListener(listener.eventName, listener.handler);
    }
  }

  /**
   * Stops timers/listeners and then drains queued events within a bounded timeout.
   */
  public async shutdownAsync(
    options: AnalyticsFlushOptions = {},
  ): Promise<AnalyticsFlushResult> {
    this.shutdown();
    return this.flushAll(options);
  }

  private enqueue(event: QueuedEvent): void {
    if (!this.consentGranted) {
      return;
    }

    this.queue.push(event);
    const overflow = this.queue.length - this.maxQueueSize;
    if (overflow > 0) {
      const dropped = this.queue.splice(0, overflow);
      this.reportDroppedEvents(
        dropped,
        'queue_overflow',
        `In-memory queue reached maxQueueSize=${this.maxQueueSize}; oldest event(s) were evicted.`,
      );
    }

    if (this.queue.length >= Math.min(this.batchSize, this.maxQueueSize)) {
      this.scheduleFlush();
    }
  }

  private scheduleFlush(): void {
    void this.flush().catch((error) => {
      this.log('Unexpected flush failure', error);
    });
  }

  private async sendWithRetry(serializedBody: string, deadlineMs?: number): Promise<void> {
    let delay = 250;

    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt += 1) {
      if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
        throw new IngestSendError({
          message: 'ingest flush timed out',
          retryable: true,
          timedOut: true,
          attempts: Math.max(1, attempt - 1),
        });
      }

      const controller =
        typeof AbortController === 'function' ? new AbortController() : null;
      this.activeFlushAbortController = controller;
      const remainingMs =
        deadlineMs === undefined ? null : Math.max(0, deadlineMs - Date.now());
      const timeout =
        controller && remainingMs !== null
          ? setTimeout(() => controller.abort(), remainingMs)
          : null;

      try {
        const response = await fetch(`${this.endpoint}/v1/collect`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': this.apiKey,
          },
          body: serializedBody,
          keepalive: true,
          ...(controller ? { signal: controller.signal } : {}),
        });

        if (!response.ok) {
          throw await this.createHttpIngestSendError(response, attempt);
        }

        return;
      } catch (error) {
        const deadlineReached = deadlineMs !== undefined && Date.now() >= deadlineMs;
        if (deadlineReached) {
          throw new IngestSendError({
            message: 'ingest flush timed out',
            retryable: true,
            timedOut: true,
            attempts: attempt,
            cause: error,
          });
        }

        const normalized = this.toIngestSendError(error, attempt);
        const finalAttempt = attempt >= this.maxRetries + 1;
        this.log('Ingest attempt failed', {
          attempt: normalized.attempts,
          maxRetries: this.maxRetries,
          retryable: normalized.retryable,
          status: normalized.status,
          errorCode: normalized.errorCode,
          requestId: normalized.requestId,
          nextRetryInMs: !finalAttempt && normalized.retryable ? delay : null,
        });

        if (finalAttempt || !normalized.retryable) {
          throw normalized;
        }

        const retryDelay =
          deadlineMs === undefined ? delay : Math.min(delay, Math.max(0, deadlineMs - Date.now()));
        if (retryDelay <= 0) {
          throw new IngestSendError({
            message: 'ingest flush timed out',
            retryable: true,
            timedOut: true,
            attempts: attempt,
            cause: error,
          });
        }
        await this.wait(retryDelay);
        delay *= 2;
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
        if (this.activeFlushAbortController === controller) {
          this.activeFlushAbortController = null;
        }
      }
    }
  }

  private prepareIngestBatch(candidates: QueuedEvent[]): PreparedIngestBatch {
    const sentAt = nowIso();
    const accepted: QueuedEvent[] = [];
    let serializedBody: string | null = null;

    for (let index = 0; index < candidates.length; index += 1) {
      const event = candidates[index];
      if (!event) {
        continue;
      }

      const singlePayload: IngestBatch = {
        sentAt,
        events: [event],
      };
      const validation = validateIngestBatch(singlePayload);
      if (!validation.success) {
        this.reportDroppedEvents(
          [event],
          'invalid_event',
          `Event failed local ingest validation: ${validation.reason}.`,
        );
        continue;
      }

      const singleSerialization = this.trySerializeIngestPayload(singlePayload);
      if (!singleSerialization.success) {
        this.reportDroppedEvents(
          [event],
          'serialization_error',
          'Event could not be safely serialized as JSON.',
        );
        continue;
      }

      if (
        this.calculateUtf8ByteLength(singleSerialization.body) >
        DEFAULT_INGEST_LIMITS.maxPayloadBytes
      ) {
        this.reportDroppedEvents(
          [event],
          'payload_too_large',
          `Event exceeds the ${DEFAULT_INGEST_LIMITS.maxPayloadBytes}-byte ingest limit.`,
        );
        continue;
      }

      const nextEvents = [...accepted, event];
      const nextPayload: IngestBatch = {
        sentAt,
        events: nextEvents,
      };
      const nextSerialization =
        accepted.length === 0
          ? singleSerialization
          : this.trySerializeIngestPayload(nextPayload);
      if (!nextSerialization.success) {
        this.reportDroppedEvents(
          [event],
          'serialization_error',
          'Event could not be safely combined into an ingest batch.',
        );
        continue;
      }

      if (
        this.calculateUtf8ByteLength(nextSerialization.body) >
        DEFAULT_INGEST_LIMITS.maxPayloadBytes
      ) {
        this.requeueAtFront(candidates.slice(index));
        break;
      }

      accepted.push(event);
      serializedBody = nextSerialization.body;
    }

    if (accepted.length === 0 || !serializedBody) {
      return {
        events: [],
        payload: null,
        serializedBody: null,
      };
    }

    const payload: IngestBatch = {
      sentAt,
      events: accepted,
    };
    const validation = validateIngestBatch(payload);
    if (!validation.success) {
      this.reportDroppedEvents(
        accepted,
        'invalid_event',
        `Prepared batch failed local ingest validation: ${validation.reason}.`,
      );
      return {
        events: [],
        payload: null,
        serializedBody: null,
      };
    }

    return {
      events: accepted,
      payload,
      serializedBody,
    };
  }

  private trySerializeIngestPayload(
    payload: IngestBatch,
  ): { success: true; body: string } | { success: false } {
    try {
      return {
        success: true,
        body: JSON.stringify(payload),
      };
    } catch {
      return { success: false };
    }
  }

  private calculateUtf8ByteLength(value: string): number {
    let byteLength = 0;

    for (let index = 0; index < value.length; index += 1) {
      const codeUnit = value.charCodeAt(index);
      if (codeUnit <= 0x7f) {
        byteLength += 1;
      } else if (codeUnit <= 0x7ff) {
        byteLength += 2;
      } else if (
        codeUnit >= 0xd800 &&
        codeUnit <= 0xdbff &&
        index + 1 < value.length &&
        value.charCodeAt(index + 1) >= 0xdc00 &&
        value.charCodeAt(index + 1) <= 0xdfff
      ) {
        byteLength += 4;
        index += 1;
      } else {
        byteLength += 3;
      }
    }

    return byteLength;
  }

  private requeueAtFront(events: QueuedEvent[]): void {
    if (events.length === 0) {
      return;
    }

    this.queue = [...events, ...this.queue];
    const overflow = this.queue.length - this.maxQueueSize;
    if (overflow <= 0) {
      return;
    }

    const dropped = this.queue.splice(this.maxQueueSize, overflow);
    this.reportDroppedEvents(
      dropped,
      'queue_overflow',
      `Retry preservation exceeded maxQueueSize=${this.maxQueueSize}; newest queued event(s) were evicted.`,
    );
  }

  private reportDroppedEvents(
    events: QueuedEvent[],
    reason: AnalyticsDropReason,
    message: string,
    metadata: {
      status?: number;
      errorCode?: string;
      requestId?: string;
    } = {},
  ): void {
    if (events.length === 0) {
      return;
    }

    this.reportDroppedEventNames(
      events.map((event) => event.eventName),
      reason,
      message,
      metadata,
    );
  }

  private reportDroppedEventNames(
    eventNames: string[],
    reason: AnalyticsDropReason,
    message: string,
    metadata: {
      status?: number;
      errorCode?: string;
      requestId?: string;
    } = {},
  ): void {
    if (eventNames.length === 0) {
      return;
    }

    const diagnostic: AnalyticsDropDiagnostic = {
      name: 'AnalyticsDropDiagnostic',
      reason,
      message,
      droppedCount: eventNames.length,
      eventNames: eventNames.map(
        (eventName) => this.readRequiredStringOption(eventName).slice(0, 100) || 'unknown',
      ),
      queueSize: this.queue.length,
      maxQueueSize: this.maxQueueSize,
      status: metadata.status,
      errorCode: metadata.errorCode,
      requestId: metadata.requestId,
      timestamp: nowIso(),
    };
    this.log('Events dropped', diagnostic);

    if (!this.onEventsDropped) {
      return;
    }

    try {
      this.onEventsDropped(diagnostic);
    } catch (callbackError) {
      this.log('onEventsDropped callback threw', callbackError);
    }
  }

  private getPendingEventCount(): number {
    return (
      this.deferredEventsBeforeHydration.length +
      this.queue.length +
      this.inFlightBatch.length
    );
  }

  private abortActiveFlush(): void {
    try {
      this.activeFlushAbortController?.abort();
    } catch {
      // AbortController implementations can vary across browser/RN runtimes.
    }
  }

  private createFlushResult(
    stopReason: AnalyticsFlushResult['reason'],
  ): AnalyticsFlushResult {
    const remainingEvents = this.getPendingEventCount();
    const completed = remainingEvents === 0;
    return {
      completed,
      timedOut: stopReason === 'timed_out' && !completed,
      reason: completed ? 'drained' : stopReason,
      remainingEvents,
    };
  }

  private async waitForPromiseUntil(
    promise: Promise<void>,
    deadlineMs: number,
  ): Promise<boolean> {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      return false;
    }

    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        promise.then(() => true),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), remainingMs);
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private wait(delayMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  private async createHttpIngestSendError(
    response: Response,
    attempts: number,
  ): Promise<IngestSendError> {
    const requestId =
      response.headers.get('x-request-id') ?? response.headers.get('cf-ray') ?? undefined;
    let errorCode: string | undefined;
    let serverMessage: string | undefined;

    try {
      const parsed = (await response.json()) as IngestErrorBody;
      const errorBody =
        parsed && typeof parsed === 'object' && parsed.error && typeof parsed.error === 'object'
          ? parsed.error
          : undefined;
      if (typeof errorBody?.code === 'string') {
        errorCode = errorBody.code;
      }
      if (typeof errorBody?.message === 'string') {
        serverMessage = errorBody.message;
      }
    } catch {
      // Response body can be empty or non-JSON; status and request id are still enough for diagnostics.
    }

    const retryable = this.shouldRetryHttpStatus(response.status);
    const statusSuffix = errorCode ? ` ${errorCode}` : '';
    const message = `ingest status=${response.status}${statusSuffix}`;

    return new IngestSendError({
      message,
      retryable,
      attempts,
      status: response.status,
      errorCode,
      serverMessage,
      requestId,
    });
  }

  private shouldRetryHttpStatus(status: number): boolean {
    return status === 408 || status === 425 || status === 429 || status >= 500;
  }

  private toIngestSendError(error: unknown, attempts?: number): IngestSendError {
    if (error instanceof IngestSendError) {
      const resolvedAttempts = attempts ?? error.attempts;
      return new IngestSendError({
        message: error.message,
        retryable: error.retryable,
        timedOut: error.timedOut,
        attempts: resolvedAttempts,
        status: error.status,
        errorCode: error.errorCode,
        serverMessage: error.serverMessage,
        requestId: error.requestId,
        cause: (error as Error & { cause?: unknown }).cause,
      });
    }

    const fallbackMessage = error instanceof Error ? error.message : 'ingest request failed';
    return new IngestSendError({
      message: fallbackMessage,
      retryable: true,
      attempts: attempts ?? 1,
      cause: error,
    });
  }

  private createIngestDiagnostics(
    error: IngestSendError,
    batchSize: number,
    queueSize: number,
  ): AnalyticsIngestError {
    return {
      name: 'AnalyticsIngestError',
      message: error.message,
      endpoint: this.endpoint,
      path: '/v1/collect',
      status: error.status,
      errorCode: error.errorCode,
      serverMessage: error.serverMessage,
      requestId: error.requestId,
      retryable: error.retryable,
      attempts: error.attempts,
      maxRetries: this.maxRetries,
      batchSize,
      queueSize,
      timestamp: nowIso(),
    };
  }

  private reportIngestError(error: AnalyticsIngestError): void {
    if (!this.onIngestError) {
      return;
    }

    try {
      this.onIngestError(error);
    } catch (callbackError) {
      this.log('onIngestError callback threw', callbackError);
    }
  }

  private parsePersistedConsent(raw: string | null): boolean | null {
    if (raw === 'granted') {
      return true;
    }
    if (raw === 'denied') {
      return false;
    }
    return null;
  }

  private readPersistedConsentSync(storage: AnalyticsStorageAdapter | null): boolean | null {
    if (!this.persistConsentState) {
      return null;
    }
    if (storage === this.storage && this.storageReadsAreAsync) {
      return null;
    }
    return this.parsePersistedConsent(readStorageSync(storage, this.consentStorageKey));
  }

  private async readPersistedConsentAsync(
    storage: AnalyticsStorageAdapter | null,
  ): Promise<boolean | null> {
    if (!this.persistConsentState) {
      return null;
    }
    return this.parsePersistedConsent(await readStorageAsync(storage, this.consentStorageKey));
  }

  private writePersistedConsent(storage: AnalyticsStorageAdapter | null, granted: boolean): void {
    if (!this.persistConsentState) {
      return;
    }
    writeStorageSync(storage, this.consentStorageKey, granted ? 'granted' : 'denied');
  }

  private startAutoFlush(): void {
    if (!this.hasIngestConfig) {
      return;
    }

    this.flushTimer = setInterval(() => {
      this.scheduleFlush();
    }, this.flushIntervalMs);

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      this.addBrowserFlushListener('pagehide', () => {
        this.scheduleFlush();
      });
      this.addBrowserFlushListener('visibilitychange', () => {
        if (typeof document === 'undefined' || document.visibilityState === 'hidden') {
          this.scheduleFlush();
        }
      });
      this.addBrowserFlushListener('beforeunload', () => {
        this.scheduleFlush();
      });
    }
  }

  private addBrowserFlushListener(eventName: BrowserFlushEvent, handler: EventListener): void {
    window.addEventListener(eventName, handler);
    this.browserLifecycleHandlers.push({
      target: window,
      eventName,
      handler,
    });
  }

  private ensureDeviceId(): string {
    if (this.storageReadsAreAsync) {
      return randomId();
    }

    const existing = readStorageSync(this.storage, DEVICE_ID_KEY);
    if (existing) {
      return existing;
    }

    const value = randomId();
    writeStorageSync(this.storage, DEVICE_ID_KEY, value);
    return value;
  }

  private ensureSessionId(): string {
    const now = Date.now();
    if (this.sessionId && now - this.inMemoryLastSeenMs < this.sessionTimeoutMs) {
      this.inMemoryLastSeenMs = now;
      if (!this.storageReadsAreAsync || this.hydrationCompleted) {
        writeStorageSync(this.storage, SESSION_ID_KEY, this.sessionId);
        writeStorageSync(this.storage, LAST_SEEN_KEY, String(now));
      }
      return this.sessionId;
    }

    if (this.storageReadsAreAsync) {
      this.inMemoryLastSeenMs = now;
      const next = randomId();
      if (this.hydrationCompleted) {
        writeStorageSync(this.storage, SESSION_ID_KEY, next);
        writeStorageSync(this.storage, LAST_SEEN_KEY, String(now));
      }
      return next;
    }

    const existing = readStorageSync(this.storage, SESSION_ID_KEY);
    const lastSeenRaw = readStorageSync(this.storage, LAST_SEEN_KEY);
    const lastSeen = lastSeenRaw ? Number(lastSeenRaw) : NaN;

    if (existing && Number.isFinite(lastSeen) && now - lastSeen < this.sessionTimeoutMs) {
      this.inMemoryLastSeenMs = now;
      writeStorageSync(this.storage, LAST_SEEN_KEY, String(now));
      return existing;
    }

    this.inMemoryLastSeenMs = now;
    const next = randomId();
    writeStorageSync(this.storage, SESSION_ID_KEY, next);
    writeStorageSync(this.storage, LAST_SEEN_KEY, String(now));
    return next;
  }

  private getSessionId(): string {
    const resolvedSessionId = this.ensureSessionId();
    if (resolvedSessionId !== this.sessionId) {
      this.sessionId = resolvedSessionId;
      this.sessionEventSeq = this.readSessionEventSeq(resolvedSessionId);
    }
    return this.sessionId;
  }

  private readSessionEventSeq(sessionId: string): number {
    const raw = readStorageSync(this.storage, `${SESSION_EVENT_SEQ_PREFIX}${sessionId}`);
    return this.parseSessionEventSeq(raw);
  }

  private async readSessionEventSeqAsync(sessionId: string): Promise<number> {
    const raw = await readStorageAsync(this.storage, `${SESSION_EVENT_SEQ_PREFIX}${sessionId}`);
    return this.parseSessionEventSeq(raw);
  }

  private parseSessionEventSeq(raw: string | null): number {
    const parsed = raw ? Number(raw) : Number.NaN;
    if (!Number.isFinite(parsed) || parsed < 0) {
      return 0;
    }
    return Math.floor(parsed);
  }

  private writeSessionEventSeq(sessionId: string, value: number): void {
    writeStorageSync(this.storage, `${SESSION_EVENT_SEQ_PREFIX}${sessionId}`, String(value));
  }

  private async hydrateIdentityFromStorage(): Promise<void> {
    if (!this.storage) {
      this.onboardingStepViewStateSessionId = this.sessionId;
      this.hydrationCompleted = true;
      return;
    }

    try {
      const [storedAnonId, storedSessionId, storedLastSeen, storedConsent] = await Promise.all([
        readStorageAsync(this.storage, DEVICE_ID_KEY),
        readStorageAsync(this.storage, SESSION_ID_KEY),
        readStorageAsync(this.storage, LAST_SEEN_KEY),
        this.readPersistedConsentAsync(this.storage),
      ]);

      if (!this.hasExplicitAnonId && storedAnonId) {
        this.anonId = storedAnonId;
      }

      if (!this.hasExplicitSessionId && storedSessionId) {
        const lastSeenMs = storedLastSeen ? Number(storedLastSeen) : Number.NaN;
        if (Number.isFinite(lastSeenMs) && Date.now() - lastSeenMs < this.sessionTimeoutMs) {
          this.sessionId = storedSessionId;
          this.inMemoryLastSeenMs = Date.now();
        }
      }

      if (!this.hasExplicitInitialConsent && typeof storedConsent === 'boolean') {
        this.consentGranted = this.hasIngestConfig && storedConsent;
        if (!this.consentGranted) {
          this.queue = [];
          this.deferredEventsBeforeHydration = [];
        }
      }

      this.sessionEventSeq = await this.readSessionEventSeqAsync(this.sessionId);
      await this.hydrateOnboardingStepViewState(this.sessionId);
      writeStorageSync(this.storage, DEVICE_ID_KEY, this.anonId);
      writeStorageSync(this.storage, SESSION_ID_KEY, this.sessionId);
      writeStorageSync(this.storage, LAST_SEEN_KEY, String(this.inMemoryLastSeenMs));
    } catch (error) {
      this.log('Storage hydration failed; continuing with in-memory identity', error);
    } finally {
      this.hydrationCompleted = true;
      this.drainDeferredEventsAfterHydration();
    }
  }

  private shouldDeferEventsUntilHydrated(): boolean {
    return (
      this.storageReadsAreAsync &&
      !this.hydrationCompleted &&
      (!this.hasExplicitAnonId || !this.hasExplicitSessionId)
    );
  }

  private deferEventUntilHydrated(eventName: string, action: () => void): void {
    if (this.deferredEventsBeforeHydration.length >= this.maxQueueSize) {
      const dropped = this.deferredEventsBeforeHydration.shift();
      if (dropped) {
        this.reportDroppedEventNames(
          [dropped.eventName],
          'queue_overflow',
          `Pre-hydration queue reached maxQueueSize=${this.maxQueueSize}; oldest event was evicted.`,
        );
      }
    }

    this.deferredEventsBeforeHydration.push({ eventName, action });
  }

  private drainDeferredEventsAfterHydration(): void {
    if (this.deferredEventsBeforeHydration.length === 0) {
      return;
    }

    const deferred = this.deferredEventsBeforeHydration;
    this.deferredEventsBeforeHydration = [];

    for (const entry of deferred) {
      try {
        entry.action();
      } catch (error) {
        this.log('Failed to emit deferred pre-hydration event', error);
      }
    }
  }

  private detectAsyncStorageReads(): boolean {
    if (!this.storage) {
      return false;
    }

    try {
      const value = this.storage.getItem(DEVICE_ID_KEY);
      if (typeof value === 'object' && value !== null && 'then' in value) {
        void (value as Promise<unknown>).catch(() => {
          // ignore adapter read errors during sync capability detection
        });
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private withRuntimeMetadata(
    properties: EventProperties | undefined,
    sessionId: string,
  ): EventProperties {
    const sanitized = sanitizeProperties(properties);
    const nextEventIndex = this.sessionEventSeq + 1;
    this.sessionEventSeq = nextEventIndex;
    this.writeSessionEventSeq(sessionId, nextEventIndex);

    if (typeof sanitized.runtimeEnv !== 'string') {
      sanitized.runtimeEnv = this.runtimeEnv;
    }
    if (typeof sanitized.identityTrackingMode !== 'string') {
      sanitized.identityTrackingMode = this.identityTrackingMode;
    }
    if (typeof sanitized.identityQuality !== 'string') {
      sanitized.identityQuality = this.resolveEventIdentityQuality();
    }
    if (typeof sanitized.identityPersistence !== 'string') {
      sanitized.identityPersistence = this.hasPersistentAnonymousIdentity()
        ? 'persistent'
        : 'ephemeral';
    }
    if (typeof sanitized.fullTrackingConsentGranted !== 'boolean') {
      sanitized.fullTrackingConsentGranted = this.fullTrackingConsentGranted;
    }
    if (typeof sanitized.sessionEventIndex !== 'number') {
      sanitized.sessionEventIndex = nextEventIndex;
    }
    return sanitized;
  }

  private shouldDropOnboardingStepView(
    eventName: string,
    properties: EventProperties | undefined,
    sessionId: string,
  ): boolean {
    if (!this.dedupeOnboardingStepViewsPerSession || eventName !== ONBOARDING_EVENTS.STEP_VIEW) {
      return false;
    }

    const dedupeKey = this.getOnboardingStepViewDedupeKey(properties);
    if (!dedupeKey) {
      return false;
    }

    this.syncOnboardingStepViewState(sessionId);
    if (this.onboardingStepViewsSeen.has(dedupeKey)) {
      this.log('Dropping duplicate onboarding step view for session', { sessionId, dedupeKey });
      return true;
    }

    this.onboardingStepViewsSeen.add(dedupeKey);
    this.persistOnboardingStepViewState(sessionId);
    return false;
  }

  private resetOnboardingDedupeStateOnFlowStart(eventName: string, sessionId: string): void {
    if (eventName !== ONBOARDING_EVENTS.START) {
      return;
    }

    if (this.dedupeOnboardingStepViewsPerSession) {
      this.syncOnboardingStepViewState(sessionId);
      if (this.onboardingStepViewsSeen.size > 0) {
        this.onboardingStepViewsSeen.clear();
        this.persistOnboardingStepViewState(sessionId);
      }
    }

    if (this.dedupeOnboardingScreenStepViewOverlapsPerSession) {
      this.onboardingScreenStepViewOverlapSessionId = sessionId;
      this.onboardingStepViewsSeenAtMs = new Map<string, number>();
    }
  }

  private shouldDropScreenView(
    name: string,
    properties: EventProperties | undefined,
    sessionId: string,
  ): boolean {
    if (!this.dedupeScreenViewsPerSession) {
      return false;
    }

    const dedupeKey = this.getScreenViewDedupeKey(name, properties);
    if (!dedupeKey) {
      return false;
    }

    const nowMs = Date.now();
    if (this.lastScreenViewDedupeSessionId !== sessionId) {
      this.lastScreenViewDedupeSessionId = sessionId;
      this.lastScreenViewDedupeKey = null;
      this.lastScreenViewDedupeTsMs = 0;
    }

    const withinWindow =
      this.lastScreenViewDedupeKey === dedupeKey &&
      nowMs - this.lastScreenViewDedupeTsMs <= this.screenViewDedupeWindowMs;
    if (withinWindow) {
      this.log('Dropping duplicate screen view for session', {
        sessionId,
        dedupeKey,
        windowMs: this.screenViewDedupeWindowMs,
      });
      return true;
    }

    this.lastScreenViewDedupeSessionId = sessionId;
    this.lastScreenViewDedupeKey = dedupeKey;
    this.lastScreenViewDedupeTsMs = nowMs;
    return false;
  }

  private dedupeOnboardingScreenStepViewOverlap(
    eventName: string,
    properties: EventProperties | undefined,
    sessionId: string,
  ): void {
    if (
      !this.dedupeOnboardingScreenStepViewOverlapsPerSession ||
      eventName !== ONBOARDING_EVENTS.STEP_VIEW
    ) {
      return;
    }

    const overlapKey = this.getOnboardingScreenStepViewOverlapKeyForStepView(properties);
    if (!overlapKey) {
      return;
    }

    const nowMs = Date.now();
    this.syncOnboardingScreenStepViewOverlapState(sessionId, nowMs);
    this.onboardingStepViewsSeenAtMs.set(overlapKey, nowMs);

    const dropped = this.dropQueuedOnboardingScreenEventsForStep(sessionId, overlapKey, nowMs);
    if (dropped > 0) {
      this.log('Dropping overlapping onboarding screen events in favor of onboarding:step_view', {
        sessionId,
        overlapKey,
        dropped,
        windowMs: this.screenViewDedupeWindowMs,
      });
    }
  }

  private shouldDropOnboardingScreenViewOverlap(
    name: string,
    properties: EventProperties | undefined,
    sessionId: string,
  ): boolean {
    if (!this.dedupeOnboardingScreenStepViewOverlapsPerSession) {
      return false;
    }

    const overlapKey = this.getOnboardingScreenStepViewOverlapKeyForScreen(name, properties);
    if (!overlapKey) {
      return false;
    }

    const nowMs = Date.now();
    this.syncOnboardingScreenStepViewOverlapState(sessionId, nowMs);
    const seenAt = this.onboardingStepViewsSeenAtMs.get(overlapKey);
    if (seenAt === undefined) {
      return false;
    }

    if (nowMs - seenAt > this.screenViewDedupeWindowMs) {
      return false;
    }

    this.log(
      'Dropping overlapping onboarding screen event because onboarding:step_view already exists',
      {
        sessionId,
        overlapKey,
        windowMs: this.screenViewDedupeWindowMs,
      },
    );
    return true;
  }

  private syncOnboardingScreenStepViewOverlapState(sessionId: string, nowMs: number): void {
    if (this.onboardingScreenStepViewOverlapSessionId !== sessionId) {
      this.onboardingScreenStepViewOverlapSessionId = sessionId;
      this.onboardingStepViewsSeenAtMs = new Map<string, number>();
    }

    for (const [key, ts] of this.onboardingStepViewsSeenAtMs.entries()) {
      if (nowMs - ts > this.screenViewDedupeWindowMs) {
        this.onboardingStepViewsSeenAtMs.delete(key);
      }
    }
  }

  private dropQueuedOnboardingScreenEventsForStep(
    sessionId: string,
    overlapKey: string,
    nowMs: number,
  ): number {
    if (this.queue.length === 0) {
      return 0;
    }

    const before = this.queue.length;
    this.queue = this.queue.filter((event) => {
      if (event.type !== 'screen' || event.sessionId !== sessionId) {
        return true;
      }

      const screenName = event.eventName.startsWith('screen:')
        ? event.eventName.slice('screen:'.length)
        : event.eventName;
      const eventOverlapKey = this.getOnboardingScreenStepViewOverlapKeyForScreen(
        screenName,
        event.properties,
      );
      if (!eventOverlapKey || eventOverlapKey !== overlapKey) {
        return true;
      }

      const eventTsMs = Date.parse(event.ts);
      if (!Number.isFinite(eventTsMs)) {
        return true;
      }

      const deltaMs = nowMs - eventTsMs;
      if (deltaMs < 0 || deltaMs > this.screenViewDedupeWindowMs) {
        return true;
      }

      return false;
    });

    return before - this.queue.length;
  }

  private getOnboardingScreenStepViewOverlapKeyForStepView(
    properties: EventProperties | undefined,
  ): string | null {
    if (!properties) {
      return null;
    }

    const stepKey = toStableKey(this.readPropertyAsString(properties.stepKey));
    if (stepKey) {
      return `step:${stepKey}`;
    }

    const stepIndex = this.readPropertyAsStepIndex(properties.stepIndex);
    if (stepIndex === undefined) {
      return null;
    }

    const flowId =
      toStableKey(this.readPropertyAsString(properties.onboardingFlowId)) ?? 'unknown_flow';
    const flowVersion =
      toStableKey(this.readPropertyAsString(properties.onboardingFlowVersion)) ?? 'unknown_version';
    return `index:${flowId}|${flowVersion}|${stepIndex}`;
  }

  private getOnboardingScreenStepViewOverlapKeyForScreen(
    name: string,
    properties: EventProperties | undefined,
  ): string | null {
    const normalizedName = toStableKey(name);
    const normalizedScreenClassName =
      properties && typeof properties === 'object'
        ? this.normalizeScreenName(this.readPropertyAsString(properties.screen_class) ?? '')
        : null;
    const normalizedScreenClass = toStableKey(normalizedScreenClassName ?? undefined);
    const isOnboardingScreen =
      this.isOnboardingScreenName(normalizedName) ||
      this.isOnboardingScreenName(normalizedScreenClass);
    if (!isOnboardingScreen) {
      return null;
    }

    const explicitStepKey =
      properties && typeof properties === 'object'
        ? toStableKey(this.readPropertyAsString(properties.stepKey))
        : undefined;
    if (explicitStepKey) {
      return `step:${explicitStepKey}`;
    }

    const stepKeyFromName = this.extractOnboardingStepKeyFromScreenName(normalizedName ?? name);
    if (stepKeyFromName) {
      return `step:${stepKeyFromName}`;
    }

    const stepKeyFromScreenClass = this.extractOnboardingStepKeyFromScreenName(
      normalizedScreenClassName ?? '',
    );
    if (stepKeyFromScreenClass) {
      return `step:${stepKeyFromScreenClass}`;
    }

    const stepIndex =
      properties && typeof properties === 'object'
        ? this.readPropertyAsStepIndex(properties.stepIndex)
        : undefined;
    if (stepIndex === undefined) {
      return null;
    }

    const flowId =
      properties && typeof properties === 'object'
        ? (toStableKey(this.readPropertyAsString(properties.onboardingFlowId)) ?? 'unknown_flow')
        : 'unknown_flow';
    const flowVersion =
      properties && typeof properties === 'object'
        ? (toStableKey(this.readPropertyAsString(properties.onboardingFlowVersion)) ??
          'unknown_version')
        : 'unknown_version';
    return `index:${flowId}|${flowVersion}|${stepIndex}`;
  }

  private extractOnboardingStepKeyFromScreenName(name: string): string | null {
    const normalizedName = toStableKey(name);
    if (!normalizedName) {
      return null;
    }

    const onboardingPrefixMatch = normalizedName.match(/^onboarding[_:\-.]+(.+)$/);
    if (!onboardingPrefixMatch) {
      return null;
    }

    const stepKey = toStableKey(onboardingPrefixMatch[1]);
    return stepKey ?? null;
  }

  private isOnboardingScreenName(name: string | undefined): boolean {
    if (!name) {
      return false;
    }
    return (
      name === 'onboarding' ||
      name.startsWith('onboarding_') ||
      name.startsWith('onboarding:') ||
      name.startsWith('onboarding-') ||
      name.startsWith('onboarding.')
    );
  }

  private getScreenViewDedupeKey(
    name: string,
    properties: EventProperties | undefined,
  ): string | null {
    const normalizedName = toStableKey(name);
    if (!normalizedName) {
      return null;
    }

    const screenClass =
      properties && typeof properties === 'object'
        ? toStableKey(this.readPropertyAsString(properties.screen_class))
        : null;
    const resolvedScreenClass = screenClass ?? normalizedName;
    return `${normalizedName}|${resolvedScreenClass}`;
  }

  private normalizeScreenName(name: string): string | null {
    const trimmed = this.readRequiredStringOption(name);
    if (!trimmed) {
      return null;
    }

    const withoutEdgeSlashes = trimmed.replace(/^\/+|\/+$/g, '');
    const candidate = withoutEdgeSlashes || 'root';
    const normalized = candidate
      .replace(/[^a-zA-Z0-9_:\-.]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');

    if (!normalized) {
      return null;
    }

    const maxScreenNameLength = 100 - 'screen:'.length;
    return normalized.slice(0, maxScreenNameLength);
  }

  private getOnboardingStepViewDedupeKey(properties: EventProperties | undefined): string | null {
    if (!properties) {
      return null;
    }

    const flowId =
      toStableKey(this.readPropertyAsString(properties.onboardingFlowId)) ?? 'unknown_flow';
    const flowVersion =
      toStableKey(this.readPropertyAsString(properties.onboardingFlowVersion)) ?? 'unknown_version';
    const stepKey = toStableKey(this.readPropertyAsString(properties.stepKey));
    const stepIndex = this.readPropertyAsStepIndex(properties.stepIndex);

    if (!stepKey && stepIndex === undefined) {
      return null;
    }

    return `${flowId}|${flowVersion}|${stepKey ?? 'unknown_step'}|${stepIndex ?? 'unknown_index'}`;
  }

  private readPropertyAsString(value: unknown): string | undefined {
    if (typeof value === 'string') {
      return value;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }

    return undefined;
  }

  private readPropertyAsStepIndex(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return undefined;
    }

    return Math.max(0, Math.floor(value));
  }

  private syncOnboardingStepViewState(sessionId: string): void {
    if (this.onboardingStepViewStateSessionId === sessionId) {
      return;
    }

    const persisted = this.parseOnboardingStepViewState(
      readStorageSync(this.storage, ONBOARDING_STEP_VIEW_STATE_KEY),
    );

    this.onboardingStepViewStateSessionId = sessionId;
    this.onboardingStepViewsSeen =
      persisted?.sessionId === sessionId ? new Set(persisted.keys) : new Set<string>();
  }

  private async hydrateOnboardingStepViewState(sessionId: string): Promise<void> {
    if (!this.dedupeOnboardingStepViewsPerSession) {
      this.onboardingStepViewStateSessionId = sessionId;
      this.onboardingStepViewsSeen = new Set<string>();
      return;
    }

    const persisted = this.parseOnboardingStepViewState(
      await readStorageAsync(this.storage, ONBOARDING_STEP_VIEW_STATE_KEY),
    );

    this.onboardingStepViewStateSessionId = sessionId;
    this.onboardingStepViewsSeen =
      persisted?.sessionId === sessionId
        ? new Set([...persisted.keys, ...this.onboardingStepViewsSeen])
        : new Set(this.onboardingStepViewsSeen);
  }

  private persistOnboardingStepViewState(sessionId: string): void {
    this.onboardingStepViewStateSessionId = sessionId;
    writeStorageSync(
      this.storage,
      ONBOARDING_STEP_VIEW_STATE_KEY,
      JSON.stringify({
        sessionId,
        keys: Array.from(this.onboardingStepViewsSeen),
      }),
    );
  }

  private parseOnboardingStepViewState(
    raw: string | null,
  ): { sessionId: string; keys: string[] } | null {
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as {
        sessionId?: unknown;
        keys?: unknown;
      };

      if (typeof parsed.sessionId !== 'string' || !Array.isArray(parsed.keys)) {
        return null;
      }

      const keys = parsed.keys.filter((value): value is string => typeof value === 'string');
      return {
        sessionId: parsed.sessionId,
        keys,
      };
    } catch {
      return null;
    }
  }

  private resolveIdentityTrackingModeOption(
    options: Partial<AnalyticsClientOptions>,
  ): IdentityTrackingMode {
    const explicitMode = this.readRequiredStringOption(options.identityTrackingMode).toLowerCase();
    if (explicitMode === 'strict') {
      return 'strict';
    }
    if (explicitMode === 'consent_gated') {
      return 'consent_gated';
    }
    if (explicitMode === 'always_on') {
      return 'always_on';
    }
    if (options.enableFullTrackingWithoutConsent === true) {
      return 'always_on';
    }
    return 'consent_gated';
  }

  private resolveConfiguredStorage(
    options: Partial<AnalyticsClientOptions>,
  ): AnalyticsStorageAdapter | null {
    if (this.identityTrackingMode === 'strict') {
      if (options.storage || options.useCookieStorage || options.cookieDomain) {
        this.log('Ignoring storage/cookie configuration because identityTrackingMode=strict');
      }
      return null;
    }

    const customStorage = options.storage ?? null;
    const browserStorage = resolveBrowserStorageAdapter();
    const primaryStorage = customStorage ?? browserStorage;
    const cookieStorage = resolveCookieStorageAdapter(
      options.useCookieStorage === true,
      this.readRequiredStringOption(options.cookieDomain) || undefined,
      this.normalizeCookieMaxAgeSeconds(options.cookieMaxAgeSeconds),
    );

    if (primaryStorage && cookieStorage) {
      return combineStorageAdapters(primaryStorage, cookieStorage);
    }

    return primaryStorage ?? cookieStorage;
  }

  private normalizeCookieMaxAgeSeconds(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return DEFAULT_COOKIE_MAX_AGE_SECONDS;
    }
    return Math.floor(value);
  }

  private normalizeScreenViewDedupeWindowMs(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return DEFAULT_SCREEN_VIEW_DEDUPE_WINDOW_MS;
    }
    return Math.floor(value);
  }

  private isFullTrackingActive(): boolean {
    if (!this.hasIngestConfig) {
      return false;
    }
    if (this.identityTrackingMode === 'always_on') {
      return true;
    }
    if (this.identityTrackingMode === 'strict') {
      return false;
    }
    return this.fullTrackingConsentGranted;
  }

  private applyIdentityTrackingState(): void {
    if (!this.isFullTrackingActive()) {
      this.storage = null;
      this.storageReadsAreAsync = false;
      this.userId = null;
      return;
    }

    this.storage = this.configuredStorage;
    this.storageReadsAreAsync = this.detectAsyncStorageReads();
    this.sessionId = this.ensureSessionId();
    this.sessionEventSeq = this.readSessionEventSeq(this.sessionId);
    writeStorageSync(this.storage, DEVICE_ID_KEY, this.anonId);
    writeStorageSync(this.storage, SESSION_ID_KEY, this.sessionId);
    writeStorageSync(this.storage, LAST_SEEN_KEY, String(this.inMemoryLastSeenMs));
  }

  private resetSessionScopedDedupeState(): void {
    this.onboardingStepViewStateSessionId = null;
    this.onboardingStepViewsSeen = new Set<string>();
    this.onboardingScreenStepViewOverlapSessionId = null;
    this.onboardingStepViewsSeenAtMs = new Map<string, number>();
    this.lastScreenViewDedupeSessionId = null;
    this.lastScreenViewDedupeKey = null;
    this.lastScreenViewDedupeTsMs = 0;
  }

  private getEventUserId(): string | null {
    if (!this.isFullTrackingActive()) {
      return null;
    }
    return this.userId;
  }

  private hasPersistentAnonymousIdentity(): boolean {
    return this.isFullTrackingActive() && (this.hasExplicitAnonId || this.storage !== null);
  }

  private resolveEventIdentityQuality(): 'identified' | 'persistent' | 'ephemeral' {
    if (this.getEventUserId()) {
      return 'identified';
    }
    if (this.hasPersistentAnonymousIdentity()) {
      return 'persistent';
    }
    return 'ephemeral';
  }

  private resolveEventPrivacyMode(): 'strict' | 'full' {
    return this.isFullTrackingActive() ? 'full' : 'strict';
  }

  private withEventContext(): EventContext {
    return {
      appBuild: this.context.appBuild,
      osName: this.context.osName,
      osVersion: this.context.osVersion,
      region: this.context.region,
      city: this.context.city,
    };
  }

  private normalizeFeedbackConfig(value: unknown): FeedbackClientOptions | null {
    if (typeof value !== 'object' || value === null) {
      return null;
    }

    const input = value as FeedbackClientOptions;
    return {
      serviceUrl: this.readRequiredStringOption(input.serviceUrl) || undefined,
      apiKey: this.readRequiredStringOption(input.apiKey) || undefined,
      apiKeyHeader: this.readRequiredStringOption(input.apiKeyHeader) || undefined,
      appId: this.readRequiredStringOption(input.appId) || undefined,
      surface: this.normalizeProjectSurfaceOption(input.surface),
      locationId: this.readRequiredStringOption(input.locationId) || undefined,
      originName: this.readRequiredStringOption(input.originName) || undefined,
      userId: this.readRequiredStringOption(input.userId) || undefined,
      metadata: this.mergeFeedbackMetadata(input.metadata),
      timeoutMs:
        typeof input.timeoutMs === 'number' &&
        Number.isFinite(input.timeoutMs) &&
        input.timeoutMs > 0
          ? input.timeoutMs
          : undefined,
      trackEvents: input.trackEvents !== false,
    };
  }

  private mergeFeedbackMetadata(
    ...sources: Array<FeedbackMetadata | null | undefined>
  ): FeedbackMetadata {
    const result: FeedbackMetadata = {};
    for (const source of sources) {
      if (!source || typeof source !== 'object') {
        continue;
      }
      for (const [key, value] of Object.entries(source)) {
        const normalizedKey = this.readRequiredStringOption(key).slice(0, 64);
        if (!normalizedKey) {
          continue;
        }
        if (
          value === null ||
          typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean'
        ) {
          result[normalizedKey] = value;
        }
      }
    }
    return result;
  }

  private normalizeOptions(options: unknown): Partial<AnalyticsClientOptions> {
    if (typeof options !== 'object' || options === null) {
      return {};
    }

    return options as Partial<AnalyticsClientOptions>;
  }

  private normalizePositiveIntegerOption(
    value: unknown,
    fallback: number,
    maximum: number,
  ): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return fallback;
    }
    return Math.min(maximum, Math.max(1, Math.floor(value)));
  }

  private normalizeNonNegativeIntegerOption(value: unknown, fallback: number): number {
    if (value === null || value === undefined) {
      return fallback;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return fallback;
    }
    return Math.floor(value);
  }

  private readRequiredStringOption(value: unknown): string {
    if (typeof value !== 'string') {
      return '';
    }

    return value.trim();
  }

  private normalizePlatformOption(value: unknown): string | undefined {
    const normalized = this.readRequiredStringOption(value).toLowerCase();
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
  }

  private normalizeProjectSurfaceOption(value: unknown): string | undefined {
    const normalized = this.readRequiredStringOption(value).toLowerCase();
    if (!normalized) {
      return undefined;
    }

    if (normalized.length > 64) {
      return normalized.slice(0, 64);
    }

    return normalized;
  }

  private log(message: string, data?: unknown): void {
    if (!this.debug) {
      return;
    }
    // eslint-disable-next-line no-console
    console.debug('[analyticscli-sdk]', message, data);
  }

  private reportMissingApiKey(): void {
    // eslint-disable-next-line no-console
    console.error(
      '[analyticscli-sdk] Missing required `apiKey`. Tracking is disabled (safe no-op). Pass your publishable API key.',
    );
  }
}
