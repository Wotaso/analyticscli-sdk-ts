export const DEFAULT_INGEST_LIMITS = {
  maxBatchSize: 50,
  maxPayloadBytes: 128 * 1024,
} as const;

export const ONBOARDING_EVENTS = {
  START: 'onboarding:start',
  STEP_VIEW: 'onboarding:step_view',
  STEP_COMPLETE: 'onboarding:step_complete',
  COMPLETE: 'onboarding:complete',
  SKIP: 'onboarding:skip',
} as const;

export type OnboardingEventName = (typeof ONBOARDING_EVENTS)[keyof typeof ONBOARDING_EVENTS];

export const PAYWALL_EVENTS = {
  SHOWN: 'paywall:shown',
  SKIP: 'paywall:skip',
} as const;

export type PaywallEventName = (typeof PAYWALL_EVENTS)[keyof typeof PAYWALL_EVENTS];

export const PURCHASE_EVENTS = {
  STARTED: 'purchase:started',
  SUCCESS: 'purchase:success',
  FAILED: 'purchase:failed',
  CANCEL: 'purchase:cancel',
} as const;

export type PurchaseEventName = (typeof PURCHASE_EVENTS)[keyof typeof PURCHASE_EVENTS];

export type PaywallJourneyEventName = PaywallEventName | PurchaseEventName;

export const ONBOARDING_SURVEY_EVENTS = {
  RESPONSE: 'onboarding:survey_response',
} as const;

export type OnboardingSurveyEventName =
  (typeof ONBOARDING_SURVEY_EVENTS)[keyof typeof ONBOARDING_SURVEY_EVENTS];

export const ONBOARDING_PROGRESS_EVENT_ORDER = [
  ONBOARDING_EVENTS.COMPLETE,
  ONBOARDING_EVENTS.SKIP,
] as const;

export const PAYWALL_JOURNEY_EVENT_ORDER = [
  PAYWALL_EVENTS.SHOWN,
  PAYWALL_EVENTS.SKIP,
  PURCHASE_EVENTS.SUCCESS,
  PURCHASE_EVENTS.FAILED,
] as const;

export const ONBOARDING_SCREEN_EVENT_PREFIXES = ['screen:onboarding', 'screen:onboarding_'] as const;

export const PAYWALL_ANCHOR_EVENT_CANDIDATES = [PAYWALL_EVENTS.SHOWN] as const;

export const PAYWALL_SKIP_EVENT_CANDIDATES = [PAYWALL_EVENTS.SKIP] as const;

export const PURCHASE_SUCCESS_EVENT_CANDIDATES = [PURCHASE_EVENTS.SUCCESS] as const;

export const RESERVED_PII_KEYS = new Set([
  'deviceModel',
  'deviceManufacturer',
  'deviceType',
  'locale',
  'timezone',
  'networkType',
  'carrier',
  'installSource',
  'email',
  'emailAddress',
  'phone',
  'phoneNumber',
  'firstName',
  'lastName',
  'fullName',
  'address',
  'streetAddress',
  'ipAddress',
  'dateOfBirth',
  'ssn',
  'socialSecurityNumber',
  'creditCard',
  'cardNumber',
  'cvv',
  'cvc',
  'iban',
  'bankAccount',
  'password',
  'secret',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'sessionToken',
  'authorization',
  'apiKey',
]);

export const EVENT_NAME_REGEX = /^[a-zA-Z0-9_:\-.]{1,100}$/;
