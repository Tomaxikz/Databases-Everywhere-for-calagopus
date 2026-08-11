CREATE TABLE "com_tomaxikz_databaseseverywhere_panel_node_hosts" (
    "node_uuid" uuid NOT NULL REFERENCES "nodes" ("uuid") ON DELETE CASCADE,
    "dbev_node_uuid" uuid NOT NULL REFERENCES "com_tomaxikz_databaseseverywhere_nodes" ("uuid") ON DELETE CASCADE,
    "created" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("node_uuid", "dbev_node_uuid")
);

CREATE INDEX "dbev_panel_node_hosts_host_idx"
    ON "com_tomaxikz_databaseseverywhere_panel_node_hosts" ("dbev_node_uuid");

CREATE TABLE "com_tomaxikz_databaseseverywhere_location_hosts" (
    "location_uuid" uuid NOT NULL REFERENCES "locations" ("uuid") ON DELETE CASCADE,
    "dbev_node_uuid" uuid NOT NULL REFERENCES "com_tomaxikz_databaseseverywhere_nodes" ("uuid") ON DELETE CASCADE,
    "created" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("location_uuid", "dbev_node_uuid")
);

CREATE INDEX "dbev_location_hosts_host_idx"
    ON "com_tomaxikz_databaseseverywhere_location_hosts" ("dbev_node_uuid");

-- Preserve every explicit legacy node and location scope.
INSERT INTO "com_tomaxikz_databaseseverywhere_panel_node_hosts" ("node_uuid", "dbev_node_uuid", "created")
SELECT "node_uuid", "uuid", "created"
FROM "com_tomaxikz_databaseseverywhere_nodes"
WHERE "node_uuid" IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO "com_tomaxikz_databaseseverywhere_location_hosts" ("location_uuid", "dbev_node_uuid", "created")
SELECT "location_uuid", "uuid", "created"
FROM "com_tomaxikz_databaseseverywhere_nodes"
WHERE "location_uuid" IS NOT NULL
ON CONFLICT DO NOTHING;

-- A legacy global host was eligible on every node. Materialize that relationship
-- for the nodes that exist during upgrade; future nodes require an explicit assignment.
INSERT INTO "com_tomaxikz_databaseseverywhere_panel_node_hosts" ("node_uuid", "dbev_node_uuid", "created")
SELECT "nodes"."uuid", "dbev_nodes"."uuid", "dbev_nodes"."created"
FROM "nodes"
CROSS JOIN "com_tomaxikz_databaseseverywhere_nodes" AS "dbev_nodes"
WHERE "dbev_nodes"."node_uuid" IS NULL
  AND "dbev_nodes"."location_uuid" IS NULL
ON CONFLICT DO NOTHING;

DROP INDEX IF EXISTS "dbev_nodes_scope_node_idx";
DROP INDEX IF EXISTS "dbev_nodes_scope_location_idx";

ALTER TABLE "com_tomaxikz_databaseseverywhere_nodes"
    DROP CONSTRAINT IF EXISTS "dbev_nodes_scope_check",
    DROP COLUMN "node_uuid",
    DROP COLUMN "location_uuid";

-- Availability is now derived from host topology, not a per-server switch.
ALTER TABLE "servers" DROP COLUMN IF EXISTS "dbev_enabled";
