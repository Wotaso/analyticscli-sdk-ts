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
import { createAnalyticsContext } from '@analyticscli/sdk';

const analytics = createAnalyticsContext({
  client: {
    apiKey: '<YOUR_APP_KEY>',
    identityTrackingMode: 'consent_gated', // explicit host-app default
  },
  onboarding: {
    onboardingFlowId: 'onboarding_v1',
    onboardingFlowVersion: '1.0.0',
    isNewUser: true,
  },
});

analytics.onboarding.start();
analytics.onboarding.step('welcome', 0).view();
```

`createAnalyticsContext(...)` gives you:
- `analytics.client` (raw `AnalyticsClient`)
- `analytics.onboarding` (pre-wired tracker instance)
- `analytics.paywall` (optional tracker instance)
- `analytics.consent.*` (collection + full-tracking controls)
- `analytics.user.*` (`set`, `clear`, `identify`)

For host-app integration, prefer explicit client config with
`identityTrackingMode: 'consent_gated'` unless you intentionally need another mode.

Optional runtime collection pause/resume:

```ts
import { createAnalyticsContext } from '@analyticscli/sdk';

const analytics = createAnalyticsContext({
  client: {
    apiKey: '<YOUR_APP_KEY>',
    identityTrackingMode: 'consent_gated',
  },
});
analytics.consent.optOut(); // stop sending until optIn()
// ...
analytics.consent.optIn();
```

Optional full-tracking consent gate (recommended default):

```ts
import { createAnalyticsContext } from '@analyticscli/sdk';

const analytics = createAnalyticsContext({
  client: {
    apiKey: '<YOUR_APP_KEY>',
    identityTrackingMode: 'consent_gated',
  },
});

// user accepts full tracking in your consent UI
analytics.consent.setFullTracking(true);

// user rejects full tracking but you still keep strict anonymous analytics
analytics.consent.setFullTracking(false);
```

If `apiKey` is missing, the SDK logs a console error and remains a safe no-op client.

## Optional Configuration

```ts
import * as Application from 'expo-application';
import { Platform } from 'react-native';
import { createAnalyticsContext } from '@analyticscli/sdk';

const analytics = createAnalyticsContext({
  client: {
    apiKey: process.env.EXPO_PUBLIC_ANALYTICSCLI_PUBLISHABLE_API_KEY,
    debug: __DEV__,
    platform: Platform.OS,
    projectSurface: 'app',
    appVersion: Application.nativeApplicationVersion,
    initialConsentGranted: true,
    identityTrackingMode: 'consent_gated',
    initialFullTrackingConsentGranted: false,
    dedupeOnboardingStepViewsPerSession: true,
  },
  onboarding: {
    onboardingFlowId: 'onboarding_main',
    onboardingFlowVersion: '1',
    isNewUser: true,
    stepCount: 7,
  },
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
const paywall = analytics.createPaywall({
  source: 'onboarding',
  paywallId: 'default_paywall',
  offering: 'rc_main', // RevenueCat example
});

paywall.shown({ fromScreen: 'onboarding_offer' });
paywall.purchaseSuccess({ packageId: 'annual' });
```

Do not create a new `createPaywall(...)` instance for every paywall callback/event.
If your paywall provider exposes it, pass `offering` in tracker defaults
(RevenueCat offering id, Adapty paywall/placement id, Superwall placement/paywall id).

For onboarding surveys, avoid repeating unchanged flow metadata at every callsite.
Create one onboarding tracker with defaults and emit minimal survey payloads:

```ts
const onboarding = analytics.createOnboarding({
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
analytics.user.set(appUserId); // same id passed to Purchases.logIn(appUserId)
// in purchase callbacks, prefer provider-native ids
paywall.purchaseStarted({ packageId: packageBeingPurchased.identifier });
// on sign-out
analytics.user.clear();
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
- `analytics.user.identify(...)` / `analytics.user.set(...)` are ignored

`initialConsentGranted` is optional:
- default: `true` when `apiKey` is present
- you can still pause/resume collection at runtime with consent APIs when your app needs that

Runtime collection control APIs:
- `analytics.consent.get()` -> current in-memory consent
- `analytics.consent.getState()` -> `'granted' | 'denied' | 'unknown'`
- `analytics.consent.optIn()` / `analytics.consent.optOut()`
- `analytics.consent.set(true|false)`

Full-tracking control APIs:
- `analytics.consent.setFullTracking(true|false)`
- `analytics.consent.optInFullTracking()` / `analytics.consent.optOutFullTracking()`
- `analytics.consent.isFullTrackingEnabled()`

`analytics.ready()` / `analytics.client.ready()` do not "start" tracking. With default settings, tracking
starts on `createAnalyticsContext(...)`.

Use your project-specific publishable API key from the AnalyticsCLI dashboard in your workspace.
Only the publishable API key (`apiKey`) is needed for SDK setup calls.
The SDK uses the default collector endpoint internally.
In host apps, do not pass `endpoint` and do not add `ANALYTICSCLI_ENDPOINT` env vars.

Browser cookie-domain continuity is disabled while strict mode is active.
For redirects across different domains, use a backend-issued short-lived handoff token rather than relying on third-party cookies.

## Releases

Use npm package versions and GitHub Releases in the public SDK repository as
the source for release history.
