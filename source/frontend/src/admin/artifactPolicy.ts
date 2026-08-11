import { versionAtLeast } from '../api/capabilities.ts';
import type { NodeRecord } from '../api/types.ts';

export const DEFAULT_STREAM_EXPORTS_ONLY = false;
export const DEFAULT_MAX_ARTIFACTS_PER_INSTANCE = 20;
export const MIN_ARTIFACTS_PER_INSTANCE = 1;
export const MAX_ARTIFACTS_PER_INSTANCE = 10_000;

export interface ArtifactPolicyConfiguration {
  stream_exports_only: boolean;
  max_artifacts_per_instance: number;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function artifactPolicyFromConfiguration(configuration: unknown): ArtifactPolicyConfiguration {
  const artifacts = recordValue(recordValue(configuration).artifacts);
  const maximum = artifacts.max_artifacts_per_instance;
  return {
    stream_exports_only:
      typeof artifacts.stream_exports_only === 'boolean' ? artifacts.stream_exports_only : DEFAULT_STREAM_EXPORTS_ONLY,
    max_artifacts_per_instance:
      typeof maximum === 'number' &&
      Number.isInteger(maximum) &&
      maximum >= MIN_ARTIFACTS_PER_INSTANCE &&
      maximum <= MAX_ARTIFACTS_PER_INSTANCE
        ? maximum
        : DEFAULT_MAX_ARTIFACTS_PER_INSTANCE,
  };
}

export function artifactPolicyError(configuration: ArtifactPolicyConfiguration): string | null {
  const maximum = configuration.max_artifacts_per_instance;
  return Number.isInteger(maximum) && maximum >= MIN_ARTIFACTS_PER_INSTANCE && maximum <= MAX_ARTIFACTS_PER_INSTANCE
    ? null
    : `Maximum exports per database must be ${MIN_ARTIFACTS_PER_INSTANCE}–${MAX_ARTIFACTS_PER_INSTANCE}.`;
}

export function artifactPolicyPatch(configuration: ArtifactPolicyConfiguration) {
  return {
    artifacts: {
      stream_exports_only: configuration.stream_exports_only,
      max_artifacts_per_instance: configuration.max_artifacts_per_instance,
    },
  };
}

export function nodeSupportsArtifactPolicy(node: NodeRecord): boolean {
  const daemonVersion = node.cached_system?.version;
  if (typeof daemonVersion === 'string' && daemonVersion.trim()) {
    return versionAtLeast(daemonVersion, [0, 5, 2]);
  }
  const artifacts = recordValue(node.configuration.artifacts);
  return 'stream_exports_only' in artifacts || 'max_artifacts_per_instance' in artifacts;
}
