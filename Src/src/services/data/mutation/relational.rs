use super::{mutation_output, required_object};
use crate::{
    domain::DatabaseProtocol,
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
    super::super::relational::validate_identifier_input(&input.object)?;
    let started = Instant::now();
    match database.protocol {
        DatabaseProtocol::Postgres => mutate_postgres(state, database, input, started).await,
        DatabaseProtocol::Mysql | DatabaseProtocol::Mariadb => {
            mutate_mysql(state, database, input, started).await
        }
        _ => Err(anyhow::anyhow!("not a relational database")),
    }
}

async fn mutate_postgres(
    state: &State,
    database: &DatabaseRecord,
    input: &DataMutationInput,
    started: Instant,
) -> Result<QueryOutput, anyhow::Error> {
    let pool = super::super::relational::postgres_pool(state, database).await?;
    let schema = super::super::relational::resolve_postgres_namespace(
        &pool,
        database,
        input.namespace.as_deref(),
    )
    .await?;
    let table = format!(
        "{}.{}",
        super::super::relational::quote_postgres(&schema),
        super::super::relational::quote_postgres(&input.object),
    );

    let affected = match input.operation {
        DataMutationOperation::Insert => {
            let value = required_object("inserted row", input.value.as_ref())?;
            validate_columns(value.keys())?;
            let columns = value
                .keys()
                .map(|column| super::super::relational::quote_postgres(column))
                .collect::<Vec<_>>();
            let selected = value
                .keys()
                .map(|column| {
                    format!(
                        "replacement.{}",
                        super::super::relational::quote_postgres(column)
                    )
                })
                .collect::<Vec<_>>();
            let query = format!(
                "INSERT INTO {table} ({}) SELECT {} FROM jsonb_populate_record(NULL::{table}, $1::jsonb) AS replacement",
                columns.join(", "),
                selected.join(", "),
            );
            sqlx::query(sqlx::AssertSqlSafe(query))
                .bind(sqlx::types::Json(input.value.as_ref().unwrap().clone()))
                .execute(&pool)
                .await?
                .rows_affected()
        }
        DataMutationOperation::Update => {
            let value = required_object("updated row", input.value.as_ref())?;
            let original = required_object("original row", input.original.as_ref())?;
            validate_columns(value.keys())?;
            let primary_keys = postgres_primary_keys(&pool, &schema, &input.object).await?;
            ensure_primary_values(&primary_keys, original)?;
            let assignments = value
                .keys()
                .map(|column| {
                    let column = super::super::relational::quote_postgres(column);
                    format!("{column} = replacement.{column}")
                })
                .collect::<Vec<_>>();
            let predicates = primary_keys
                .iter()
                .map(|column| {
                    let column = super::super::relational::quote_postgres(column);
                    format!("target.{column} IS NOT DISTINCT FROM identity.{column}")
                })
                .collect::<Vec<_>>();
            let query = format!(
                "UPDATE {table} AS target SET {} FROM jsonb_populate_record(NULL::{table}, $1::jsonb) AS replacement, jsonb_populate_record(NULL::{table}, $2::jsonb) AS identity WHERE {}",
                assignments.join(", "),
                predicates.join(" AND "),
            );
            sqlx::query(sqlx::AssertSqlSafe(query))
                .bind(sqlx::types::Json(input.value.as_ref().unwrap().clone()))
                .bind(sqlx::types::Json(input.original.as_ref().unwrap().clone()))
                .execute(&pool)
                .await?
                .rows_affected()
        }
        DataMutationOperation::Delete => {
            let original = required_object("original row", input.original.as_ref())?;
            let primary_keys = postgres_primary_keys(&pool, &schema, &input.object).await?;
            ensure_primary_values(&primary_keys, original)?;
            let predicates = primary_keys
                .iter()
                .map(|column| {
                    let column = super::super::relational::quote_postgres(column);
                    format!("target.{column} IS NOT DISTINCT FROM identity.{column}")
                })
                .collect::<Vec<_>>();
            let query = format!(
                "DELETE FROM {table} AS target USING jsonb_populate_record(NULL::{table}, $1::jsonb) AS identity WHERE {}",
                predicates.join(" AND "),
            );
            sqlx::query(sqlx::AssertSqlSafe(query))
                .bind(sqlx::types::Json(input.original.as_ref().unwrap().clone()))
                .execute(&pool)
                .await?
                .rows_affected()
        }
    };
    ensure_single_row(input.operation, affected)?;
    Ok(mutation_output(started, Some(affected)))
}

async fn mutate_mysql(
    state: &State,
    database: &DatabaseRecord,
    input: &DataMutationInput,
    started: Instant,
) -> Result<QueryOutput, anyhow::Error> {
    let table = super::super::relational::quote_mysql(&input.object);
    let pool = super::super::relational::mysql_pool(state, database).await?;

    let affected = match input.operation {
        DataMutationOperation::Insert => {
            let value = required_object("inserted row", input.value.as_ref())?;
            validate_columns(value.keys())?;
            let columns = value
                .keys()
                .map(|column| super::super::relational::quote_mysql(column))
                .collect::<Vec<_>>();
            let query = format!(
                "INSERT INTO {table} ({}) VALUES ({})",
                columns.join(", "),
                vec!["?"; columns.len()].join(", "),
            );
            let mut query = sqlx::query(sqlx::AssertSqlSafe(query));
            for value in value.values() {
                query = query.bind(mysql_value(value));
            }
            query.execute(&pool).await?.rows_affected()
        }
        DataMutationOperation::Update => {
            let value = required_object("updated row", input.value.as_ref())?;
            let original = required_object("original row", input.original.as_ref())?;
            validate_columns(value.keys())?;
            let primary_keys =
                mysql_primary_keys(&pool, &database.database_name, &input.object).await?;
            ensure_primary_values(&primary_keys, original)?;
            if !mysql_row_exists(&pool, &table, &primary_keys, original).await? {
                return Err(stale_row_error());
            }
            let assignments = value
                .keys()
                .map(|column| format!("{} = ?", super::super::relational::quote_mysql(column)))
                .collect::<Vec<_>>();
            let predicates = primary_keys
                .iter()
                .map(|column| format!("{} <=> ?", super::super::relational::quote_mysql(column)))
                .collect::<Vec<_>>();
            let query = format!(
                "UPDATE {table} SET {} WHERE {}",
                assignments.join(", "),
                predicates.join(" AND "),
            );
            let mut query = sqlx::query(sqlx::AssertSqlSafe(query));
            for value in value.values() {
                query = query.bind(mysql_value(value));
            }
            for key in &primary_keys {
                query = query.bind(mysql_value(&original[key]));
            }
            query.execute(&pool).await?.rows_affected()
        }
        DataMutationOperation::Delete => {
            let original = required_object("original row", input.original.as_ref())?;
            let primary_keys =
                mysql_primary_keys(&pool, &database.database_name, &input.object).await?;
            ensure_primary_values(&primary_keys, original)?;
            let predicates = primary_keys
                .iter()
                .map(|column| format!("{} <=> ?", super::super::relational::quote_mysql(column)))
                .collect::<Vec<_>>();
            let query = format!("DELETE FROM {table} WHERE {}", predicates.join(" AND "));
            let mut query = sqlx::query(sqlx::AssertSqlSafe(query));
            for key in &primary_keys {
                query = query.bind(mysql_value(&original[key]));
            }
            query.execute(&pool).await?.rows_affected()
        }
    };
    match input.operation {
        DataMutationOperation::Insert => {}
        DataMutationOperation::Update if affected > 1 => return Err(stale_row_error()),
        DataMutationOperation::Delete if affected != 1 => return Err(stale_row_error()),
        DataMutationOperation::Update | DataMutationOperation::Delete => {}
    }
    Ok(mutation_output(started, Some(affected)))
}

async fn mysql_row_exists(
    pool: &sqlx::MySqlPool,
    table: &str,
    primary_keys: &[String],
    original: &serde_json::Map<String, serde_json::Value>,
) -> Result<bool, anyhow::Error> {
    let predicates = primary_keys
        .iter()
        .map(|column| format!("{} <=> ?", super::super::relational::quote_mysql(column)))
        .collect::<Vec<_>>();
    let mut query = sqlx::query_scalar::<_, bool>(sqlx::AssertSqlSafe(format!(
        "SELECT EXISTS(SELECT 1 FROM {table} WHERE {})",
        predicates.join(" AND "),
    )));
    for key in primary_keys {
        query = query.bind(mysql_value(&original[key]));
    }
    Ok(query.fetch_one(pool).await?)
}

async fn postgres_primary_keys(
    pool: &sqlx::PgPool,
    schema: &str,
    table: &str,
) -> Result<Vec<String>, anyhow::Error> {
    let keys = sqlx::query_scalar::<_, String>(
        r#"
        SELECT key_usage.column_name
        FROM information_schema.table_constraints AS constraints
        JOIN information_schema.key_column_usage AS key_usage
          ON constraints.constraint_name = key_usage.constraint_name
         AND constraints.table_schema = key_usage.table_schema
         AND constraints.table_name = key_usage.table_name
        WHERE constraints.constraint_type = 'PRIMARY KEY'
          AND constraints.table_schema = $1
          AND constraints.table_name = $2
        ORDER BY key_usage.ordinal_position
        "#,
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await?;
    ensure_primary_key(&keys)?;
    Ok(keys)
}

async fn mysql_primary_keys(
    pool: &sqlx::MySqlPool,
    database: &str,
    table: &str,
) -> Result<Vec<String>, anyhow::Error> {
    let keys = sqlx::query_scalar::<_, String>(
        r#"
        SELECT column_name
        FROM information_schema.key_column_usage
        WHERE constraint_name = 'PRIMARY'
          AND table_schema = ?
          AND table_name = ?
        ORDER BY ordinal_position
        "#,
    )
    .bind(database)
    .bind(table)
    .fetch_all(pool)
    .await?;
    ensure_primary_key(&keys)?;
    Ok(keys)
}

fn validate_columns<'a>(columns: impl Iterator<Item = &'a String>) -> Result<(), anyhow::Error> {
    for column in columns {
        super::super::relational::validate_identifier_input(column)?;
    }
    Ok(())
}

fn ensure_primary_key(keys: &[String]) -> Result<(), anyhow::Error> {
    if keys.is_empty() {
        return Err(DisplayError::new(
            "visual updates and deletes require a table with a primary key; use the console for this table",
        )
        .into());
    }
    Ok(())
}

fn ensure_primary_values(
    keys: &[String],
    original: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), anyhow::Error> {
    ensure_primary_key(keys)?;
    if let Some(missing) = keys.iter().find(|key| !original.contains_key(*key)) {
        return Err(DisplayError::new(format!(
            "the original row is missing primary-key column {missing}"
        ))
        .into());
    }
    Ok(())
}

fn ensure_single_row(operation: DataMutationOperation, affected: u64) -> Result<(), anyhow::Error> {
    if !matches!(operation, DataMutationOperation::Insert) && affected != 1 {
        return Err(stale_row_error());
    }
    Ok(())
}

fn stale_row_error() -> anyhow::Error {
    DisplayError::new(
        "the row changed before the mutation completed; refresh the visual editor and try again",
    )
    .with_status(axum::http::StatusCode::CONFLICT)
    .into()
}

fn mysql_value(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::Null => None,
        serde_json::Value::String(value) => Some(value.clone()),
        serde_json::Value::Bool(value) => Some(if *value { "1" } else { "0" }.to_owned()),
        value => Some(value.to_string()),
    }
}
