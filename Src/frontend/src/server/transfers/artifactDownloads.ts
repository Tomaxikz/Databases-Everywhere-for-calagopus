import { type DbevMutationFailure, responseStatus } from '../../api/mutationErrors.ts';
import type { ArtifactRecord } from '../../api/types.ts';

export type ArtifactAvailability = 'retained' | 'one-use' | 'unavailable';

const downloadedOneUseArtifacts = new Set<string>();
const ONE_USE_EXPIRY_MS = 60 * 60 * 1_000;

function downloadKey(server: string, database: string, artifact: string): string {
  return `${server}:${database}:${artifact}`;
}

export function markOneUseArtifactDownloaded(server: string, database: string, artifact: string): void {
  downloadedOneUseArtifacts.add(downloadKey(server, database, artifact));
}

export function oneUseArtifactWasDownloaded(server: string, database: string, artifact: string): boolean {
  return downloadedOneUseArtifacts.has(downloadKey(server, database, artifact));
}

export function oneUseArtifactExpired(timestamp: string | undefined, now = Date.now()): boolean {
  if (!timestamp) return false;
  const created = Date.parse(timestamp);
  return Number.isFinite(created) && now - created >= ONE_USE_EXPIRY_MS;
}

export function artifactAvailability(
  artifactId: string,
  artifacts: ArtifactRecord[],
  streamExportsOnly: boolean,
  unavailable = false,
): ArtifactAvailability {
  if (unavailable) return 'unavailable';
  if (artifacts.some((artifact) => artifact.id === artifactId || artifact.artifact_id === artifactId)) {
    return 'retained';
  }
  return streamExportsOnly ? 'one-use' : 'unavailable';
}

export function isArtifactGone(error: unknown): boolean {
  return responseStatus(error) === 404;
}

export function artifactCapacityGuidance(failure: DbevMutationFailure): string | null {
  if (failure.status !== 409) return null;
  return `${failure.message} Download or delete an existing export before creating another. DBEV did not remove any files automatically.`;
}

export function startBrowserDownload(url: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = '';
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}
