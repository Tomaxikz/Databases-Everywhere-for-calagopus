import type { DatabaseProtocol } from '../api/types.ts';
import clickhouse from '../assets/clickhouse.svg';
import mariadb from '../assets/mariadb.svg';
import mongodb from '../assets/mongodb.svg';
import mysql from '../assets/mysql.svg';
import postgresql from '../assets/postgresql.svg';
import qdrant from '../assets/qdrant.svg';
import redis from '../assets/redis.svg';
import valkey from '../assets/valkey.svg';

const icons: Record<DatabaseProtocol, string> = {
  postgres: postgresql,
  mysql,
  mariadb,
  redis,
  valkey,
  mongodb,
  clickhouse,
  qdrant,
};

export default function ProtocolIcon({ protocol, size = 32 }: { protocol: DatabaseProtocol; size?: number }) {
  return <img src={icons[protocol]} width={size} height={size} alt='' aria-hidden />;
}
