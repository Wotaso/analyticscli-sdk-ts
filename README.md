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

## Usage

```ts
import { init, ONBOARDING_EVENTS } from '@prodinfos/sdk-ts';

const analytics = init({
  apiKey: 'pi_live_...',
  projectId: '11111111-1111-4111-8111-111111111111',
});

analytics.trackOnboardingEvent(ONBOARDING_EVENTS.START, {
  onboardingFlowId: 'onboarding_v1',
});
```

Use your project-specific write key and `projectId` from the Prodinfos dashboard in your workspace.
The SDK uses the default collector endpoint internally.
In host apps, do not pass `endpoint` and do not add `PRODINFOS_ENDPOINT` env vars.

## Releases

In the public mirror repository, every successful `Release to npm` run creates or updates
the matching GitHub Release (`v<package.json version>`) and links to the published npm version.

Source of truth for this package is the private monorepo path `packages/sdk-ts`.
Public mirror source prefix: `packages/sdk-ts`.
