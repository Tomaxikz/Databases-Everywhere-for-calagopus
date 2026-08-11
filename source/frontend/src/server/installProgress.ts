import type { DatabaseInstallProgress } from '../api/types.ts';

const CREATION_STATES = new Set(['creating', 'booting']);
const FAILED_STATES = new Set(['failed', 'quarantined']);

export function isDatabaseProgressActive(progress: DatabaseInstallProgress, instanceStatus: string): boolean {
  const progressStatus = progress.status?.toLowerCase();
  const progressStage = progress.stage?.toLowerCase();
  if (progressStatus === 'completed' || progressStage === 'completed') return false;

  if (progress.action !== 'create') return true;

  const status = instanceStatus.toLowerCase();
  if (CREATION_STATES.has(status)) return true;

  return progressStatus === 'failed' && FAILED_STATES.has(status);
}
