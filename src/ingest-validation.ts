import { DEFAULT_INGEST_LIMITS, EVENT_NAME_REGEX } from './sdk-contract.js';
import type { QueuedEvent } from './types.js';

type IngestBatch = {
  sentAt?: string;
  events: QueuedEvent[];
};

type IngestValidationResult = {
  success: true;
} | {
  success: false;
  reason: string;
};

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DATETIME_WITH_OFFSET_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const TYPE_VALUES = new Set(['track', 'screen', 'identify']);

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const isStringBetween = (value: unknown, min: number, max: number): value is string => {
  return typeof value === 'string' && value.length >= min && value.length <= max;
};

const isOptionalStringMax = (value: unknown, max: number): boolean => {
  return value === undefined || (typeof value === 'string' && value.length <= max);
};

const isNullableOptionalStringBetween = (value: unknown, min: number, max: number): boolean => {
  return value === undefined || value === null || isStringBetween(value, min, max);
};

const isIsoDatetimeWithOffset = (value: unknown): boolean => {
  if (typeof value !== 'string' || !ISO_DATETIME_WITH_OFFSET_REGEX.test(value)) {
    return false;
  }

  return Number.isFinite(Date.parse(value));
};

const validateEvent = (event: unknown, index: number): IngestValidationResult => {
  if (!isRecord(event)) {
    return { success: false, reason: `events[${index}] is not an object` };
  }

  if (!isStringBetween(event.eventName, 1, 100) || !EVENT_NAME_REGEX.test(event.eventName)) {
    return { success: false, reason: `events[${index}].eventName is invalid` };
  }

  if (!isStringBetween(event.sessionId, 1, 128)) {
    return { success: false, reason: `events[${index}].sessionId is invalid` };
  }

  if (!isStringBetween(event.anonId, 1, 128)) {
    return { success: false, reason: `events[${index}].anonId is invalid` };
  }

  if (!isNullableOptionalStringBetween(event.userId, 1, 128)) {
    return { success: false, reason: `events[${index}].userId is invalid` };
  }

  if (!isRecord(event.properties)) {
    return { success: false, reason: `events[${index}].properties is invalid` };
  }

  if (!isOptionalStringMax(event.platform, 64)) {
    return { success: false, reason: `events[${index}].platform is invalid` };
  }

  if (!isOptionalStringMax(event.projectSurface, 64)) {
    return { success: false, reason: `events[${index}].projectSurface is invalid` };
  }

  if (!isOptionalStringMax(event.appVersion, 64)) {
    return { success: false, reason: `events[${index}].appVersion is invalid` };
  }

  if (!isOptionalStringMax(event.appBuild, 64)) {
    return { success: false, reason: `events[${index}].appBuild is invalid` };
  }

  if (!isOptionalStringMax(event.osName, 64)) {
    return { success: false, reason: `events[${index}].osName is invalid` };
  }

  if (!isOptionalStringMax(event.osVersion, 64)) {
    return { success: false, reason: `events[${index}].osVersion is invalid` };
  }

  if (!isOptionalStringMax(event.deviceModel, 128)) {
    return { success: false, reason: `events[${index}].deviceModel is invalid` };
  }

  if (!isOptionalStringMax(event.deviceManufacturer, 128)) {
    return { success: false, reason: `events[${index}].deviceManufacturer is invalid` };
  }

  if (!isOptionalStringMax(event.deviceType, 32)) {
    return { success: false, reason: `events[${index}].deviceType is invalid` };
  }

  if (!isOptionalStringMax(event.locale, 32)) {
    return { success: false, reason: `events[${index}].locale is invalid` };
  }

  if (!isOptionalStringMax(event.country, 8)) {
    return { success: false, reason: `events[${index}].country is invalid` };
  }

  if (!isOptionalStringMax(event.region, 96)) {
    return { success: false, reason: `events[${index}].region is invalid` };
  }

  if (!isOptionalStringMax(event.city, 96)) {
    return { success: false, reason: `events[${index}].city is invalid` };
  }

  if (!isOptionalStringMax(event.timezone, 64)) {
    return { success: false, reason: `events[${index}].timezone is invalid` };
  }

  if (!isOptionalStringMax(event.networkType, 32)) {
    return { success: false, reason: `events[${index}].networkType is invalid` };
  }

  if (!isOptionalStringMax(event.carrier, 64)) {
    return { success: false, reason: `events[${index}].carrier is invalid` };
  }

  if (!isOptionalStringMax(event.installSource, 64)) {
    return { success: false, reason: `events[${index}].installSource is invalid` };
  }

  if (event.eventId !== undefined && (typeof event.eventId !== 'string' || !UUID_REGEX.test(event.eventId))) {
    return { success: false, reason: `events[${index}].eventId is invalid` };
  }

  if (event.ts !== undefined && !isIsoDatetimeWithOffset(event.ts)) {
    return { success: false, reason: `events[${index}].ts is invalid` };
  }

  if (event.type !== undefined && (typeof event.type !== 'string' || !TYPE_VALUES.has(event.type))) {
    return { success: false, reason: `events[${index}].type is invalid` };
  }

  return { success: true };
};

export const validateIngestBatch = (batch: IngestBatch): IngestValidationResult => {
  if (batch.sentAt !== undefined && !isIsoDatetimeWithOffset(batch.sentAt)) {
    return { success: false, reason: 'sentAt is invalid' };
  }

  if (!Array.isArray(batch.events)) {
    return { success: false, reason: 'events is invalid' };
  }

  if (batch.events.length === 0 || batch.events.length > DEFAULT_INGEST_LIMITS.maxBatchSize) {
    return { success: false, reason: 'events length is out of bounds' };
  }

  for (let index = 0; index < batch.events.length; index += 1) {
    const result = validateEvent(batch.events[index], index);
    if (!result.success) {
      return result;
    }
  }

  return { success: true };
};

export type { IngestBatch, IngestValidationResult };
