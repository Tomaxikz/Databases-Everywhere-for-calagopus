ALTER TABLE "servers"
    ADD COLUMN "dbev_database_backup_limit" integer NOT NULL DEFAULT 0,
    ADD CONSTRAINT "servers_dbev_database_backup_limit_check"
        CHECK ("dbev_database_backup_limit" >= 0);
