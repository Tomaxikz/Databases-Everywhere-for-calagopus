ALTER TABLE "servers"
    ADD COLUMN "dbev_database_driver" text NOT NULL DEFAULT 'native',
    ADD COLUMN "dbev_database_cpu_cores" double precision,
    ADD COLUMN "dbev_database_memory_mib" bigint,
    ADD COLUMN "dbev_database_disk_mib" bigint,
    ADD CONSTRAINT "servers_dbev_database_driver_check"
        CHECK ("dbev_database_driver" IN ('native', 'databases_everywhere')),
    ADD CONSTRAINT "servers_dbev_database_cpu_cores_check"
        CHECK ("dbev_database_cpu_cores" IS NULL OR ("dbev_database_cpu_cores" >= 0.01 AND "dbev_database_cpu_cores" <= 1024)),
    ADD CONSTRAINT "servers_dbev_database_memory_mib_check"
        CHECK ("dbev_database_memory_mib" IS NULL OR ("dbev_database_memory_mib" >= 1 AND "dbev_database_memory_mib" <= 1048576)),
    ADD CONSTRAINT "servers_dbev_database_disk_mib_check"
        CHECK ("dbev_database_disk_mib" IS NULL OR "dbev_database_disk_mib" >= 1);

CREATE TABLE "com_tomaxikz_databaseseverywhere_nodes" (
    "uuid" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "node_uuid" uuid REFERENCES "nodes" ("uuid") ON DELETE SET NULL,
    "location_uuid" uuid REFERENCES "locations" ("uuid") ON DELETE SET NULL,
    "name" varchar(191) NOT NULL,
    "enabled" boolean NOT NULL DEFAULT true,
    "api_url" varchar(2048) NOT NULL,
    "public_host" varchar(253) NOT NULL,
    "daemon_uuid" varchar(191) NOT NULL UNIQUE,
    "token_id" varchar(191) NOT NULL,
    "api_token" bytea NOT NULL,
    "jwt_signing_key" bytea NOT NULL,
    "default_cpu_cores" double precision NOT NULL DEFAULT 0.5,
    "default_memory_mib" bigint NOT NULL DEFAULT 512,
    "default_disk_mib" bigint NOT NULL DEFAULT 1024,
    "configuration" jsonb NOT NULL DEFAULT '{}'::jsonb,
    "cached_system" jsonb,
    "cached_resources" jsonb,
    "last_seen" timestamptz,
    "last_error" text,
    "created" timestamptz NOT NULL DEFAULT now(),
    "updated" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "dbev_nodes_scope_check" CHECK ("node_uuid" IS NULL OR "location_uuid" IS NULL),
    CONSTRAINT "dbev_nodes_default_cpu_check" CHECK ("default_cpu_cores" >= 0.01 AND "default_cpu_cores" <= 1024),
    CONSTRAINT "dbev_nodes_default_memory_check" CHECK ("default_memory_mib" >= 1 AND "default_memory_mib" <= 1048576),
    CONSTRAINT "dbev_nodes_default_disk_check" CHECK ("default_disk_mib" >= 1)
);

CREATE INDEX "dbev_nodes_scope_node_idx"
    ON "com_tomaxikz_databaseseverywhere_nodes" ("node_uuid")
    WHERE "enabled" = true;
CREATE INDEX "dbev_nodes_scope_location_idx"
    ON "com_tomaxikz_databaseseverywhere_nodes" ("location_uuid")
    WHERE "enabled" = true;

CREATE TABLE "com_tomaxikz_databaseseverywhere_databases" (
    "uuid" uuid PRIMARY KEY,
    "server_uuid" uuid NOT NULL REFERENCES "servers" ("uuid") ON DELETE CASCADE,
    "dbev_node_uuid" uuid NOT NULL REFERENCES "com_tomaxikz_databaseseverywhere_nodes" ("uuid") ON DELETE RESTRICT,
    "protocol" varchar(32) NOT NULL,
    "display_name" varchar(191) NOT NULL,
    "database_name" varchar(63) NOT NULL,
    "username" varchar(63) NOT NULL,
    "password" bytea NOT NULL,
    "public_host" varchar(253) NOT NULL,
    "public_port" integer NOT NULL,
    "tls" boolean NOT NULL DEFAULT false,
    "status" varchar(32) NOT NULL DEFAULT 'creating',
    "image" varchar(255),
    "cpu_cores" double precision NOT NULL,
    "memory_mib" bigint NOT NULL,
    "disk_mib" bigint NOT NULL,
    "limits_sync_pending" boolean NOT NULL DEFAULT false,
    "last_error" text,
    "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
    "created" timestamptz NOT NULL DEFAULT now(),
    "updated" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "dbev_databases_protocol_check"
        CHECK ("protocol" IN ('postgres', 'redis', 'mariadb', 'mysql', 'mongodb', 'clickhouse', 'qdrant')),
    CONSTRAINT "dbev_databases_status_check"
        CHECK ("status" IN ('creating', 'booting', 'running', 'stopped', 'failed', 'quarantined', 'deleting')),
    CONSTRAINT "dbev_databases_port_check" CHECK ("public_port" BETWEEN 1 AND 65535),
    CONSTRAINT "dbev_databases_cpu_check" CHECK ("cpu_cores" >= 0.01 AND "cpu_cores" <= 1024),
    CONSTRAINT "dbev_databases_memory_check" CHECK ("memory_mib" >= 1 AND "memory_mib" <= 1048576),
    CONSTRAINT "dbev_databases_disk_check" CHECK ("disk_mib" >= 1),
    UNIQUE ("dbev_node_uuid", "database_name"),
    UNIQUE ("dbev_node_uuid", "username")
);

CREATE INDEX "dbev_databases_server_idx"
    ON "com_tomaxikz_databaseseverywhere_databases" ("server_uuid", "created");
CREATE INDEX "dbev_databases_node_idx"
    ON "com_tomaxikz_databaseseverywhere_databases" ("dbev_node_uuid", "status");
CREATE INDEX "dbev_databases_pending_limits_idx"
    ON "com_tomaxikz_databaseseverywhere_databases" ("updated")
    WHERE "limits_sync_pending" = true;

CREATE TABLE "com_tomaxikz_databaseseverywhere_operations" (
    "uuid" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "kind" varchar(32) NOT NULL,
    "dbev_node_uuid" uuid NOT NULL REFERENCES "com_tomaxikz_databaseseverywhere_nodes" ("uuid") ON DELETE RESTRICT,
    "instance_id" varchar(191) NOT NULL,
    "reason" text NOT NULL,
    "attempts" integer NOT NULL DEFAULT 0,
    "next_attempt" timestamptz NOT NULL DEFAULT now(),
    "last_error" text,
    "created" timestamptz NOT NULL DEFAULT now(),
    "updated" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "dbev_operations_kind_check" CHECK ("kind" IN ('delete_instance')),
    UNIQUE ("kind", "dbev_node_uuid", "instance_id")
);

CREATE INDEX "dbev_operations_due_idx"
    ON "com_tomaxikz_databaseseverywhere_operations" ("next_attempt", "created");
