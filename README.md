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
import { init, ONBOARDING_EVENTS } from '@analyticscli/sdk';

const analytics = init({
  apiKey: '<YOUR_APP_KEY>',
  identityTrackingMode: 'consent_gated', // explicit host-app default
});

analytics.trackOnboardingEvent(ONBOARDING_EVENTS.START, {
  onboardingFlowId: 'onboarding_v1',
});
```

`init(...)` accepts either:

- `init('<YOUR_APP_KEY>')`
- `init({ ...allOptionsOptional })`

For host-app integration, prefer object init with an explicit
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

`initFromEnv()` remains available and resolves credentials from these env keys:

- `ANALYTICSCLI_PUBLISHABLE_API_KEY`
- `NEXT_PUBLIC_ANALYTICSCLI_PUBLISHABLE_API_KEY`
- `EXPO_PUBLIC_ANALYTICSCLI_PUBLISHABLE_API_KEY`
- `VITE_ANALYTICSCLI_PUBLISHABLE_API_KEY`

Runtime-specific env helpers are also available:

- `@analyticscli/sdk` -> `initBrowserFromEnv(...)`
  - adds `PUBLIC_ANALYTICSCLI_PUBLISHABLE_API_KEY` lookup for Astro/browser-first setups
- `@analyticscli/sdk` -> `initReactNativeFromEnv(...)`
  - defaults to native-friendly env key lookup
- optional compatibility subpaths:
  - `@analyticscli/sdk/browser`
  - `@analyticscli/sdk/react-native`

If config is missing, the client is a safe no-op (default behavior).
When `apiKey` is missing, the SDK logs a console error and remains no-op.
Use strict mode if you want hard failure:

```ts
const analytics = initFromEnv({
  missingConfigMode: 'throw',
});
```

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
});
```

The SDK normalizes React Native/Expo platform values to canonical ingest values
(`macos` -> `mac`, `win32` -> `windows`) and accepts `null` for optional
`appVersion` inputs.
Use `projectSurface` for product/channel separation (`landing`, `dashboard`, `app`)
without overloading runtime `platform` (`web`, `ios`, `android`, ...).

`dedupeOnboardingStepViewsPerSession` only dedupes duplicate
`onboarding:step_view` events for the same step in the same session (for
example, when React effects fire twice or the screen remounts). It does not
dedupe paywall events, purchase events, or `screen(...)` calls.

For paywall funnels with stable `source` + `paywallId`, create one tracker per
flow context and reuse it:

```ts
const paywall = analytics.createPaywallTracker({
  source: 'onboarding',
  paywallId: 'default_paywall',
  offering: 'rc_main', // RevenueCat example
});

paywall.shown({ fromScreen: 'onboarding_offer' });
paywall.purchaseSuccess({ packageId: 'annual' });
```

Do not create a new `createPaywallTracker(...)` instance for every paywall callback/event.
If your paywall provider exposes it, pass `offering` in tracker defaults
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

For RevenueCat correlation, keep identity and paywall purchase metadata aligned:

```ts
analytics.setUser(appUserId); // same id passed to Purchases.logIn(appUserId)
// in purchase callbacks, prefer provider-native ids
paywall.purchaseStarted({ packageId: packageBeingPurchased.identifier });
// on sign-out
analytics.clearUser();
```

Identity tracking modes:
- `consent_gated` (default): starts strict (no persistent identity), enables persistence/linkage only after `setFullTrackingConsent(true)`
- `always_on`: enables persistence/linkage immediately (`enableFullTrackingWithoutConsent: true` is a boolean shortcut)
- `strict`: keeps strict anonymous behavior permanently

Recommendation for global tenant apps:
- keep `consent_gated` as default, especially when EU/EEA/UK traffic is in scope

In strict phase (and in `strict` mode):
- no persistent SDK identity across app/browser restarts
- no cookie-domain identity continuity
- `identify()` / `setUser(...)` are ignored

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
Only the publishable API key (`apiKey`) is needed for SDK init calls.
The SDK uses the default collector endpoint internally.
In host apps, do not pass `endpoint` and do not add `ANALYTICSCLI_ENDPOINT` env vars.

Browser cookie-domain continuity is disabled while strict mode is active.
For redirects across different domains, use a backend-issued short-lived handoff token rather than relying on third-party cookies.

## Releases

Use npm package versions and GitHub Releases in the public SDK repository as
the source for release history.
