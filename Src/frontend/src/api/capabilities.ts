export interface DbevCapabilities {
  storedTenantCredentials: boolean;
  temporaryDumpUploads: boolean;
  mongodbSourceDiscovery: boolean;
  schedulerRecommendations: boolean;
}

function parseVersion(value: unknown): number[] | null {
  if (typeof value !== 'string') return null;
  const match = value
    .trim()
    .replace(/^v/, '')
    .match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

export function versionAtLeast(value: unknown, minimum: readonly [number, number, number]): boolean {
  const version = parseVersion(value);
  if (!version) return false;
  for (let index = 0; index < minimum.length; index += 1) {
    if (version[index] !== minimum[index]) return version[index] > minimum[index];
  }
  return true;
}

export function dbevCapabilities(system: Record<string, unknown>): DbevCapabilities {
  return {
    storedTenantCredentials: versionAtLeast(system.api_version, [0, 10, 0]),
    temporaryDumpUploads: versionAtLeast(system.api_version, [0, 11, 0]),
    mongodbSourceDiscovery: versionAtLeast(system.api_version, [0, 12, 0]),
    schedulerRecommendations: versionAtLeast(system.api_version, [0, 12, 0]),
  };
}

export function databaseCapabilities(metadata: Record<string, unknown>): DbevCapabilities {
  return dbevCapabilities(metadata);
}
