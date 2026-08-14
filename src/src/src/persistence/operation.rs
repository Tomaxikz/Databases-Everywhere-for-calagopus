use crate::persistence::OPERATIONS_TABLE;
use shared::State;
use sqlx::{Row, postgres::PgRow};

#[derive(Debug, Clone)]
pub struct DeleteInstanceOperation {
    pub uuid: uuid::Uuid,
    pub dbev_node_uuid: uuid::Uuid,
    pub instance_id: String,
    pub reason: String,
    pub attempts: i32,
}

impl DeleteInstanceOperation {
    fn map(row: &PgRow) -> Result<Self, sqlx::Error> {
        Ok(Self {
            uuid: row.try_get("uuid")?,
            dbev_node_uuid: row.try_get("dbev_node_uuid")?,
            instance_id: row.try_get("instance_id")?,
            reason: row.try_get("reason")?,
            attempts: row.try_get("attempts")?,
        })
    }

    pub async fn due(state: &State) -> Result<Vec<Self>, anyhow::Error> {
        let rows = safe_query!((r#"
            SELECT uuid, dbev_node_uuid, instance_id, reason, attempts
            FROM {OPERATIONS_TABLE}
            WHERE kind = 'delete_instance' AND next_attempt <= now()
            ORDER BY next_attempt, created
            LIMIT 25
            "#,))
        .fetch_all(state.database.read())
        .await?;
        rows.iter()
            .map(Self::map)
            .collect::<Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    pub async fn complete(&self, state: &State) -> Result<(), anyhow::Error> {
        safe_query!(("DELETE FROM {OPERATIONS_TABLE} WHERE uuid = $1"))
            .bind(self.uuid)
            .execute(state.database.write())
            .await?;
        Ok(())
    }

    pub async fn fail(&self, state: &State, error: &str) -> Result<(), anyhow::Error> {
        let backoff_seconds = 15_i64.saturating_mul(2_i64.pow(self.attempts.clamp(0, 8) as u32));
        safe_query!((r#"
            UPDATE {OPERATIONS_TABLE}
            SET attempts = attempts + 1,
                next_attempt = now() + make_interval(secs => $2),
                last_error = $3,
                updated = now()
            WHERE uuid = $1
            "#,))
        .bind(self.uuid)
        .bind(backoff_seconds)
        .bind(error)
        .execute(state.database.write())
        .await?;
        Ok(())
    }
}

pub async fn queue_instance_deletion(
    state: &State,
    node_uuid: uuid::Uuid,
    instance_id: &str,
    reason: &str,
) -> Result<(), anyhow::Error> {
    safe_query!((r#"
        INSERT INTO {OPERATIONS_TABLE} (kind, dbev_node_uuid, instance_id, reason)
        VALUES ('delete_instance', $1, $2, $3)
        ON CONFLICT (kind, dbev_node_uuid, instance_id)
        DO UPDATE SET reason = EXCLUDED.reason, next_attempt = now(), updated = now()
        "#,))
    .bind(node_uuid)
    .bind(instance_id)
    .bind(reason)
    .execute(state.database.write())
    .await?;
    Ok(())
}
