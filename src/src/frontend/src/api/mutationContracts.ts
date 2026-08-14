export const DBEV_LONG_MUTATION_TIMEOUT_MS = 15 * 60 * 1_000;

export interface ImageUpdatePayload {
  image: string;
  major_upgrade: boolean;
  password?: string;
}

export function imageUpdatePayload(image: string, majorUpgrade: boolean, legacyPassword?: string): ImageUpdatePayload {
  const payload: ImageUpdatePayload = { image, major_upgrade: majorUpgrade };
  // Never serialize an empty legacy credential.
  if (legacyPassword !== undefined && legacyPassword.length > 0) payload.password = legacyPassword;
  return payload;
}

export interface UploadImportPayload {
  source: {
    type: 'upload';
    upload_id: string;
    source_database?: string;
  };
  mode: 'merge' | 'wipe';
}

export function uploadImportPayload(
  uploadId: string,
  mode: 'merge' | 'wipe',
  sourceDatabase?: string,
): UploadImportPayload {
  const normalizedSourceDatabase = sourceDatabase?.trim();
  return {
    source: {
      type: 'upload',
      upload_id: uploadId,
      ...(normalizedSourceDatabase ? { source_database: normalizedSourceDatabase } : {}),
    },
    mode,
  };
}

export function acceptedTransfer(result: unknown, location: unknown): AcceptedTransfer {
  return {
    job: result && typeof result === 'object' && !Array.isArray(result) ? (result as Record<string, unknown>) : {},
    location: typeof location === 'string' && location ? location : null,
  };
}

export function exportRequestPayload(
  protocol: DatabaseProtocol,
  archiveFormat?: string,
  selection?: TransferSelection,
): Record<string, unknown> {
  const physical = ['redis', 'valkey', 'qdrant'].includes(protocol);
  const normalizedFormat = physical
    ? undefined
    : protocol === 'mongodb' && archiveFormat === 'gzip'
      ? 'plain'
      : archiveFormat;
  return {
    ...(normalizedFormat ? { archive_format: normalizedFormat } : {}),
    ...(selection ? { selection } : {}),
  };
}

export function schedulerRecommendationParams(request: SchedulerRecommendationRequest): SchedulerRecommendationRequest {
  return {
    ...request,
    mode: request.action === 'export' ? 'merge' : request.mode,
    compressed: ['mongodb', 'redis', 'valkey', 'qdrant'].includes(request.protocol) || request.compressed,
  };
}

export function parseSchedulerRecommendation(value: unknown): SchedulerRecommendation {
  const root = objectValue(value);
  const scheduler = objectValue(root.scheduler);
  const capacity = objectValue(scheduler.capacity);
  const estimate = objectValue(root.estimate);
  const numbers: unknown[] = [
    capacity.max_active_jobs,
    capacity.memory_budget_mib,
    capacity.io_budget_mib,
    capacity.cpu_units,
    scheduler.active_jobs,
    scheduler.waiting_jobs,
    scheduler.active_memory_mib,
    scheduler.active_io_mib,
    scheduler.active_cpu_units,
    estimate.input_size_bytes,
    estimate.memory_mib,
    estimate.io_mib,
    estimate.cpu_units,
    root.recommended_active_jobs,
    root.admitted_jobs,
    root.max_queued_jobs,
    root.max_queued_jobs_per_instance,
  ];
  if (
    typeof capacity.mode !== 'string' ||
    typeof scheduler.accepting !== 'boolean' ||
    numbers.some((candidate) => typeof candidate !== 'number' || !Number.isFinite(candidate))
  ) {
    throw new Error('DatabasesEverywhere returned an invalid scheduler recommendation.');
  }
  return value as SchedulerRecommendation;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('DatabasesEverywhere returned an invalid scheduler recommendation.');
  }
  return value as Record<string, unknown>;
}

import type {
  AcceptedTransfer,
  DatabaseProtocol,
  SchedulerRecommendation,
  SchedulerRecommendationRequest,
  TransferSelection,
} from './types.ts';
