# Changelog

All notable changes to `@analyticscli/sdk` will be documented in this file.

## 0.1.0-preview.16

- Paywall SDK contract updated to use `offeringId` as the canonical offering key.
- Removed legacy `offering` compatibility field and dropped legacy passthrough from paywall event payload normalization.
- `offeringId` is optional at type/runtime level, but strongly recommended in tracker defaults and paywall/purchase events for better funnel segmentation.
