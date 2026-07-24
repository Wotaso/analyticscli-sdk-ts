# Changelog

All notable changes to `@analyticscli/sdk` will be documented in this file.

## Unreleased

- Added a bounded in-memory queue (`maxQueueSize`, default `1000`) with
  payload-free `onEventsDropped` diagnostics.
- Permanent collector `4xx` failures are now dropped instead of being requeued
  forever; retryable network/`408`/`425`/`429`/`5xx` failures remain queued.
- Added poison-event isolation, safe JSON serialization, and automatic batch
  splitting at the collector's `128 KiB` payload limit.
- Event properties now receive recursive, case-/separator-insensitive PII and
  secret-key sanitization before enqueue, including nested objects and arrays
  with cycle/depth protection.
- Revoking event-collection consent now aborts an active request and prevents
  its batch from being requeued.
- Added additive `flushAll({ timeoutMs })` and
  `shutdownAsync({ timeoutMs })` drain APIs without changing `flush()` or
  synchronous `shutdown()`.

## 0.1.0-preview.16

- Paywall SDK contract updated to use `offeringId` as the canonical offering key.
- Removed legacy `offering` compatibility field and dropped legacy passthrough from paywall event payload normalization.
- `offeringId` is optional at type/runtime level, but strongly recommended in tracker defaults and paywall/purchase events for better funnel segmentation.
