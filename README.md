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

const analytics = init('<YOUR_APP_KEY>'); // short form

analytics.trackOnboardingEvent(ONBOARDING_EVENTS.START, {
  onboardingFlowId: 'onboarding_v1',
});
```

`init(...)` accepts either:

- `init('<YOUR_APP_KEY>')`
- `init({ ...allOptionsOptional })`

Consent-first shortcut (recommended for production):

```ts
import { initConsentFirst } from '@analyticscli/sdk';

const analytics = initConsentFirst('<YOUR_APP_KEY>');
// later, after explicit user opt-in:
analytics.optIn();
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
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Application from 'expo-application';
import { Platform } from 'react-native';
import { init } from '@analyticscli/sdk';

const analytics = init({
  apiKey: process.env.EXPO_PUBLIC_ANALYTICSCLI_PUBLISHABLE_API_KEY,
  debug: __DEV__,
  platform: Platform.OS,
  projectSurface: 'app',
  appVersion: Application.nativeApplicationVersion,
  initialConsentGranted: false,
  persistConsentState: true,
  consentStorageKey: 'myapp:analytics:consent:v1',
  dedupeOnboardingStepViewsPerSession: true,
  storage: AsyncStorage,
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

The SDK currently runs in strict privacy mode:
- no persistent SDK identity across app/browser restarts
- no cookie-domain identity continuity
- `identify()` / `setUser(...)` do not create user linkage events

`initialConsentGranted` is optional:
- default: `true` when `apiKey` is present (backward-compatible)
- set to `false` for consent-first integration, then call `analytics.optIn()`
  after explicit user consent.

`persistConsentState`, `consentStorageKey`, `storage`, `cookieDomain`, and
`useCookieStorage` are accepted for backward compatibility but ignored in the
current strict-only behavior.

Common consent APIs:
- `analytics.getConsent()` -> current in-memory consent
- `analytics.getConsentState()` -> `'granted' | 'denied' | 'unknown'`
- `analytics.optIn()` / `analytics.optOut()`
- `analytics.setConsent(true|false, { persist: true|false })`

`analytics.ready()` does not "start" tracking. If consent is granted, the SDK
starts on `init(...)`.
Call `ready()` (or use `initAsync(...)`) only when your app should block until
hydration is finished before continuing first-flow logic.

Use your project-specific publishable API key from the AnalyticsCLI dashboard in your workspace.
Only the publishable API key (`apiKey`) is needed for SDK init calls.
The SDK uses the default collector endpoint internally.
In host apps, do not pass `endpoint` and do not add `ANALYTICSCLI_ENDPOINT` env vars.

Browser cookie-domain continuity is disabled in strict-only mode.
For redirects across different domains, use a backend-issued short-lived handoff token rather than relying on third-party cookies.

## Releases

Use npm package versions and GitHub Releases in the public SDK repository as
the source for release history.
