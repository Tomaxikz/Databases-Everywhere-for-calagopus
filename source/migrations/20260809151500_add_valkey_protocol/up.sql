ALTER TABLE "com_tomaxikz_databaseseverywhere_databases"
    DROP CONSTRAINT IF EXISTS "dbev_databases_protocol_check",
    ADD CONSTRAINT "dbev_databases_protocol_check"
        CHECK (
            "protocol" IN (
                'postgres',
                'redis',
                'valkey',
                'mariadb',
                'mysql',
                'mongodb',
                'clickhouse',
                'qdrant'
            )
        );
