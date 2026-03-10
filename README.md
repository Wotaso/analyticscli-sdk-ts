# @prodinfos/sdk-ts

TypeScript SDK for tenant developers sending onboarding, paywall, purchase, and survey analytics events to the Prodinfos ingest API.

Current npm release channel: preview / experimental beta.

## Install

```bash
npm install @prodinfos/sdk-ts@preview
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

## Releases

In the public mirror repository, every successful `Release to npm` run creates or updates
the matching GitHub Release (`v<package.json version>`) and links to the published npm version.

Source of truth for this package is the private monorepo path `packages/sdk-ts`.
Public mirror source prefix: `packages/sdk-ts`.
