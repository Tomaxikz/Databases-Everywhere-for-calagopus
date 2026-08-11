import { z } from 'zod';
import type {
  DatabaseBackupRecord,
  DatabaseMonitoringInstance,
  DbevDiskEnforcementStrength,
  DbevDiskResourceReport,
  DbevResourceReport,
  QueryOutput,
} from './types.ts';

const databaseBackupSchema = z
  .object({
    id: z.string().optional().catch(undefined),
    backup_id: z.string().optional().catch(undefined),
    artifact_id: z.string().optional().catch(undefined),
    instance_id: z.string().optional().catch(undefined),
    size_bytes: z.number().nonnegative().optional().catch(undefined),
    modified_at: z.string().optional().catch(undefined),
    created_at: z.string().optional().catch(undefined),
    sha256: z.string().optional().catch(undefined),
  })
  .passthrough();

const emptyQueryOutput: QueryOutput = {
  columns: [],
  rows: [],
  affected_rows: null,
  elapsed_ms: 0,
  truncated: false,
};

const queryOutputSchema = z
  .object({
    columns: z.array(z.string()).catch([]),
    rows: z.array(z.unknown()).catch([]),
    affected_rows: z.number().int().nonnegative().nullable().catch(null),
    elapsed_ms: z.number().nonnegative().catch(0),
    truncated: z.boolean().catch(false),
  })
  .catch(emptyQueryOutput);

/** Reduces malformed hot-reload responses to an empty query result. */
export function normalizeQueryOutput(value: unknown): QueryOutput {
  return queryOutputSchema.parse(value);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function backupCandidates(value: unknown, depth = 0): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (depth > 4) return null;

  const candidate = record(value);
  if (!candidate) return null;
  if (['id', 'backup_id', 'artifact_id'].some((key) => typeof candidate[key] === 'string')) return [candidate];

  for (const key of ['backups', 'items', 'data', 'result']) {
    if (!Object.hasOwn(candidate, key)) continue;
    const nested = backupCandidates(candidate[key], depth + 1);
    if (nested !== null) return nested;
  }
  return null;
}

/** Accepts current backup records and older wrapped or ID-only responses. */
export function normalizeDatabaseBackups(value: unknown): DatabaseBackupRecord[] {
  const seen = new Set<string>();
  return (backupCandidates(value) ?? []).flatMap((candidate) => {
    if (typeof candidate === 'string') {
      const id = candidate.trim();
      if (!id || seen.has(id)) return [];
      seen.add(id);
      return [{ id }];
    }

    const parsed = databaseBackupSchema.safeParse(candidate);
    if (!parsed.success) return [];
    const id = (parsed.data.id || parsed.data.backup_id || parsed.data.artifact_id || '').trim();
    if (!id || seen.has(id)) return [];
    seen.add(id);
    const modifiedAt = parsed.data.modified_at || parsed.data.created_at;

    return [
      {
        ...parsed.data,
        id,
        ...(modifiedAt ? { modified_at: modifiedAt } : {}),
      } as DatabaseBackupRecord,
    ];
  });
}

export function diskEnforcementStrength(
  disk: Pick<DbevDiskResourceReport, 'enforced' | 'enforcement_method' | 'enforcement_strength'>,
): DbevDiskEnforcementStrength {
  return (
    disk.enforcement_strength ?? (disk.enforced ? 'hard' : disk.enforcement_method === 'soft_scanner' ? 'soft' : 'none')
  );
}

export function scannerRestartBlockedState(disk: DbevDiskResourceReport, previous?: boolean): boolean | undefined {
  if (typeof disk.scanner_restart_blocked === 'boolean') return disk.scanner_restart_blocked;
  return diskEnforcementStrength(disk) === 'soft' ? previous : false;
}

/** Adds old-node enforcement fallback while preserving unknown and zero-valued fields. */
export function normalizeDbevResourceReport(value: unknown): DbevResourceReport | null {
  const report = record(value);
  const disk = record(report?.disk);
  if (!report || !disk) return null;

  const compatibleDisk = disk as DbevDiskResourceReport;
  return {
    ...report,
    disk: {
      ...compatibleDisk,
      enforcement_strength: diskEnforcementStrength(compatibleDisk),
    },
  } as DbevResourceReport;
}

export function normalizeDbevResourceReports(value: unknown): DbevResourceReport[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const report = normalizeDbevResourceReport(candidate);
    return report ? [report] : [];
  });
}

export function normalizeDatabaseMonitoringInstances(value: unknown): DatabaseMonitoringInstance[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((candidate) => {
    const instance = record(candidate);
    if (!instance || typeof instance.instance_id !== 'string') return [];

    const normalizedResources = normalizeDbevResourceReport(instance.resources);
    return [
      {
        ...instance,
        ...(Object.hasOwn(instance, 'resources') ? { resources: normalizedResources } : {}),
      } as DatabaseMonitoringInstance,
    ];
  });
}
