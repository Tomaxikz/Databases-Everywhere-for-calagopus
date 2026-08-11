use super::{DataColumn, DataObject, QueryOutput};
use crate::persistence::{DatabaseRecord, NodeRecord};
use shared::{State, response::DisplayError};
use std::time::{Duration, Instant};

pub async fn overview(
    state: &State,
    database: &DatabaseRecord,
) -> Result<Vec<DataObject>, anyhow::Error> {
    let response = clickhouse_query(
        state,
        database,
        "SELECT database, name, engine FROM system.tables WHERE database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema') ORDER BY database, name FORMAT JSON",
    )
    .await?;
    Ok(response
        .get("data")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|row| {
            Some(DataObject {
                name: row.get("name")?.as_str()?.to_owned(),
                namespace: row.get("database")?.as_str().map(str::to_owned),
                kind: row
                    .get("engine")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("table")
                    .to_owned(),
                metadata: row.clone(),
            })
        })
        .collect())
}

pub async fn browse(
    state: &State,
    database: &DatabaseRecord,
    namespace: Option<&str>,
    object: &str,
    offset: u64,
    limit: u32,
) -> Result<QueryOutput, anyhow::Error> {
    validate_name(object)?;
    let started = Instant::now();
    let namespace = namespace.unwrap_or(&database.database_name);
    validate_name(namespace)?;
    let fetch_limit = limit.saturating_add(1);
    let query = format!(
        "SELECT * FROM {}.{} LIMIT {} OFFSET {} FORMAT JSON",
        quote_clickhouse(namespace),
        quote_clickhouse(object),
        fetch_limit,
        offset,
    );
    let response = clickhouse_query(state, database, &query).await?;
    let mut output = clickhouse_output(response, started, false);
    output.truncated = output.rows.len() > limit as usize;
    output.rows.truncate(limit as usize);
    Ok(output)
}

pub async fn describe(
    state: &State,
    database: &DatabaseRecord,
    namespace: Option<&str>,
    object: &str,
) -> Result<Vec<DataColumn>, anyhow::Error> {
    validate_name(object)?;
    let namespace = namespace.unwrap_or(&database.database_name);
    validate_name(namespace)?;
    let query = format!(
        "SELECT name, type, default_kind, default_expression, is_in_primary_key FROM system.columns WHERE database = {} AND table = {} ORDER BY position FORMAT JSON",
        quote_clickhouse_string(namespace),
        quote_clickhouse_string(object),
    );
    let response = clickhouse_query(state, database, &query).await?;
    Ok(response
        .get("data")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|row| {
            let data_type = row.get("type")?.as_str()?.to_owned();
            let default_kind = row
                .get("default_kind")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            let default_expression = row
                .get("default_expression")
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_owned);
            Some(DataColumn {
                name: row.get("name")?.as_str()?.to_owned(),
                nullable: data_type.starts_with("Nullable("),
                data_type,
                primary_key: row
                    .get("is_in_primary_key")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or_default()
                    > 0,
                default_value: default_expression,
                extra: (!default_kind.is_empty()).then(|| default_kind.to_owned()),
            })
        })
        .collect())
}

pub async fn execute(
    state: &State,
    database: &DatabaseRecord,
    command: &str,
    max_rows: u32,
) -> Result<QueryOutput, anyhow::Error> {
    let started = Instant::now();
    let mut command = command.trim().trim_end_matches(';').trim().to_owned();
    if command.is_empty() || command.len() > 1_048_576 {
        return Err(
            DisplayError::new("ClickHouse query must contain between 1 byte and 1 MiB").into(),
        );
    }
    let returns_rows = returns_rows(&command);
    if returns_rows && !command.to_ascii_uppercase().contains(" FORMAT ") {
        command.push_str(" FORMAT JSON");
    }
    let response = clickhouse_query(state, database, &command).await?;
    if returns_rows {
        let mut output = clickhouse_output(response, started, false);
        if output.rows.len() > max_rows as usize {
            output.rows.truncate(max_rows as usize);
            output.truncated = true;
        }
        Ok(output)
    } else {
        Ok(QueryOutput {
            columns: Vec::new(),
            rows: Vec::new(),
            affected_rows: None,
            elapsed_ms: started.elapsed().as_millis(),
            truncated: false,
        })
    }
}

pub(super) async fn clickhouse_query(
    state: &State,
    database: &DatabaseRecord,
    query: &str,
) -> Result<serde_json::Value, anyhow::Error> {
    let password = database.decrypted_password(state).await?;
    let node = NodeRecord::by_uuid(state, database.dbev_node_uuid)
        .await?
        .ok_or_else(|| anyhow::anyhow!("DatabasesEverywhere node no longer exists"))?;
    let scheme = if database.tls { "https" } else { "http" };
    let host = bracket_host(&database.public_host);
    let url = format!(
        "{scheme}://{host}:{}/?database={}",
        node.clickhouse_http_port(),
        urlencoding::encode(&database.database_name),
    );
    let response = state
        .client
        .post(url)
        .basic_auth(&database.username, Some(password))
        .header(reqwest::header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .timeout(Duration::from_secs(300))
        .body(query.to_owned())
        .send()
        .await?;
    let status = response.status();
    let text = response.text().await?;
    if !status.is_success() {
        return Err(
            DisplayError::new(format!("ClickHouse query failed: {}", text.trim()))
                .with_status(axum::http::StatusCode::BAD_GATEWAY)
                .into(),
        );
    }
    if text.trim().is_empty() {
        Ok(serde_json::json!({}))
    } else {
        serde_json::from_str(&text).map_err(|error| {
            DisplayError::new(format!(
                "ClickHouse returned an invalid JSON response: {error}"
            ))
            .with_status(axum::http::StatusCode::BAD_GATEWAY)
            .into()
        })
    }
}

fn clickhouse_output(
    response: serde_json::Value,
    started: Instant,
    truncated: bool,
) -> QueryOutput {
    let columns = response
        .get("meta")
        .and_then(serde_json::Value::as_array)
        .map(|meta| {
            meta.iter()
                .filter_map(|column| column.get("name")?.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let rows = response
        .get("data")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    QueryOutput {
        columns,
        rows,
        affected_rows: response.get("rows").and_then(serde_json::Value::as_u64),
        elapsed_ms: started.elapsed().as_millis(),
        truncated,
    }
}

fn returns_rows(command: &str) -> bool {
    matches!(
        command
            .trim_start()
            .split_ascii_whitespace()
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase()
            .as_str(),
        "SELECT" | "WITH" | "SHOW" | "DESCRIBE" | "DESC" | "EXPLAIN"
    )
}

pub(super) fn validate_name(name: &str) -> Result<(), anyhow::Error> {
    if name.is_empty() || name.len() > 255 || name.chars().any(char::is_control) {
        return Err(DisplayError::new("invalid database object name").into());
    }
    Ok(())
}

pub(super) fn quote_clickhouse(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

fn quote_clickhouse_string(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'"))
}

fn bracket_host(host: &str) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_owned()
    }
}
