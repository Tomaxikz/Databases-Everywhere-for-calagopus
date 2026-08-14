ALTER TABLE "servers"
    DROP CONSTRAINT IF EXISTS "servers_dbev_database_backup_limit_check",
    DROP COLUMN IF EXISTS "dbev_database_backup_limit";
