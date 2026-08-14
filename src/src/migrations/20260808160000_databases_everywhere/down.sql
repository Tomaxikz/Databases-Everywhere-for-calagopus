DROP TABLE IF EXISTS "com_tomaxikz_databaseseverywhere_operations";
DROP TABLE IF EXISTS "com_tomaxikz_databaseseverywhere_databases";
DROP TABLE IF EXISTS "com_tomaxikz_databaseseverywhere_nodes";

ALTER TABLE "servers"
    DROP CONSTRAINT IF EXISTS "servers_dbev_database_disk_mib_check",
    DROP CONSTRAINT IF EXISTS "servers_dbev_database_memory_mib_check",
    DROP CONSTRAINT IF EXISTS "servers_dbev_database_cpu_cores_check",
    DROP CONSTRAINT IF EXISTS "servers_dbev_database_driver_check",
    DROP COLUMN IF EXISTS "dbev_database_disk_mib",
    DROP COLUMN IF EXISTS "dbev_database_memory_mib",
    DROP COLUMN IF EXISTS "dbev_database_cpu_cores",
    DROP COLUMN IF EXISTS "dbev_database_driver";
