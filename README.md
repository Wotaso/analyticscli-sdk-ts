# @analyticscli/sdk

TypeScript-first SDK for tenant developers sending onboarding, paywall, purchase, and survey analytics events to the AnalyticsCLI ingest API.

Using a coding agent: you can let it handle SDK integration and instrumentation end-to-end with the AnalyticsCLI skills repo:
https://github.com/Wotaso/analyticscli-skills

Use the same package in:
- React Native / Expo apps
- Browser React apps
- plain JavaScript and TypeScript codebases

Current npm release channel: preview / experimental beta.
If no stable release exists yet, `latest` points to the newest preview.
Once stable releases exist, `latest` is pinned to the newest stable.

## Install

```bash
npm install @analyticscli/sdk@preview
```

When a stable release becomes available, install without a tag:

```bash
npm install @analyticscli/sdk
```

## Dashboard Credentials

Before integrating, collect required values in [dash.analyticscli.com](https://dash.analyticscli.com):

- Select the target project.
- Open **API Keys** and copy the publishable ingest API key for SDK `apiKey`.
- If you validate with CLI, create/copy a CLI `readonly_token` in the same **API Keys** area.
- Optional for CLI verification: set a default project once with `analyticscli projects select` (arrow-key picker), or pass `--project <project_id>` per command.

## Usage (Low Boilerplate)

```ts
import { init } from '@analyticscli/sdk';

const analytics = init({
  apiKey: '<YOUR_APP_KEY>',
  identityTrackingMode: 'consent_gated', // explicit host-app default
});

const onboarding = analytics.createOnboardingTracker({
  onboardingFlowId: 'onboarding_v1',
  onboardingFlowVersion: '1.0.0',
  isNewUser: true,
});

onboarding.start();
onboarding.step('welcome', 0).view();
```

`init(...)` returns `AnalyticsClient` directly.
Use tracker factories for flow-scoped instrumentation:
- `analytics.createOnboardingTracker(...)`
- `analytics.createPaywallTracker(...)`

For host-app integration, prefer explicit client config with
`identityTrackingMode: 'consent_gated'` unless you intentionally need another mode.

Optional runtime collection pause/resume:

```ts
import { init } from '@analyticscli/sdk';

const analytics = init({
  apiKey: '<YOUR_APP_KEY>',
  identityTrackingMode: 'consent_gated',
});
analytics.optOut(); // stop sending until optIn()
// ...
analytics.optIn();
```

Optional full-tracking consent gate (recommended default):

```ts
import { init } from '@analyticscli/sdk';

const analytics = init({
  apiKey: '<YOUR_APP_KEY>',
  identityTrackingMode: 'consent_gated',
});

// user accepts full tracking in your consent UI
analytics.setFullTrackingConsent(true);

// user rejects full tracking but you still keep strict anonymous analytics
analytics.setFullTrackingConsent(false);
```

If `apiKey` is missing, the SDK logs a console error and remains a safe no-op client.

## Optional Configuration

```ts
import * as Application from 'expo-application';
import { Platform } from 'react-native';
import { init } from '@analyticscli/sdk';

const analytics = init({
  apiKey: process.env.EXPO_PUBLIC_ANALYTICSCLI_PUBLISHABLE_API_KEY,
  debug: __DEV__,
  platform: Platform.OS,
  projectSurface: 'app',
  appVersion: Application.nativeApplicationVersion,
  initialConsentGranted: true,
  identityTrackingMode: 'consent_gated',
  initialFullTrackingConsentGranted: false,
  dedupeOnboardingStepViewsPerSession: true,
  dedupeScreenViewsPerSession: true,
  dedupeOnboardingScreenStepViewOverlapsPerSession: true,
  screenViewDedupeWindowMs: 1200,
});
```

The SDK normalizes React Native/Expo platform values to canonical ingest values
(`macos` -> `mac`, `win32` -> `windows`) and accepts `null` for optional
`appVersion` inputs.
Use `projectSurface` for product/channel separation (`landing`, `dashboard`, `app`)
without overloading runtime `platform` (`web`, `ios`, `android`, ...).

`dedupeOnboardingStepViewsPerSession` dedupes duplicate `onboarding:step_view`
events for the same step in the same session.
When a new `onboarding:start` is emitted in the same session, step-view dedupe
state resets for that flow attempt.
`dedupeScreenViewsPerSession` dedupes immediate duplicate `screen(...)` calls
for the same screen key in the same session (for example, when focus and mount
hooks both fire for one transition). `screenViewDedupeWindowMs` controls this
window (default `1200` ms) and also applies to onboarding screen/step overlap dedupe.
`dedupeOnboardingScreenStepViewOverlapsPerSession` drops immediate overlaps
between onboarding route-level `screen:*` events and `onboarding:step_view`
for the same step (default `true`).
Neither setting dedupes paywall or purchase events.

For paywall funnels with stable `source` + `paywallId`, create one tracker per
flow context and reuse it:

```ts
const paywall = analytics.createPaywallTracker({
  source: 'onboarding',
  paywallId: 'default_paywall',
  offeringId: 'rc_main', // RevenueCat example
});

paywall.shown({ fromScreen: 'onboarding_offer' });
paywall.purchaseSuccess();
```

Do not create a new `createPaywallTracker(...)` instance for every paywall callback/event.
Strongly prefer passing `offeringId` in tracker defaults
(RevenueCat offering id, Adapty paywall/placement id, Superwall placement/paywall id).

For onboarding surveys, avoid repeating unchanged flow metadata at every callsite.
Create one onboarding tracker with defaults and emit minimal survey payloads:

```ts
const onboarding = analytics.createOnboardingTracker({
  onboardingFlowId: 'onboarding_main',
  onboardingFlowVersion: '1',
  stepCount: 7,
  isNewUser: true,
});

onboarding.step('budget-survey', 6).surveyResponse({
  surveyKey: 'onboarding_main',
  questionKey: 'budget',
  answerType: 'single_choice',
  responseKey: '100-500',
});
```

Lean onboarding event strategy (recommended):
- Emit `onboarding:step_view` as the default per-step progress signal.
- Emit `onboarding:step_complete` only when the step has explicit completion semantics
  (for example submit/continue confirmation or async success).
- For survey steps, `onboarding:step_view` + `onboarding:survey_response` is usually enough.

Tenant feedback collection is also supported:

```ts
const analytics = init({
  apiKey: process.env.EXPO_PUBLIC_ANALYTICSCLI_PUBLISHABLE_API_KEY,
  feedback: {
    serviceUrl: 'https://api.analyticscli.com',
    apiKey: process.env.EXPO_PUBLIC_ANALYTICSCLI_FEEDBACK_KEY,
    surface: 'ios_app',
    originName: 'settings feedback sheet',
  },
});

await analytics.submitFeedback({
  message: 'The restore screen is unclear.',
  category: 'ux',
  locationId: 'settings/restore',
  originName: 'restore purchases footer',
});
```

Best practice:
- always send a stable `locationId`
- always send a stable `originName` so feedback can be traced back to the exact product surface
- point `feedback.serviceUrl` at a tenant-owned backend/proxy or the AnalyticsCLI feedback endpoint
- for AnalyticsCLI-backed feedback, use a project-scoped public feedback key; `appId` is optional and only needed for third-party endpoints that require it
- do not put privileged feedback secrets into mobile client binaries
- the SDK tracks lightweight `feedback:*` analytics events without including the raw message text

For RevenueCat correlation, keep identity and paywall purchase metadata aligned:

```ts
analytics.setUser(appUserId); // same id passed to Purchases.logIn(appUserId)
// in purchase callbacks, prefer provider-native ids
paywall.purchaseStarted({
  offeringId: 'rc_main',
  packageId: packageBeingPurchased.identifier, // optional, still useful for plan-level breakdowns
});
// on sign-out
analytics.clearUser();
```

Identity tracking modes:
- `consent_gated` (default): starts strict (no persistent identity), enables persistence/linkage only after full-tracking consent is granted
- `always_on`: enables persistence/linkage immediately (`enableFullTrackingWithoutConsent: true` is a boolean shortcut)
- `strict`: keeps strict anonymous behavior permanently

Recommendation for global tenant apps:
- keep `consent_gated` as default, especially when EU/EEA/UK traffic is in scope

In strict phase (and in `strict` mode):
- no persistent SDK identity across app/browser restarts
- no cookie-domain identity continuity
- `analytics.identify(...)` / `analytics.setUser(...)` are ignored

`initialConsentGranted` is optional:
- default: `true` when `apiKey` is present
- you can still pause/resume collection at runtime with consent APIs when your app needs that

Runtime collection control APIs:
- `analytics.getConsent()` -> current in-memory consent
- `analytics.getConsentState()` -> `'granted' | 'denied' | 'unknown'`
- `analytics.optIn()` / `analytics.optOut()`
- `analytics.setConsent(true|false)`

Full-tracking control APIs:
- `analytics.setFullTrackingConsent(true|false)`
- `analytics.optInFullTracking()` / `analytics.optOutFullTracking()`
- `analytics.isFullTrackingEnabled()`

`analytics.ready()` does not "start" tracking. With default settings, tracking
starts on `init(...)`.

Use your project-specific publishable API key from the AnalyticsCLI dashboard in your workspace.
Only the publishable API key (`apiKey`) is needed for SDK setup calls.
The SDK uses the default collector endpoint internally.
In host apps, do not pass `endpoint` and do not add `ANALYTICSCLI_ENDPOINT` env vars.

Browser cookie-domain continuity is disabled while strict mode is active.
For redirects across different domains, use a backend-issued short-lived handoff token rather than relying on third-party cookies.

## Releases

Use npm package versions and GitHub Releases in the public SDK repository as
the source for release history.
