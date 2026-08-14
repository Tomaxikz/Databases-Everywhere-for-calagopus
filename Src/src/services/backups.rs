use crate::{
    dbev::DbevClient,
    persistence::{DatabaseRecord, NodeRecord},
};
use axum::http::StatusCode;
use shared::{State, response::DisplayError};

pub fn count_backup_records(value: &serde_json::Value) -> Result<i64, anyhow::Error> {
    let records = value
        .as_array()
        .or_else(|| value.get("backups").and_then(serde_json::Value::as_array))
        .or_else(|| value.get("items").and_then(serde_json::Value::as_array))
        .or_else(|| value.get("data").and_then(serde_json::Value::as_array))
        .ok_or_else(|| {
            DisplayError::new("DatabasesEverywhere returned an invalid backup list")
                .with_status(StatusCode::BAD_GATEWAY)
        })?;
    i64::try_from(records.len()).map_err(Into::into)
}

pub async fn database_backup_usage(
    state: &State,
    database: &DatabaseRecord,
) -> Result<i64, anyhow::Error> {
    let node = NodeRecord::by_uuid(state, database.dbev_node_uuid)
        .await?
        .ok_or_else(|| anyhow::anyhow!("DatabasesEverywhere node no longer exists"))?;
    let client = DbevClient::for_node(state, &node).await?;
    let backups = client
        .get::<serde_json::Value>(&format!(
            "/api/instances/{}/backups",
            urlencoding::encode(&database.instance_id())
        ))
        .await?;
    count_backup_records(&backups)
}

#[cfg(test)]
mod tests {
    use super::count_backup_records;

    #[test]
    fn counts_supported_backup_response_shapes() {
        assert_eq!(
            count_backup_records(&serde_json::json!([{}, {}])).unwrap(),
            2
        );
        assert_eq!(
            count_backup_records(&serde_json::json!({ "backups": [{}] })).unwrap(),
            1
        );
        assert_eq!(
            count_backup_records(&serde_json::json!({ "items": [{}, {}, {}] })).unwrap(),
            3
        );
        assert_eq!(
            count_backup_records(&serde_json::json!({ "data": [] })).unwrap(),
            0
        );
    }

    #[test]
    fn rejects_unknown_backup_response_shapes() {
        assert!(count_backup_records(&serde_json::json!({ "status": "ok" })).is_err());
    }
}
