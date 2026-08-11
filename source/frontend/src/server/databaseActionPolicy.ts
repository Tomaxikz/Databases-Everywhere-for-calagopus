export interface DatabaseActionPolicy {
  start: boolean;
  stop: boolean;
  restart: boolean;
  kill: boolean;
  resetCredential: boolean;
  updateImage: boolean;
  useConnection: boolean;
  reconcile: boolean;
  inspect: boolean;
  delete: boolean;
}

export function databaseActionPolicy(
  status: string,
  options: { scannerRestartBlocked?: boolean } = {},
): DatabaseActionPolicy {
  const running = status === 'running';
  const stopped = status === 'stopped';
  const quarantined = status === 'quarantined';
  const transitional = ['creating', 'booting', 'deleting'].includes(status);

  const policy: DatabaseActionPolicy = {
    start: stopped || status === 'failed',
    stop: running,
    restart: running,
    kill: running || status === 'booting',
    resetCredential: running,
    updateImage: running,
    useConnection: running,
    reconcile: !transitional,
    inspect: true,
    delete: true,
    ...(quarantined
      ? {
          start: false,
          stop: false,
          restart: false,
          kill: false,
          resetCredential: false,
          updateImage: false,
          useConnection: false,
          reconcile: true,
        }
      : {}),
  };

  if (options.scannerRestartBlocked) {
    policy.start = false;
    policy.restart = false;
  }

  return policy;
}
