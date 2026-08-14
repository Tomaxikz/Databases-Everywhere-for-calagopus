import { versionAtLeast } from '../../api/capabilities.ts';
import { responseStatus } from '../../api/mutationErrors.ts';
import type { DumpInspection, StagedUploadList, TemporaryUploadRecord, TemporaryUploadState } from '../../api/types.ts';

const ALLOWED_DUMP_SUFFIXES = [
  '.sql',
  '.dump',
  '.backup',
  '.archive',
  '.archive.gz',
  '.snapshot',
  '.tar.gz',
  '.tgz',
  '.tar',
  '.zip',
  '.gz',
  '.gzip',
  '.bz2',
  '.bzip2',
] as const;

export function apiSupportsTemporaryUploads(apiVersion: unknown): boolean {
  return versionAtLeast(apiVersion, [0, 11, 0]);
}

export function apiSupportsMongoSourceDiscovery(apiVersion: unknown): boolean {
  return versionAtLeast(apiVersion, [0, 12, 0]);
}

export function validateDumpFile(file: Pick<File, 'name' | 'size'>, maxBytes?: number | null): string | null {
  if (file.size <= 0) return 'The selected dump is empty.';
  if (maxBytes && file.size > maxBytes) return 'The selected dump exceeds the panel upload limit.';
  const name = file.name.toLowerCase();
  if (!ALLOWED_DUMP_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
    return 'Choose an SQL, dump, snapshot, gzip, bzip2, tar, or zip file.';
  }
  if (
    !file.name ||
    new TextEncoder().encode(file.name).length > 180 ||
    [...file.name].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return character === '/' || character === '\\' || codePoint < 32 || codePoint === 127;
    })
  ) {
    return 'The dump must have a safe flat filename of at most 180 UTF-8 bytes.';
  }
  return null;
}

export function validateMongoSourceDatabase(value: string): string | null {
  const normalized = value.trim();
  const bytes = new TextEncoder().encode(normalized).length;
  if (
    bytes < 1 ||
    bytes > 63 ||
    [...normalized].some((character) => {
      return (
        character === '\0' ||
        character === '/' ||
        character === '\\' ||
        character === '.' ||
        character === ' ' ||
        character === '"' ||
        character === '$'
      );
    })
  ) {
    return 'Use 1–63 UTF-8 bytes without NUL, ASCII spaces, periods, slashes, double quotes, or dollar signs.';
  }
  return null;
}

export interface MongoSourceDiscoveryState {
  mode: 'auto' | 'select' | 'manual';
  candidates: string[];
  hints: string[];
}

function sourceCandidates(catalog: DumpInspection | null | undefined): string[] {
  return [
    ...new Set(
      (catalog?.namespaces ?? [])
        .filter((candidate): candidate is string => typeof candidate === 'string')
        .map((candidate) => candidate.trim())
        .filter(Boolean),
    ),
  ];
}

export function mongoSourceDiscoveryState(
  catalog: DumpInspection | null | undefined,
  apiVersion: unknown,
): MongoSourceDiscoveryState {
  if (!apiSupportsMongoSourceDiscovery(apiVersion)) return { mode: 'manual', candidates: [], hints: [] };
  const candidates = sourceCandidates(catalog);
  if (catalog?.catalog_complete === true && candidates.length === 1) {
    return { mode: 'auto', candidates, hints: [] };
  }
  if (catalog?.catalog_complete === true && candidates.length > 1) {
    return { mode: 'select', candidates, hints: [] };
  }
  return { mode: 'manual', candidates: [], hints: catalog?.catalog_complete === false ? candidates : [] };
}

export function validateMongoSourceForCatalog(
  value: string,
  catalog: DumpInspection | null | undefined,
  apiVersion: unknown,
): string | null {
  const normalized = value.trim();
  const basic = validateMongoSourceDatabase(normalized);
  if (basic) return basic;
  const discovery = mongoSourceDiscoveryState(catalog, apiVersion);
  if ((discovery.mode === 'auto' || discovery.mode === 'select') && !discovery.candidates.includes(normalized)) {
    return 'Choose a source database reported by the complete dump catalog.';
  }
  return null;
}

export function mongoImportConflictGuidance(
  status: number | null,
  sourceDatabase: string,
  discovery: MongoSourceDiscoveryState,
): string | null {
  if (status !== 409) return null;
  if (discovery.mode === 'auto' || discovery.mode === 'select') {
    return `Re-inspect the dump and select one of the complete catalog databases: ${discovery.candidates.join(', ')}.`;
  }
  return `Re-inspect the dump and correct the original MongoDB database name${sourceDatabase.trim() ? ` “${sourceDatabase.trim()}”` : ''}.`;
}

export function isUploadContractMismatch(error: unknown): boolean {
  const status = responseStatus(error);
  return status === 404 || status === 415;
}

export function uploadFailureGuidance(status: number | null): string | null {
  switch (status) {
    case 400:
      return 'Check the filename, checksum, source database, and import options.';
    case 404:
      return 'The upload may have expired, been deleted, or already been consumed.';
    case 408:
      return 'The upload stalled or exceeded its deadline; choose the file and try again.';
    case 409:
      return 'The database or upload changed state; refresh before trying another action.';
    case 413:
      return 'Choose a file below the configured upload limit.';
    case 415:
      return 'This host did not accept the raw temporary-upload contract.';
    case 429:
      return 'The database host is at its concurrency or rate limit; try again later.';
    case 503:
      return 'The bounded database-host operation is temporarily unavailable.';
    case 500:
      return 'The host returned a safe internal-error reference; no internal details were exposed.';
    default:
      return null;
  }
}

export function isResumableUploadState(state: TemporaryUploadState): boolean {
  return ['uploading', 'uploaded', 'processing', 'ready', 'failed', 'importing'].includes(state);
}

export function canQueueUploadImport(state: TemporaryUploadState): boolean {
  return state === 'ready' || state === 'failed';
}

export function cancellationDeletesUpload(state: TemporaryUploadState, jobAccepted: boolean): boolean {
  return !jobAccepted && ['uploading', 'uploaded', 'processing', 'ready', 'failed'].includes(state);
}

export function resumableUploads(uploads: TemporaryUploadRecord[]): TemporaryUploadRecord[] {
  return uploads.filter((upload) => isResumableUploadState(upload.state));
}

export function markUploadImporting(
  data: StagedUploadList | undefined,
  uploadId: string,
): StagedUploadList | undefined {
  if (!data) return data;
  return {
    ...data,
    uploads: data.uploads.map((upload) =>
      upload.upload_id === uploadId ? { ...upload, state: 'importing' as const } : upload,
    ),
  };
}

export function catalogAllowsSelectiveImport(catalog: DumpInspection | null | undefined): boolean {
  return catalog?.selective_supported === true;
}

const unsupportedKey = (node: string) => `dbev:temporary-upload-unsupported:${node}`;

export function uploadsDisabledForSession(node: string): boolean {
  try {
    return sessionStorage.getItem(unsupportedKey(node)) === '1';
  } catch {
    return false;
  }
}

export function disableUploadsForSession(node: string): void {
  try {
    sessionStorage.setItem(unsupportedKey(node), '1');
  } catch {
    // A blocked storage API must not prevent the safe old-node fallback.
  }
}
