import type { DatabaseProtocol, RemoteImportSource, TransferSelection } from '../../api/types.ts';
import { protocolDefaultPorts } from '../../components/protocols.ts';

export interface RemoteValues {
  host: string;
  port: number | string;
  tls: boolean;
  database: string;
  username: string;
  password: string;
  authenticationDatabase: string;
  databaseIndex: number | string;
  apiKey: string;
}

export type ImportArchiveChoice = 'auto' | 'unwrapped' | 'gzip' | 'bzip2' | 'tar' | 'tar.gz' | 'zip';

export const REMOTE_IMPORT_DISABLED_MESSAGE =
  'Remote database imports are disabled by the active DBEV configuration. Enable security.remote_import.enabled, restart DBEV, and refresh this database before using this source.';

export function remoteImportSourceState(enabled: boolean): { disabled: boolean; message: string | null } {
  return {
    disabled: !enabled,
    message: enabled ? null : REMOTE_IMPORT_DISABLED_MESSAGE,
  };
}

export function defaultRemote(protocol: DatabaseProtocol): RemoteValues {
  return {
    host: '',
    port: protocolDefaultPorts[protocol],
    tls: true,
    database: '',
    username: '',
    password: '',
    authenticationDatabase: '',
    databaseIndex: 0,
    apiKey: '',
  };
}

export function buildRemoteSource(protocol: DatabaseProtocol, value: RemoteValues): RemoteImportSource {
  const source: RemoteImportSource = {
    type: 'remote',
    host: value.host.trim(),
    port: Number(value.port),
    tls: value.tls,
  };
  if (['postgres', 'mysql', 'mariadb', 'clickhouse'].includes(protocol)) {
    return { ...source, database: value.database.trim(), username: value.username.trim(), password: value.password };
  }
  if (protocol === 'mongodb') {
    return {
      ...source,
      database: value.database.trim(),
      username: value.username.trim() || undefined,
      password: value.password || undefined,
      authentication_database: value.username.trim()
        ? value.authenticationDatabase.trim() || value.database.trim()
        : undefined,
    };
  }
  if (['redis', 'valkey'].includes(protocol)) {
    return {
      ...source,
      database_index: Number(value.databaseIndex) || 0,
      username: value.username.trim() || undefined,
      password: value.password || undefined,
    };
  }
  return { ...source, api_key: value.apiKey || undefined };
}

export function remoteCredentialError(protocol: DatabaseProtocol, value: RemoteValues): string | null {
  const credential = protocol === 'qdrant' ? value.apiKey : value.password;
  const label = protocol === 'qdrant' ? 'Qdrant API key' : 'Remote password';
  return new TextEncoder().encode(credential).length > 4_096 ? `${label} must not exceed 4096 UTF-8 bytes.` : null;
}

export function buildSelection(include: string[], exclude: string[]): TransferSelection {
  const included = uniqueNames(include);
  if (!included.length) throw new Error('Select at least one table or collection.');
  const includedSet = new Set(included);
  return {
    mode: 'selective',
    include: included,
    exclude: uniqueNames(exclude).filter((name) => !includedSet.has(name)),
  };
}

export function resolveImportArchiveFormat(
  protocol: DatabaseProtocol,
  filename: string,
  choice: ImportArchiveChoice,
): string | undefined {
  if (['redis', 'valkey', 'qdrant'].includes(protocol)) return undefined;
  if (choice !== 'auto') return choice === 'unwrapped' ? undefined : choice;

  const lower = filename.toLowerCase();
  if (protocol === 'mongodb' && lower.endsWith('.archive.gz')) return undefined;
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz';
  if (lower.endsWith('.tar')) return 'tar';
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.bz2') || lower.endsWith('.bzip2')) return 'bzip2';
  if (lower.endsWith('.gz') || lower.endsWith('.gzip')) return 'gzip';
  return undefined;
}

export function archiveFormatLabel(protocol: DatabaseProtocol, filename: string): string {
  const detected = resolveImportArchiveFormat(protocol, filename, 'auto');
  if (detected) return detected === 'tar.gz' ? 'Tar + gzip' : detected.toUpperCase();
  const lower = filename.toLowerCase();
  if (['redis', 'valkey', 'qdrant'].includes(protocol) || (protocol === 'mongodb' && lower.endsWith('.archive.gz'))) {
    return 'Native database archive';
  }
  return 'Unwrapped dump';
}

export function transferDiagnostic(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (!value || typeof value !== 'object') return null;
  const diagnostic = value as Record<string, unknown>;
  const message = transferDiagnostic(diagnostic.message ?? diagnostic.error ?? diagnostic.detail ?? diagnostic.cause);
  if (!message) return null;
  const code = typeof diagnostic.code === 'string' && diagnostic.code.trim() ? ` [${diagnostic.code.trim()}]` : '';
  return `${message}${code}`;
}

function uniqueNames(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
