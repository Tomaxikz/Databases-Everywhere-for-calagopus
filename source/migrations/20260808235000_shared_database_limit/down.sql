DROP TRIGGER IF EXISTS "com_tomaxikz_dbev_database_limit"
    ON "public"."com_tomaxikz_databaseseverywhere_databases";
DROP TRIGGER IF EXISTS "com_tomaxikz_dbev_official_agent_database_limit"
    ON "public"."server_database_instances";
DROP TRIGGER IF EXISTS "com_tomaxikz_dbev_classic_database_limit"
    ON "public"."server_databases";

DROP FUNCTION IF EXISTS "public"."com_tomaxikz_dbev_enforce_database_limit"();
