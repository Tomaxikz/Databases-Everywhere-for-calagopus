export interface DbevCapabilities {
  storedTenantCredentials: boolean;
  temporaryDumpUploads: boolean;
  mongodbSourceDiscovery: boolean;
  schedulerRecommendations: boolean;
}

export interface DbevMutationContract {
  compatible: boolean;
  message: string | null;
}

export const DBEV_SERVICE = 'databases-everywhere';
export const DBEV_MUTATION_API_VERSION = '0.12.0';

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

export function dbevMutationContract(system: Record<string, unknown> | null | undefined): DbevMutationContract {
  if (!system) {
    return {
      compatible: false,
      message:
        'The DatabasesEverywhere node has not been sampled yet. Test the connection before changing node or database state.',
    };
  }
  const service = typeof system.service === 'string' ? system.service : 'an unknown service';
  if (service !== DBEV_SERVICE) {
    return {
      compatible: false,
      message: `This extension requires the ${DBEV_SERVICE} service, but this node reports ${service}. Read-only diagnostics remain available.`,
    };
  }
  const version = typeof system.api_version === 'string' ? system.api_version : 'an unknown version';
  if (version !== DBEV_MUTATION_API_VERSION) {
    return {
      compatible: false,
      message: `This extension supports DatabasesEverywhere API ${DBEV_MUTATION_API_VERSION}, but this node reports ${version}. Update the extension or daemon before changing node or database state.`,
    };
  }
  const missingGuard = [
    'prevent_cpu_overallocation',
    'prevent_memory_overallocation',
    'prevent_disk_overallocation',
  ].find((field) => typeof system[field] !== 'boolean');
  if (missingGuard) {
    return {
      compatible: false,
      message: `DatabasesEverywhere API ${DBEV_MUTATION_API_VERSION} response is missing required field ${missingGuard}.`,
    };
  }
  return { compatible: true, message: null };
}
