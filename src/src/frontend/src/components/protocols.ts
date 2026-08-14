import type { DatabaseProtocol } from '../api/types.ts';

export const protocolLabels: Record<DatabaseProtocol, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  redis: 'Redis',
  valkey: 'Valkey',
  mongodb: 'MongoDB',
  clickhouse: 'ClickHouse',
  qdrant: 'Qdrant',
};

export const protocolDefaultPorts: Record<DatabaseProtocol, number> = {
  postgres: 5432,
  mysql: 3306,
  mariadb: 3306,
  redis: 6379,
  valkey: 6379,
  mongodb: 27017,
  clickhouse: 9000,
  qdrant: 6333,
};

export const protocolConsoleExamples: Record<DatabaseProtocol, string> = {
  postgres: 'SELECT current_database(), current_user, now();',
  mysql: 'SELECT DATABASE(), CURRENT_USER(), NOW();',
  mariadb: 'SELECT DATABASE(), CURRENT_USER(), NOW();',
  redis: 'INFO server',
  valkey: 'INFO server',
  mongodb: '{ "find": "example", "filter": {}, "limit": 25 }',
  clickhouse: 'SELECT database(), currentUser(), now()',
  qdrant: '{ "operation": "list_collections" }',
};

export const supportsSelectiveExport = (protocol: DatabaseProtocol) =>
  protocol !== 'redis' && protocol !== 'valkey' && protocol !== 'qdrant';

export const supportsSelectiveImport = (protocol: DatabaseProtocol, source: 'artifact' | 'remote') =>
  protocol !== 'redis' && protocol !== 'valkey' && !(protocol === 'qdrant' && source === 'artifact');
