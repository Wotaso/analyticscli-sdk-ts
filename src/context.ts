import { AnalyticsClient } from './analytics-client.js';
import type {
  AnalyticsConsentState,
  EventContext,
  EventProperties,
  InitInput,
  InitOptions,
  OnboardingEventProperties,
  OnboardingSurveyResponseInput,
  OnboardingTracker,
  OnboardingTrackerDefaults,
  PaywallEventProperties,
  PaywallTracker,
  PaywallTrackerDefaults,
  SetConsentOptions,
} from './types.js';
import type {
  OnboardingEventName,
  OnboardingSurveyEventName,
  PaywallJourneyEventName,
} from './sdk-contract.js';

type ContextClientInput = InitInput | AnalyticsClient | null | undefined;

export type AnalyticsContextConsentControls = {
  get: () => boolean;
  getState: () => AnalyticsConsentState;
  set: (granted: boolean, options?: SetConsentOptions) => void;
  optIn: (options?: SetConsentOptions) => void;
  optOut: (options?: SetConsentOptions) => void;
  setFullTracking: (granted: boolean, options?: SetConsentOptions) => void;
  optInFullTracking: (options?: SetConsentOptions) => void;
  optOutFullTracking: (options?: SetConsentOptions) => void;
  isFullTrackingEnabled: () => boolean;
};

export type AnalyticsContextUserControls = {
  identify: (userId: string, traits?: EventProperties) => void;
  set: (userId: string | null | undefined, traits?: EventProperties) => void;
  clear: () => void;
};

export type AnalyticsContext = {
  client: AnalyticsClient;
  onboarding: OnboardingTracker;
  paywall: PaywallTracker | null;
  consent: AnalyticsContextConsentControls;
  user: AnalyticsContextUserControls;
  track: (eventName: string, properties?: EventProperties) => void;
  trackOnboardingEvent: (
    eventName: OnboardingEventName,
    properties?: OnboardingEventProperties,
  ) => void;
  trackOnboardingSurveyResponse: (
    input: OnboardingSurveyResponseInput,
    eventName?: OnboardingSurveyEventName,
  ) => void;
  trackPaywallEvent: (eventName: PaywallJourneyEventName, properties: PaywallEventProperties) => void;
  screen: (name: string, properties?: EventProperties) => void;
  page: (name: string, properties?: EventProperties) => void;
  feedback: (message: string, rating?: number, properties?: EventProperties) => void;
  setContext: (context: EventContext) => void;
  createOnboarding: (defaults: OnboardingTrackerDefaults) => OnboardingTracker;
  createPaywall: (defaults: PaywallTrackerDefaults) => PaywallTracker;
  configureOnboarding: (defaults: OnboardingTrackerDefaults) => OnboardingTracker;
  configurePaywall: (defaults: PaywallTrackerDefaults) => PaywallTracker;
  ready: () => Promise<void>;
  flush: () => Promise<void>;
  shutdown: () => void;
};

export type CreateAnalyticsContextOptions = {
  /**
   * Either an existing client instance or standard `init(...)` input.
   */
  client?: ContextClientInput;
  /**
   * Defaults used for the exported `context.onboarding` tracker instance.
   */
  onboarding?: OnboardingTrackerDefaults | null;
  /**
   * Optional defaults used for the exported `context.paywall` tracker instance.
   */
  paywall?: PaywallTrackerDefaults | null;
};

const normalizeInitInput = (input: InitInput): InitOptions => {
  if (typeof input === 'string') {
    return { apiKey: input };
  }
  if (input === null || input === undefined) {
    return {};
  }
  return input;
};

const resolveClient = (input: ContextClientInput): AnalyticsClient => {
  if (input instanceof AnalyticsClient) {
    return input;
  }
  return new AnalyticsClient(normalizeInitInput(input ?? {}));
};

/**
 * Host-app friendly SDK context with low boilerplate and rich defaults.
 * Provides pre-wired onboarding + consent/user controls and optional paywall tracker binding.
 */
export const createAnalyticsContext = (
  options: CreateAnalyticsContextOptions = {},
): AnalyticsContext => {
  const client = resolveClient(options.client);

  let onboardingTracker = client.createOnboardingTracker(options.onboarding ?? {});
  let paywallTracker = options.paywall ? client.createPaywallTracker(options.paywall) : null;

  const consent: AnalyticsContextConsentControls = {
    get: () => client.getConsent(),
    getState: () => client.getConsentState(),
    set: (granted, setOptions) => client.setConsent(granted, setOptions),
    optIn: (setOptions) => client.optIn(setOptions),
    optOut: (setOptions) => client.optOut(setOptions),
    setFullTracking: (granted, setOptions) => client.setFullTrackingConsent(granted, setOptions),
    optInFullTracking: (setOptions) => client.optInFullTracking(setOptions),
    optOutFullTracking: (setOptions) => client.optOutFullTracking(setOptions),
    isFullTrackingEnabled: () => client.isFullTrackingEnabled(),
  };

  const user: AnalyticsContextUserControls = {
    identify: (userId, traits) => client.identify(userId, traits),
    set: (userId, traits) => client.setUser(userId, traits),
    clear: () => client.clearUser(),
  };

  return {
    client,
    get onboarding() {
      return onboardingTracker;
    },
    get paywall() {
      return paywallTracker;
    },
    consent,
    user,
    track: (eventName, properties) => client.track(eventName, properties),
    trackOnboardingEvent: (eventName, properties) => client.trackOnboardingEvent(eventName, properties),
    trackOnboardingSurveyResponse: (input, eventName) =>
      client.trackOnboardingSurveyResponse(input, eventName),
    trackPaywallEvent: (eventName, properties) => client.trackPaywallEvent(eventName, properties),
    screen: (name, properties) => client.screen(name, properties),
    page: (name, properties) => client.page(name, properties),
    feedback: (message, rating, properties) => client.feedback(message, rating, properties),
    setContext: (context) => client.setContext(context),
    createOnboarding: (defaults) => client.createOnboardingTracker(defaults),
    createPaywall: (defaults) => client.createPaywallTracker(defaults),
    configureOnboarding: (defaults) => {
      onboardingTracker = client.createOnboardingTracker(defaults);
      return onboardingTracker;
    },
    configurePaywall: (defaults) => {
      paywallTracker = client.createPaywallTracker(defaults);
      return paywallTracker;
    },
    ready: () => client.ready(),
    flush: () => client.flush(),
    shutdown: () => client.shutdown(),
  };
};
