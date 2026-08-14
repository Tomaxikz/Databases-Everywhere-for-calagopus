import type {
  ImportExportSchedulerConfiguration,
  SchedulerRecommendation,
  SchedulerRecommendationRequest,
} from '../api/types.ts';

export const DEFAULT_IMPORT_UPLOAD_MAX_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_SCHEDULER_INPUT_BYTES = 68_719_476_736;

export const DEFAULT_SCHEDULER_CONFIGURATION: ImportExportSchedulerConfiguration = {
  dynamic_limiter_enabled: true,
  max_queued_jobs: 1024,
  max_queued_jobs_per_instance: 32,
  manual_max_active_jobs: 16,
  dynamic_max_active_jobs: 256,
  dynamic_memory_budget_mib: 0,
  dynamic_io_budget_mib: 0,
  dynamic_cpu_units: 0,
  starvation_timeout_seconds: 30,
  max_bypass: 8,
};

export function configuredImportUploadMaxBytes(configuration: unknown): number {
  const root =
    configuration && typeof configuration === 'object' && !Array.isArray(configuration)
      ? (configuration as Record<string, unknown>)
      : {};
  const artifacts =
    root.artifacts && typeof root.artifacts === 'object' && !Array.isArray(root.artifacts)
      ? (root.artifacts as Record<string, unknown>)
      : {};
  const configured = artifacts.import_upload_max_bytes;
  return typeof configured === 'number' &&
    Number.isSafeInteger(configured) &&
    configured >= 1 &&
    configured <= MAX_SCHEDULER_INPUT_BYTES
    ? configured
    : DEFAULT_IMPORT_UPLOAD_MAX_BYTES;
}

export function schedulerRecommendationDefaults(sizeBytes: number): SchedulerRecommendationRequest {
  return {
    protocol: 'postgres',
    action: 'import',
    size_bytes: sizeBytes,
    target_disk_mib: Math.ceil(sizeBytes / 1_048_576),
    mode: 'merge',
    compressed: false,
  };
}

export function schedulerConfiguration(value: unknown): ImportExportSchedulerConfiguration {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const number = (key: keyof ImportExportSchedulerConfiguration) =>
    typeof record[key] === 'number' && Number.isFinite(record[key])
      ? (record[key] as number)
      : (DEFAULT_SCHEDULER_CONFIGURATION[key] as number);
  return {
    dynamic_limiter_enabled:
      typeof record.dynamic_limiter_enabled === 'boolean'
        ? record.dynamic_limiter_enabled
        : DEFAULT_SCHEDULER_CONFIGURATION.dynamic_limiter_enabled,
    max_queued_jobs: number('max_queued_jobs'),
    max_queued_jobs_per_instance: number('max_queued_jobs_per_instance'),
    manual_max_active_jobs: number('manual_max_active_jobs'),
    dynamic_max_active_jobs: number('dynamic_max_active_jobs'),
    dynamic_memory_budget_mib: number('dynamic_memory_budget_mib'),
    dynamic_io_budget_mib: number('dynamic_io_budget_mib'),
    dynamic_cpu_units: number('dynamic_cpu_units'),
    starvation_timeout_seconds: number('starvation_timeout_seconds'),
    max_bypass: number('max_bypass'),
  };
}

export function schedulerConfigurationError(value: ImportExportSchedulerConfiguration): string | null {
  const integerIn = (candidate: number, minimum: number, maximum: number) =>
    Number.isInteger(candidate) && candidate >= minimum && candidate <= maximum;
  if (!integerIn(value.max_queued_jobs, 64, 8_192)) return 'Maximum queued jobs must be 64–8192.';
  if (!integerIn(value.max_queued_jobs_per_instance, 1, 256)) {
    return 'Maximum queued jobs per database must be 1–256.';
  }
  if (!integerIn(value.manual_max_active_jobs, 1, 1_024)) return 'Manual active jobs must be 1–1024.';
  if (!integerIn(value.dynamic_max_active_jobs, 1, 1_024)) return 'Dynamic active jobs must be 1–1024.';
  if (
    value.max_queued_jobs_per_instance > value.max_queued_jobs ||
    value.manual_max_active_jobs > value.max_queued_jobs ||
    value.dynamic_max_active_jobs > value.max_queued_jobs
  ) {
    return 'Per-database and active-job limits cannot exceed the durable queue limit.';
  }
  if (!integerIn(value.dynamic_memory_budget_mib, 128, 16_777_216) && value.dynamic_memory_budget_mib !== 0) {
    return 'Dynamic memory must be 0 or 128–16,777,216 MiB.';
  }
  if (!integerIn(value.dynamic_io_budget_mib, 256, 67_108_864) && value.dynamic_io_budget_mib !== 0) {
    return 'Dynamic I/O must be 0 or 256–67,108,864 MiB.';
  }
  if (!integerIn(value.dynamic_cpu_units, 0, 65_536)) return 'Dynamic CPU units must be 0–65,536.';
  if (!integerIn(value.starvation_timeout_seconds, 1, 3_600)) return 'Starvation timeout must be 1–3600 seconds.';
  if (!integerIn(value.max_bypass, 0, 1_024)) return 'Maximum bypass must be 0–1024.';
  return null;
}

export function schedulerConfigurationPatch(value: ImportExportSchedulerConfiguration) {
  return { artifacts: { import_export_scheduler: { ...value } } };
}

export function applySchedulerRecommendation(
  value: ImportExportSchedulerConfiguration,
  recommended: number,
): ImportExportSchedulerConfiguration {
  if (!Number.isInteger(recommended) || recommended < 1) return value;
  return value.dynamic_limiter_enabled
    ? { ...value, dynamic_max_active_jobs: recommended }
    : { ...value, manual_max_active_jobs: recommended };
}

export function recommendationPresentation(recommendation: SchedulerRecommendation | undefined): {
  insufficientMemory: boolean;
  isolated: boolean;
} {
  if (!recommendation) return { insufficientMemory: false, isolated: false };
  const capacity = recommendation.scheduler.capacity;
  const estimate = recommendation.estimate;
  const memorySafe = estimate.memory_mib <= capacity.memory_budget_mib;
  const isolated =
    recommendation.recommended_active_jobs > 0 &&
    memorySafe &&
    (estimate.cpu_units > capacity.cpu_units || estimate.io_mib > capacity.io_budget_mib);
  return { insufficientMemory: recommendation.recommended_active_jobs === 0, isolated };
}
