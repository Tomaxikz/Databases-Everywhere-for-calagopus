ALTER TABLE "servers"
    ADD COLUMN "dbev_enabled" boolean NOT NULL DEFAULT false;

UPDATE "servers"
SET "dbev_enabled" = ("dbev_database_driver" = 'databases_everywhere');

ALTER TABLE "servers"
    DROP CONSTRAINT IF EXISTS "servers_dbev_database_driver_check",
    DROP COLUMN "dbev_database_driver";
