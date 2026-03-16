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
  resolveBrowserStorageAdapter,
  resolveCookieStorageAdapter,
  sanitizeProperties,
  toStableKey,
  writeStorageSync,
} from './helpers.js';
import { sanitizeSurveyResponseInput } from './survey.js';
import type {
  AnalyticsClientOptions,
  AnalyticsStorageAdapter,
  EventContext,
  EventProperties,
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
} from './types.js';

export class AnalyticsClient {
  private readonly apiKey: string;
  private readonly hasIngestConfig: boolean;
  private readonly endpoint: string;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly maxRetries: number;
  private readonly debug: boolean;
  private readonly platform: string | undefined;
  private readonly appVersion: string | undefined;
  private context: EventContext;
  private readonly storage: AnalyticsStorageAdapter | null;
  private readonly storageReadsAreAsync: boolean;
  private readonly sessionTimeoutMs: number;
  private readonly dedupeOnboardingStepViewsPerSession: boolean;
  private readonly runtimeEnv: 'production' | 'development';
  private readonly hasExplicitAnonId: boolean;
  private readonly hasExplicitSessionId: boolean;
  private readonly hydrationPromise: Promise<void>;

  private queue: QueuedEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private isFlushing = false;
  private consentGranted = true;
  private userId: string | null = null;
  private anonId: string;
  private sessionId: string;
  private sessionEventSeq = 0;
  private inMemoryLastSeenMs = Date.now();
  private hydrationCompleted = false;
  private deferredEventsBeforeHydration: Array<() => void> = [];
  private onboardingStepViewStateSessionId: string | null = null;
  private onboardingStepViewsSeen = new Set<string>();

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
    this.batchSize = Math.min(normalizedOptions.batchSize ?? 20, DEFAULT_INGEST_LIMITS.maxBatchSize);
    this.flushIntervalMs = normalizedOptions.flushIntervalMs ?? 5000;
    this.maxRetries = normalizedOptions.maxRetries ?? 4;
    this.debug = normalizedOptions.debug ?? false;
    this.platform = this.normalizePlatformOption(normalizedOptions.platform) ?? detectDefaultPlatform();
    this.appVersion =
      this.readRequiredStringOption(normalizedOptions.appVersion) || detectDefaultAppVersion();
    this.context = { ...(normalizedOptions.context ?? {}) };
    this.runtimeEnv = detectRuntimeEnv();
    const useCookieStorage = normalizedOptions.useCookieStorage ?? Boolean(normalizedOptions.cookieDomain);
    const cookieStorage = resolveCookieStorageAdapter(
      useCookieStorage,
      normalizedOptions.cookieDomain ?? undefined,
      normalizedOptions.cookieMaxAgeSeconds ?? DEFAULT_COOKIE_MAX_AGE_SECONDS,
    );
    const browserStorage = resolveBrowserStorageAdapter();
    this.storage =
      normalizedOptions.storage ??
      (cookieStorage && browserStorage
        ? combineStorageAdapters(cookieStorage, browserStorage)
        : cookieStorage ?? browserStorage);
    this.storageReadsAreAsync = this.detectAsyncStorageReads();
    this.sessionTimeoutMs = normalizedOptions.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
    this.dedupeOnboardingStepViewsPerSession =
      normalizedOptions.dedupeOnboardingStepViewsPerSession ?? true;
    const providedAnonId = normalizedOptions.anonId?.trim();
    const providedSessionId = normalizedOptions.sessionId?.trim();
    this.hasExplicitAnonId = Boolean(providedAnonId);
    this.hasExplicitSessionId = Boolean(providedSessionId);

    this.anonId = providedAnonId || this.ensureDeviceId();
    this.sessionId = providedSessionId || this.ensureSessionId();
    this.sessionEventSeq = this.readSessionEventSeq(this.sessionId);
    this.consentGranted = this.hasIngestConfig;

    this.hydrationPromise = this.hydrateIdentityFromStorage();
    this.startAutoFlush();
  }

  /**
   * Resolves once any async storage adapter hydration completes.
   * Useful in React Native when using async persistence (for example AsyncStorage).
   */
  public async ready(): Promise<void> {
    await this.hydrationPromise;
  }

  /**
   * Enables or disables event collection.
   * When disabled, queued events are dropped immediately.
   */
  public setConsent(granted: boolean): void {
    if (granted && !this.hasIngestConfig) {
      this.log('Ignoring consent opt-in because `apiKey` is missing');
      return;
    }

    this.consentGranted = granted;
    if (!granted) {
      this.queue = [];
      this.deferredEventsBeforeHydration = [];
    }
  }

  public optIn(): void {
    this.setConsent(true);
  }

  public optOut(): void {
    this.setConsent(false);
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

  /**
   * Associates following events with a known user id.
   * Anonymous history remains linked by anonId/sessionId.
   */
  public identify(userId: string, traits?: EventProperties): void {
    if (!this.consentGranted) {
      return;
    }

    const normalizedUserId = this.readRequiredStringOption(userId);
    if (!normalizedUserId) {
      this.log('Dropping identify call without required `userId`');
      return;
    }

    if (this.shouldDeferEventsUntilHydrated()) {
      const deferredTraits = this.cloneProperties(traits);
      this.deferEventUntilHydrated(() => {
        this.identify(normalizedUserId, deferredTraits);
      });
      return;
    }

    this.userId = normalizedUserId;
    const sessionId = this.getSessionId();
    this.enqueue({
      eventId: randomId(),
      eventName: 'identify',
      ts: nowIso(),
      sessionId,
      anonId: this.anonId,
      userId: normalizedUserId,
      properties: this.withRuntimeMetadata(traits, sessionId),
      platform: this.platform,
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
    const normalizedUserId =
      typeof userId === 'string' ? this.readRequiredStringOption(userId) : '';

    if (!normalizedUserId) {
      this.clearUser();
      return;
    }

    this.identify(normalizedUserId, traits);
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
      const deferredProperties = this.cloneProperties(properties);
      this.deferEventUntilHydrated(() => {
        this.track(eventName, deferredProperties);
      });
      return;
    }

    const sessionId = this.getSessionId();
    if (this.shouldDropOnboardingStepView(eventName, properties, sessionId)) {
      return;
    }
    this.enqueue({
      eventId: randomId(),
      eventName,
      ts: nowIso(),
      sessionId,
      anonId: this.anonId,
      userId: this.userId,
      properties: this.withRuntimeMetadata(properties, sessionId),
      platform: this.platform,
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
        view: (overrides) => track(ONBOARDING_EVENTS.STEP_VIEW, { ...stepProps, ...(overrides ?? {}) }),
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
   * Useful when a flow has a stable `source`, `paywallId`, `offering`, or experiment metadata.
   */
  public createPaywallTracker(defaults: PaywallTrackerDefaults): PaywallTracker {
    const { source: rawDefaultSource, ...defaultProperties } = defaults;
    const defaultSource = this.readRequiredStringOption(rawDefaultSource);
    let currentPaywallEntryId: string | undefined;
    if (!defaultSource) {
      this.log('createPaywallTracker() called without a valid default `source`');
    }

    const mergeProperties = (properties?: PaywallTrackerProperties): PaywallEventProperties => {
      const mergedSource = this.readRequiredStringOption(
        this.readPropertyAsString(properties?.source) ?? defaultSource,
      );

      return {
        ...defaultProperties,
        ...(properties ?? {}),
        source: mergedSource,
      };
    };

    const track = (eventName: PaywallJourneyEventName, properties?: PaywallTrackerProperties) => {
      const mergedProperties = mergeProperties(properties);
      delete mergedProperties.paywallEntryId;

      if (eventName === PAYWALL_EVENTS.SHOWN) {
        currentPaywallEntryId = randomId();
        mergedProperties.paywallEntryId = currentPaywallEntryId;
      } else {
        if (currentPaywallEntryId) {
          mergedProperties.paywallEntryId = currentPaywallEntryId;
        }

        if (properties?.offering === undefined) {
          delete mergedProperties.offering;
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
    if (typeof properties?.source !== 'string' || properties.source.trim().length === 0) {
      this.log('Dropping paywall event without required `source` property', { eventName });
      return;
    }

    const normalizedProperties = {
      ...properties,
    };

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

    if (this.shouldDeferEventsUntilHydrated()) {
      const deferredProperties = this.cloneProperties(properties);
      this.deferEventUntilHydrated(() => {
        this.screen(name, deferredProperties);
      });
      return;
    }

    const sessionId = this.getSessionId();
    this.enqueue({
      eventId: randomId(),
      eventName: `screen:${name}`,
      ts: nowIso(),
      sessionId,
      anonId: this.anonId,
      userId: this.userId,
      properties: this.withRuntimeMetadata(properties, sessionId),
      platform: this.platform,
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
   * Sends a feedback event.
   */
  public feedback(message: string, rating?: number, properties?: EventProperties): void {
    if (!this.consentGranted) {
      return;
    }

    if (this.shouldDeferEventsUntilHydrated()) {
      const deferredProperties = this.cloneProperties(properties);
      this.deferEventUntilHydrated(() => {
        this.feedback(message, rating, deferredProperties);
      });
      return;
    }

    const sessionId = this.getSessionId();
    this.enqueue({
      eventId: randomId(),
      eventName: 'feedback_submitted',
      ts: nowIso(),
      sessionId,
      anonId: this.anonId,
      userId: this.userId,
      properties: this.withRuntimeMetadata({ message, rating, ...properties }, sessionId),
      platform: this.platform,
      appVersion: this.appVersion,
      ...this.withEventContext(),
      type: 'feedback',
    });
  }

  /**
   * Flushes current event queue to the ingest endpoint.
   */
  public async flush(): Promise<void> {
    if (!this.hydrationCompleted && this.deferredEventsBeforeHydration.length > 0) {
      await this.hydrationPromise;
    }

    if (this.queue.length === 0 || this.isFlushing || !this.consentGranted) {
      return;
    }

    this.isFlushing = true;
    const batch = this.queue.splice(0, this.batchSize);

    const payload: IngestBatch = {
      sentAt: nowIso(),
      events: batch,
    };

    const validation = validateIngestBatch(payload);
    if (!validation.success) {
      this.log('Validation failed, dropping batch', validation.reason);
      this.isFlushing = false;
      return;
    }

    try {
      await this.sendWithRetry(payload);
    } catch (error) {
      this.log('Send failed permanently, requeueing batch', error);
      this.queue = [...batch, ...this.queue];
    } finally {
      this.isFlushing = false;
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
  }

  private enqueue(event: QueuedEvent): void {
    if (!this.consentGranted) {
      return;
    }

    this.queue.push(event);
    if (this.queue.length >= this.batchSize) {
      this.scheduleFlush();
    }
  }

  private scheduleFlush(): void {
    void this.flush().catch((error) => {
      this.log('Unexpected flush failure', error);
    });
  }

  private async sendWithRetry(payload: IngestBatch): Promise<void> {
    let attempt = 0;
    let delay = 250;

    while (attempt <= this.maxRetries) {
      try {
        const response = await fetch(`${this.endpoint}/v1/collect`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': this.apiKey,
          },
          body: JSON.stringify(payload),
          keepalive: true,
        });

        if (!response.ok) {
          throw new Error(`ingest status=${response.status}`);
        }

        return;
      } catch (error) {
        attempt += 1;
        if (attempt > this.maxRetries) {
          throw error;
        }

        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
      }
    }
  }

  private startAutoFlush(): void {
    if (!this.hasIngestConfig) {
      return;
    }

    this.flushTimer = setInterval(() => {
      this.scheduleFlush();
    }, this.flushIntervalMs);

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('beforeunload', () => {
        this.scheduleFlush();
      });
    }
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
      const [storedAnonId, storedSessionId, storedLastSeen] = await Promise.all([
        readStorageAsync(this.storage, DEVICE_ID_KEY),
        readStorageAsync(this.storage, SESSION_ID_KEY),
        readStorageAsync(this.storage, LAST_SEEN_KEY),
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

  private deferEventUntilHydrated(action: () => void): void {
    const maxDeferredEvents = 1000;
    if (this.deferredEventsBeforeHydration.length >= maxDeferredEvents) {
      this.deferredEventsBeforeHydration.shift();
      this.log('Dropping oldest deferred pre-hydration event to cap memory usage');
    }

    this.deferredEventsBeforeHydration.push(action);
  }

  private drainDeferredEventsAfterHydration(): void {
    if (this.deferredEventsBeforeHydration.length === 0) {
      return;
    }

    const deferred = this.deferredEventsBeforeHydration;
    this.deferredEventsBeforeHydration = [];

    for (const action of deferred) {
      try {
        action();
      } catch (error) {
        this.log('Failed to emit deferred pre-hydration event', error);
      }
    }
  }

  private cloneProperties(properties?: EventProperties): EventProperties | undefined {
    if (!properties) {
      return undefined;
    }

    return { ...properties };
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

  private withRuntimeMetadata(properties: EventProperties | undefined, sessionId: string): EventProperties {
    const sanitized = sanitizeProperties(properties);
    const nextEventIndex = this.sessionEventSeq + 1;
    this.sessionEventSeq = nextEventIndex;
    this.writeSessionEventSeq(sessionId, nextEventIndex);

    if (typeof sanitized.runtimeEnv !== 'string') {
      sanitized.runtimeEnv = this.runtimeEnv;
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
    if (
      !this.dedupeOnboardingStepViewsPerSession ||
      eventName !== ONBOARDING_EVENTS.STEP_VIEW
    ) {
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

  private getOnboardingStepViewDedupeKey(properties: EventProperties | undefined): string | null {
    if (!properties) {
      return null;
    }

    const flowId = toStableKey(this.readPropertyAsString(properties.onboardingFlowId)) ?? 'unknown_flow';
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

  private withEventContext(): EventContext {
    return {
      appBuild: this.context.appBuild,
      osName: this.context.osName,
      osVersion: this.context.osVersion,
      country: this.context.country,
      region: this.context.region,
      city: this.context.city,
    };
  }

  private normalizeOptions(options: unknown): Partial<AnalyticsClientOptions> {
    if (typeof options !== 'object' || options === null) {
      return {};
    }

    return options as Partial<AnalyticsClientOptions>;
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
      '[analyticscli-sdk] Missing required `apiKey`. Tracking is disabled (safe no-op). Pass your long write key.',
    );
  }
}
