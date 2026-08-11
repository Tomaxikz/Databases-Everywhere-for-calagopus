CREATE FUNCTION "public"."com_tomaxikz_dbev_enforce_database_limit"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
    "maximum_databases" integer;
    "used_databases" bigint;
BEGIN
    IF TG_OP = 'UPDATE' AND NEW."server_uuid" IS NOT DISTINCT FROM OLD."server_uuid" THEN
        RETURN NEW;
    END IF;

    -- The server row is the cross-provider mutex. This serializes concurrent
    -- classic, official DB Agent, and DatabasesEverywhere inserts for one
    -- server without requiring any core source changes.
    SELECT "database_limit"
    INTO "maximum_databases"
    FROM "public"."servers"
    WHERE "uuid" = NEW."server_uuid"
    FOR UPDATE;

    -- A missing server is left to each table's foreign-key constraint.
    IF "maximum_databases" IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT
        (SELECT COUNT(*) FROM "public"."server_databases" WHERE "server_uuid" = NEW."server_uuid")
        + (SELECT COUNT(*) FROM "public"."server_database_instances" WHERE "server_uuid" = NEW."server_uuid")
        + (SELECT COUNT(*) FROM "public"."com_tomaxikz_databaseseverywhere_databases" WHERE "server_uuid" = NEW."server_uuid")
    INTO "used_databases";

    IF "used_databases" >= "maximum_databases" THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'maximum number of databases reached';
    END IF;

    RETURN NEW;
END;
$function$;

CREATE TRIGGER "com_tomaxikz_dbev_classic_database_limit"
BEFORE INSERT OR UPDATE OF "server_uuid"
ON "public"."server_databases"
FOR EACH ROW
EXECUTE FUNCTION "public"."com_tomaxikz_dbev_enforce_database_limit"();

CREATE TRIGGER "com_tomaxikz_dbev_official_agent_database_limit"
BEFORE INSERT OR UPDATE OF "server_uuid"
ON "public"."server_database_instances"
FOR EACH ROW
EXECUTE FUNCTION "public"."com_tomaxikz_dbev_enforce_database_limit"();

CREATE TRIGGER "com_tomaxikz_dbev_database_limit"
BEFORE INSERT OR UPDATE OF "server_uuid"
ON "public"."com_tomaxikz_databaseseverywhere_databases"
FOR EACH ROW
EXECUTE FUNCTION "public"."com_tomaxikz_dbev_enforce_database_limit"();
