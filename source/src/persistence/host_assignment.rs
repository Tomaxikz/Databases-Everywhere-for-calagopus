use crate::persistence::{LOCATION_HOSTS_TABLE, NODES_TABLE, NodeRecord, PANEL_NODE_HOSTS_TABLE};
use serde::Serialize;
use shared::State;
use sqlx::Row;
use utoipa::ToSchema;

#[derive(Debug, Clone)]
pub struct AssignedHost {
    pub host: NodeRecord,
    pub created: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone)]
pub struct EligibleHost {
    pub host: NodeRecord,
    pub assignment_rank: i16,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
pub struct PanelNodeHostAvailability {
    pub available: bool,
    pub schedulable: bool,
    pub direct_host_count: i64,
    pub location_host_count: i64,
}

pub struct HostAssignment;

impl HostAssignment {
    pub async fn for_panel_node(
        state: &State,
        panel_node_uuid: uuid::Uuid,
    ) -> Result<Vec<AssignedHost>, anyhow::Error> {
        let rows = safe_query!(
            (r#"
            SELECT host.*, assignment.created AS assignment_created
            FROM {PANEL_NODE_HOSTS_TABLE} AS assignment
            JOIN {NODES_TABLE} AS host ON host.uuid = assignment.dbev_node_uuid
            WHERE assignment.node_uuid = $1
            ORDER BY host.name, assignment.created, host.uuid
            "#)
        )
        .bind(panel_node_uuid)
        .fetch_all(state.database.read())
        .await?;

        rows.iter()
            .map(|row| {
                Ok(AssignedHost {
                    host: NodeRecord::map(row)?,
                    created: row.try_get("assignment_created")?,
                })
            })
            .collect::<Result<Vec<_>, sqlx::Error>>()
            .map_err(Into::into)
    }

    pub async fn for_location(
        state: &State,
        location_uuid: uuid::Uuid,
    ) -> Result<Vec<AssignedHost>, anyhow::Error> {
        let rows = safe_query!(
            (r#"
            SELECT host.*, assignment.created AS assignment_created
            FROM {LOCATION_HOSTS_TABLE} AS assignment
            JOIN {NODES_TABLE} AS host ON host.uuid = assignment.dbev_node_uuid
            WHERE assignment.location_uuid = $1
            ORDER BY host.name, assignment.created, host.uuid
            "#)
        )
        .bind(location_uuid)
        .fetch_all(state.database.read())
        .await?;

        rows.iter()
            .map(|row| {
                Ok(AssignedHost {
                    host: NodeRecord::map(row)?,
                    created: row.try_get("assignment_created")?,
                })
            })
            .collect::<Result<Vec<_>, sqlx::Error>>()
            .map_err(Into::into)
    }

    pub async fn assign_to_panel_node(
        state: &State,
        panel_node_uuid: uuid::Uuid,
        dbev_node_uuid: uuid::Uuid,
    ) -> Result<bool, anyhow::Error> {
        let inserted = safe_query!(
            (r#"
            INSERT INTO {PANEL_NODE_HOSTS_TABLE} (node_uuid, dbev_node_uuid)
            VALUES ($1, $2)
            ON CONFLICT DO NOTHING
            RETURNING node_uuid
            "#)
        )
        .bind(panel_node_uuid)
        .bind(dbev_node_uuid)
        .fetch_optional(state.database.write())
        .await?;
        Ok(inserted.is_some())
    }

    pub async fn assign_to_location(
        state: &State,
        location_uuid: uuid::Uuid,
        dbev_node_uuid: uuid::Uuid,
    ) -> Result<bool, anyhow::Error> {
        let inserted = safe_query!(
            (r#"
            INSERT INTO {LOCATION_HOSTS_TABLE} (location_uuid, dbev_node_uuid)
            VALUES ($1, $2)
            ON CONFLICT DO NOTHING
            RETURNING location_uuid
            "#)
        )
        .bind(location_uuid)
        .bind(dbev_node_uuid)
        .fetch_optional(state.database.write())
        .await?;
        Ok(inserted.is_some())
    }

    pub async fn remove_from_panel_node(
        state: &State,
        panel_node_uuid: uuid::Uuid,
        dbev_node_uuid: uuid::Uuid,
    ) -> Result<bool, anyhow::Error> {
        let result = safe_query!(
            (r#"
            DELETE FROM {PANEL_NODE_HOSTS_TABLE}
            WHERE node_uuid = $1 AND dbev_node_uuid = $2
            "#)
        )
        .bind(panel_node_uuid)
        .bind(dbev_node_uuid)
        .execute(state.database.write())
        .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn remove_from_location(
        state: &State,
        location_uuid: uuid::Uuid,
        dbev_node_uuid: uuid::Uuid,
    ) -> Result<bool, anyhow::Error> {
        let result = safe_query!(
            (r#"
            DELETE FROM {LOCATION_HOSTS_TABLE}
            WHERE location_uuid = $1 AND dbev_node_uuid = $2
            "#)
        )
        .bind(location_uuid)
        .bind(dbev_node_uuid)
        .execute(state.database.write())
        .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn eligible_for_panel_node(
        state: &State,
        panel_node_uuid: uuid::Uuid,
        location_uuid: uuid::Uuid,
    ) -> Result<Vec<EligibleHost>, anyhow::Error> {
        let rows = safe_query!(
            (r#"
            SELECT host.*,
                CASE WHEN EXISTS (
                    SELECT 1
                    FROM {PANEL_NODE_HOSTS_TABLE} AS direct_assignment
                    WHERE direct_assignment.node_uuid = $1
                      AND direct_assignment.dbev_node_uuid = host.uuid
                ) THEN 0::smallint ELSE 1::smallint END AS assignment_rank
            FROM {NODES_TABLE} AS host
            WHERE host.enabled = true
              AND (
                EXISTS (
                    SELECT 1
                    FROM {PANEL_NODE_HOSTS_TABLE} AS direct_assignment
                    WHERE direct_assignment.node_uuid = $1
                      AND direct_assignment.dbev_node_uuid = host.uuid
                )
                OR EXISTS (
                    SELECT 1
                    FROM {LOCATION_HOSTS_TABLE} AS location_assignment
                    WHERE location_assignment.location_uuid = $2
                      AND location_assignment.dbev_node_uuid = host.uuid
                )
              )
            ORDER BY assignment_rank, host.name, host.uuid
            "#)
        )
        .bind(panel_node_uuid)
        .bind(location_uuid)
        .fetch_all(state.database.read())
        .await?;

        rows.iter()
            .map(|row| {
                Ok(EligibleHost {
                    host: NodeRecord::map(row)?,
                    assignment_rank: row.try_get("assignment_rank")?,
                })
            })
            .collect::<Result<Vec<_>, sqlx::Error>>()
            .map_err(Into::into)
    }

    pub async fn availability(
        state: &State,
        panel_node_uuid: uuid::Uuid,
        location_uuid: uuid::Uuid,
    ) -> Result<PanelNodeHostAvailability, anyhow::Error> {
        let row = safe_query!((r#"
            SELECT
                COUNT(*) FILTER (WHERE direct_assignment.dbev_node_uuid IS NOT NULL) AS direct_host_count,
                COUNT(*) FILTER (WHERE location_assignment.dbev_node_uuid IS NOT NULL) AS location_host_count,
                COUNT(*) FILTER (
                    WHERE host.enabled = true
                      AND (direct_assignment.dbev_node_uuid IS NOT NULL
                        OR location_assignment.dbev_node_uuid IS NOT NULL)
                ) AS schedulable_host_count
            FROM {NODES_TABLE} AS host
            LEFT JOIN {PANEL_NODE_HOSTS_TABLE} AS direct_assignment
              ON direct_assignment.dbev_node_uuid = host.uuid
             AND direct_assignment.node_uuid = $1
            LEFT JOIN {LOCATION_HOSTS_TABLE} AS location_assignment
              ON location_assignment.dbev_node_uuid = host.uuid
             AND location_assignment.location_uuid = $2
            WHERE direct_assignment.dbev_node_uuid IS NOT NULL
               OR location_assignment.dbev_node_uuid IS NOT NULL
            "#))
        .bind(panel_node_uuid)
        .bind(location_uuid)
        .fetch_one(state.database.read())
        .await?;

        let direct_host_count: i64 = row.try_get("direct_host_count")?;
        let location_host_count: i64 = row.try_get("location_host_count")?;
        let schedulable_host_count: i64 = row.try_get("schedulable_host_count")?;
        Ok(PanelNodeHostAvailability {
            available: direct_host_count > 0 || location_host_count > 0,
            schedulable: schedulable_host_count > 0,
            direct_host_count,
            location_host_count,
        })
    }
}
