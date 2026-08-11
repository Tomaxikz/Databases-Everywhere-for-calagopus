DO $migration$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "com_tomaxikz_databaseseverywhere_databases"
        WHERE "protocol" = 'valkey'
    ) THEN
        RAISE EXCEPTION
            'cannot roll back Valkey protocol support while Valkey databases exist';
    END IF;
END
$migration$;

ALTER TABLE "com_tomaxikz_databaseseverywhere_databases"
    DROP CONSTRAINT IF EXISTS "dbev_databases_protocol_check",
    ADD CONSTRAINT "dbev_databases_protocol_check"
        CHECK (
            "protocol" IN (
                'postgres',
                'redis',
                'mariadb',
                'mysql',
                'mongodb',
                'clickhouse',
                'qdrant'
            )
        );
