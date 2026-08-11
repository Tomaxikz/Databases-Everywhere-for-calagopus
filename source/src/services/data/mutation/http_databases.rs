use super::{mutation_output, required_object};
use crate::{
    persistence::DatabaseRecord,
    services::data::{DataMutationInput, DataMutationOperation, QueryOutput},
};
use shared::{State, response::DisplayError};
use std::time::Instant;

pub async fn mutate(
    state: &State,
    database: &DatabaseRecord,
    input: &DataMutationInput,
) -> Result<QueryOutput, anyhow::Error> {
    let started = Instant::now();
    mutate_clickhouse(state, database, input, started).await
}

async fn mutate_clickhouse(
    state: &State,
    database: &DatabaseRecord,
    input: &DataMutationInput,
    started: Instant,
) -> Result<QueryOutput, anyhow::Error> {
    super::super::http_databases::validate_name(&input.object)?;
    let namespace = input
        .namespace
        .as_deref()
        .unwrap_or(&database.database_name);
    super::super::http_databases::validate_name(namespace)?;
    let table = format!(
        "{}.{}",
        super::super::http_databases::quote_clickhouse(namespace),
        super::super::http_databases::quote_clickhouse(&input.object),
    );

    let query = match input.operation {
        DataMutationOperation::Insert => {
            required_object("inserted row", input.value.as_ref())?;
            format!(
                "INSERT INTO {table} FORMAT JSONEachRow\n{}",
                serde_json::to_string(input.value.as_ref().unwrap())?,
            )
        }
        DataMutationOperation::Update => {
            let value = required_object("updated row", input.value.as_ref())?;
            let original = required_object("original row", input.original.as_ref())?;
            let primary_keys =
                clickhouse_primary_keys(state, database, namespace, &input.object).await?;
            ensure_primary_values(&primary_keys, original)?;
            let assignments = value
                .iter()
                .filter(|(column, _)| !primary_keys.contains(column))
                .map(|(column, value)| {
                    super::super::http_databases::validate_name(column)?;
                    Ok(format!(
                        "{} = {}",
                        super::super::http_databases::quote_clickhouse(column),
                        clickhouse_literal(value)?,
                    ))
                })
                .collect::<Result<Vec<_>, anyhow::Error>>()?;
            if assignments.is_empty() {
                return Err(DisplayError::new(
                    "ClickHouse visual updates require at least one non-primary-key field",
                )
                .into());
            }
            format!(
                "ALTER TABLE {table} UPDATE {} WHERE {}",
                assignments.join(", "),
                clickhouse_identity(&primary_keys, original)?,
            )
        }
        DataMutationOperation::Delete => {
            let original = required_object("original row", input.original.as_ref())?;
            let primary_keys =
                clickhouse_primary_keys(state, database, namespace, &input.object).await?;
            ensure_primary_values(&primary_keys, original)?;
            format!(
                "ALTER TABLE {table} DELETE WHERE {}",
                clickhouse_identity(&primary_keys, original)?,
            )
        }
    };
    super::super::http_databases::clickhouse_query(state, database, &query).await?;
    Ok(mutation_output(started, None))
}

async fn clickhouse_primary_keys(
    state: &State,
    database: &DatabaseRecord,
    namespace: &str,
    table: &str,
) -> Result<Vec<String>, anyhow::Error> {
    let query = format!(
        "SELECT name FROM system.columns WHERE database = {} AND table = {} AND is_in_primary_key = 1 ORDER BY position FORMAT JSON",
        clickhouse_literal(&serde_json::Value::String(namespace.to_owned()))?,
        clickhouse_literal(&serde_json::Value::String(table.to_owned()))?,
    );
    let response = super::super::http_databases::clickhouse_query(state, database, &query).await?;
    let keys = response
        .get("data")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|row| row.get("name")?.as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    if keys.is_empty() {
        return Err(DisplayError::new(
            "ClickHouse visual updates and deletes require a primary-key column; use the console for this table",
        )
        .into());
    }
    Ok(keys)
}

fn ensure_primary_values(
    keys: &[String],
    original: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), anyhow::Error> {
    if let Some(missing) = keys.iter().find(|key| !original.contains_key(*key)) {
        return Err(DisplayError::new(format!(
            "the original ClickHouse row is missing primary-key column {missing}"
        ))
        .into());
    }
    Ok(())
}

fn clickhouse_identity(
    keys: &[String],
    original: &serde_json::Map<String, serde_json::Value>,
) -> Result<String, anyhow::Error> {
    keys.iter()
        .map(|column| {
            let quoted = super::super::http_databases::quote_clickhouse(column);
            if original[column].is_null() {
                Ok(format!("{quoted} IS NULL"))
            } else {
                Ok(format!(
                    "{quoted} = {}",
                    clickhouse_literal(&original[column])?
                ))
            }
        })
        .collect::<Result<Vec<_>, anyhow::Error>>()
        .map(|predicates| predicates.join(" AND "))
}

fn clickhouse_literal(value: &serde_json::Value) -> Result<String, anyhow::Error> {
    match value {
        serde_json::Value::Null => Ok("NULL".to_owned()),
        serde_json::Value::Bool(value) => Ok(if *value { "1" } else { "0" }.to_owned()),
        serde_json::Value::Number(value) => Ok(value.to_string()),
        serde_json::Value::String(value) => Ok(format!(
            "'{}'",
            value.replace('\\', "\\\\").replace('\'', "\\'")
        )),
        _ => Err(DisplayError::new(
            "ClickHouse visual updates support scalar fields; use the console for arrays, maps, and nested values",
        )
        .into()),
    }
}
