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
import { initFromEnv, ONBOARDING_EVENTS } from '@prodinfos/sdk-ts';

const analytics = initFromEnv();

analytics.trackOnboardingEvent(ONBOARDING_EVENTS.START, {
  onboardingFlowId: 'onboarding_v1',
});
```

By default, `initFromEnv()` resolves credentials from these env keys:

- `PRODINFOS_WRITE_KEY`
- `NEXT_PUBLIC_PRODINFOS_WRITE_KEY`
- `EXPO_PUBLIC_PRODINFOS_WRITE_KEY`
- `VITE_PRODINFOS_WRITE_KEY`
- `PRODINFOS_PROJECT_ID`
- `NEXT_PUBLIC_PRODINFOS_PROJECT_ID`
- `EXPO_PUBLIC_PRODINFOS_PROJECT_ID`
- `VITE_PRODINFOS_PROJECT_ID`

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
import { initFromEnv } from '@prodinfos/sdk-ts';

const analytics = initFromEnv({
  debug: typeof __DEV__ === 'boolean' ? __DEV__ : false,
  platform: 'react-native',
  appVersion: '1.0.0',
  dedupeOnboardingStepViewsPerSession: true,
  storage: {
    getItem: (key) => AsyncStorage.getItem(key),
    setItem: (key, value) => AsyncStorage.setItem(key, value),
    removeItem: (key) => AsyncStorage.removeItem(key),
  },
});

void analytics.ready();
```

Use your project-specific write key and `projectId` from the Prodinfos dashboard in your workspace.
The SDK uses the default collector endpoint internally.
In host apps, do not pass `endpoint` and do not add `PRODINFOS_ENDPOINT` env vars.

## Releases

In the public mirror repository, every successful `Release to npm` run creates or updates
the matching GitHub Release (`v<package.json version>`) and links to the published npm version.

Source of truth for this package is the private monorepo path `packages/sdk-ts`.
Public mirror source prefix: `packages/sdk-ts`.
