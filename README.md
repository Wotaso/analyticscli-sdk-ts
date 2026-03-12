# @prodinfos/sdk-ts

TypeScript SDK for tenant developers sending onboarding, paywall, purchase, and survey analytics events to the Prodinfos ingest API.

Current npm release channel: preview / experimental beta.
If no stable release exists yet, `latest` points to the newest preview.
Once stable releases exist, `latest` is pinned to the newest stable.

## Install

```bash
npm install @prodinfos/sdk-ts@preview
```

When a stable release becomes available, install without a tag:

```bash
npm install @prodinfos/sdk-ts
```

## Usage (Low Boilerplate)

```ts
import { init, ONBOARDING_EVENTS } from '@prodinfos/sdk-ts';

const analytics = init('<YOUR_APP_KEY>'); // short form

analytics.trackOnboardingEvent(ONBOARDING_EVENTS.START, {
  onboardingFlowId: 'onboarding_v1',
});
```

`init(...)` accepts either:

- `init('<YOUR_APP_KEY>')`
- `init({ ...allOptionsOptional })`

`initFromEnv()` remains available and resolves credentials from these env keys:

- `PRODINFOS_WRITE_KEY`
- `NEXT_PUBLIC_PRODINFOS_WRITE_KEY`
- `EXPO_PUBLIC_PRODINFOS_WRITE_KEY`
- `VITE_PRODINFOS_WRITE_KEY`

If config is missing, the client is a safe no-op (default behavior).
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
import { init } from '@prodinfos/sdk-ts';

const analytics = init({
  apiKey: process.env.EXPO_PUBLIC_PRODINFOS_WRITE_KEY,
  debug: typeof __DEV__ === 'boolean' ? __DEV__ : false,
  platform:
    Platform.OS === 'ios' ||
    Platform.OS === 'android' ||
    Platform.OS === 'windows' ||
    Platform.OS === 'macos'
      ? Platform.OS === 'macos'
        ? 'mac'
        : Platform.OS
      : undefined,
  appVersion: Application.nativeApplicationVersion ?? undefined,
  dedupeOnboardingStepViewsPerSession: true,
  storage: {
    getItem: (key) => AsyncStorage.getItem(key),
    setItem: (key, value) => AsyncStorage.setItem(key, value),
    removeItem: (key) => AsyncStorage.removeItem(key),
  },
});

void analytics.ready();
```

Use your project-specific write key from the Prodinfos dashboard in your workspace.
The SDK uses the default collector endpoint internally.
In host apps, do not pass `endpoint` and do not add `PRODINFOS_ENDPOINT` env vars.

## Releases

Versioning is managed in the private monorepo via Changesets.
Every SDK change should include a changeset entry (`pnpm changeset`), and CI creates
the release version PR (`chore(release): version sdk-ts`) automatically on `main`.

After that release PR is merged, the public mirror repository can run `Release to npm`.
Each successful run creates or updates the matching GitHub Release
(`v<package.json version>`) and links to the published npm version.

Source of truth for this package is the private monorepo path `packages/sdk-ts`.
Public mirror source prefix: `packages/sdk-ts`.
