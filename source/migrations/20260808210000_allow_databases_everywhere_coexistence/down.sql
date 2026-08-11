ALTER TABLE "servers"
    ADD COLUMN "dbev_database_driver" text NOT NULL DEFAULT 'native';

UPDATE "servers"
SET "dbev_database_driver" = CASE
    WHEN "dbev_enabled" THEN 'databases_everywhere'
    ELSE 'native'
END;

ALTER TABLE "servers"
    ADD CONSTRAINT "servers_dbev_database_driver_check"
        CHECK ("dbev_database_driver" IN ('native', 'databases_everywhere')),
    DROP COLUMN "dbev_enabled";
