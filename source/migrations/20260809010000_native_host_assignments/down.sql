ALTER TABLE "com_tomaxikz_databaseseverywhere_nodes"
    ADD COLUMN "node_uuid" uuid REFERENCES "nodes" ("uuid") ON DELETE SET NULL,
    ADD COLUMN "location_uuid" uuid REFERENCES "locations" ("uuid") ON DELETE SET NULL;

-- The legacy model can express only one scope. Restore exact single assignments;
-- hosts with multiple assignments remain NULL/NULL, which is the old global scope.
UPDATE "com_tomaxikz_databaseseverywhere_nodes" AS "host"
SET "node_uuid" = "assignment"."node_uuid"
FROM (
    SELECT "dbev_node_uuid", min("node_uuid"::text)::uuid AS "node_uuid"
    FROM "com_tomaxikz_databaseseverywhere_panel_node_hosts"
    GROUP BY "dbev_node_uuid"
    HAVING count(*) = 1
) AS "assignment"
WHERE "assignment"."dbev_node_uuid" = "host"."uuid"
  AND NOT EXISTS (
      SELECT 1
      FROM "com_tomaxikz_databaseseverywhere_location_hosts" AS "location_assignment"
      WHERE "location_assignment"."dbev_node_uuid" = "host"."uuid"
  );

UPDATE "com_tomaxikz_databaseseverywhere_nodes" AS "host"
SET "location_uuid" = "assignment"."location_uuid"
FROM (
    SELECT "dbev_node_uuid", min("location_uuid"::text)::uuid AS "location_uuid"
    FROM "com_tomaxikz_databaseseverywhere_location_hosts"
    GROUP BY "dbev_node_uuid"
    HAVING count(*) = 1
) AS "assignment"
WHERE "assignment"."dbev_node_uuid" = "host"."uuid"
  AND NOT EXISTS (
      SELECT 1
      FROM "com_tomaxikz_databaseseverywhere_panel_node_hosts" AS "node_assignment"
      WHERE "node_assignment"."dbev_node_uuid" = "host"."uuid"
  );

ALTER TABLE "com_tomaxikz_databaseseverywhere_nodes"
    ADD CONSTRAINT "dbev_nodes_scope_check" CHECK ("node_uuid" IS NULL OR "location_uuid" IS NULL);

CREATE INDEX "dbev_nodes_scope_node_idx"
    ON "com_tomaxikz_databaseseverywhere_nodes" ("node_uuid")
    WHERE "enabled" = true;
CREATE INDEX "dbev_nodes_scope_location_idx"
    ON "com_tomaxikz_databaseseverywhere_nodes" ("location_uuid")
    WHERE "enabled" = true;

ALTER TABLE "servers"
    ADD COLUMN IF NOT EXISTS "dbev_enabled" boolean NOT NULL DEFAULT false;

UPDATE "servers" AS "server"
SET "dbev_enabled" = true
FROM "nodes" AS "node"
WHERE "node"."uuid" = "server"."node_uuid"
  AND (
    EXISTS (
        SELECT 1
        FROM "com_tomaxikz_databaseseverywhere_panel_node_hosts" AS "assignment"
        WHERE "assignment"."node_uuid" = "node"."uuid"
    )
    OR EXISTS (
        SELECT 1
        FROM "com_tomaxikz_databaseseverywhere_location_hosts" AS "assignment"
        WHERE "assignment"."location_uuid" = "node"."location_uuid"
    )
  );

DROP TABLE IF EXISTS "com_tomaxikz_databaseseverywhere_location_hosts";
DROP TABLE IF EXISTS "com_tomaxikz_databaseseverywhere_panel_node_hosts";
