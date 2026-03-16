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
  appVersion: Application.nativeApplicationVersion,
  dedupeOnboardingStepViewsPerSession: true,
  storage: AsyncStorage,
});
```

The SDK normalizes React Native/Expo platform values to canonical ingest values
(`macos` -> `mac`, `win32` -> `windows`) and accepts `null` for optional
`appVersion` inputs.

`dedupeOnboardingStepViewsPerSession` only dedupes duplicate
`onboarding:step_view` events for the same step in the same session (for
example, when React effects fire twice or the screen remounts). It does not
dedupe paywall events, purchase events, or `screen(...)` calls.

`storage` is optional, but recommended in React Native. With AsyncStorage, the
SDK can persist `anonId` and `sessionId` across app restarts so funnels and
journeys stay connected. Without storage, IDs are memory-only and reset on
cold start.

If your store already exposes `getItem` / `setItem` / `removeItem` (for example
AsyncStorage, localStorage-like stores, or Expo key-value stores with the same
method names), pass it directly as `storage`.

If your store uses different method names, pass a small adapter object:

```ts
storage: {
  getItem: (key) => store.read(key),
  setItem: (key, value) => store.write(key, value),
  removeItem: (key) => store.delete(key),
}
```

`analytics.ready()` does not "start" tracking. The SDK starts immediately on
`init(...)`, and with async storage it defers pre-hydration events internally.
Call `ready()` (or use `initAsync(...)`) only when your app should block until
hydration is finished before continuing first-flow logic.

Use your project-specific publishable API key from the AnalyticsCLI dashboard in your workspace.
Only the publishable API key (`apiKey`) is needed for SDK init calls.
The SDK uses the default collector endpoint internally.
In host apps, do not pass `endpoint` and do not add `ANALYTICSCLI_ENDPOINT` env vars.

For browser subdomain continuity, set `cookieDomain` (for example `.analyticscli.com`).
For redirects across different domains, use a backend-issued short-lived handoff token rather than relying on third-party cookies.

## Releases

Use npm package versions and GitHub Releases in the public SDK repository as
the source for release history.
