import type { DatabaseProtocol } from '../../api/types.ts';

export default function defaultNamespace(protocol: DatabaseProtocol, databaseName: string): string | null {
  switch (protocol) {
    case 'postgres':
      return 'public';
    case 'mysql':
    case 'mariadb':
    case 'mongodb':
    case 'clickhouse':
      return databaseName;
    case 'redis':
    case 'valkey':
    case 'qdrant':
      return null;
  }
}
