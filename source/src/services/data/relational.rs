use super::{DataColumn, DataObject, QueryOutput};
use crate::{domain::DatabaseProtocol, persistence::DatabaseRecord};
use base64::Engine;
use futures_util::TryStreamExt;
use shared::State;
use sqlx::{Column, Row, TypeInfo, ValueRef};
use std::time::Instant;

pub async fn overview(
    state: &State,
    database: &DatabaseRecord,
) -> Result<Vec<DataObject>, anyhow::Error> {
    match database.protocol {
        DatabaseProtocol::Postgres => {
            let pool = postgres_pool(state, database).await?;
            let rows = sqlx::query_as::<_, (String, String, String)>(
                r#"
                SELECT table_schema, table_name, table_type
                FROM information_schema.tables
                WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
                ORDER BY table_schema, table_name
                "#,
            )
            .fetch_all(&pool)
            .await?;
            Ok(rows
                .into_iter()
                .map(|(namespace, name, kind)| DataObject {
                    name,
                    namespace: Some(namespace),
                    kind: kind.to_ascii_lowercase(),
                    metadata: serde_json::json!({}),
                })
                .collect())
        }
        DatabaseProtocol::Mysql | DatabaseProtocol::Mariadb => {
            let pool = mysql_pool(state, database).await?;
            let rows = sqlx::query_as::<_, (String, String)>(
                r#"
                SELECT table_name, table_type
                FROM information_schema.tables
                WHERE table_schema = DATABASE()
                ORDER BY table_name
                "#,
            )
            .fetch_all(&pool)
            .await?;
            Ok(rows
                .into_iter()
                .map(|(name, kind)| DataObject {
                    name,
                    namespace: Some(database.database_name.clone()),
                    kind: kind.to_ascii_lowercase(),
                    metadata: serde_json::json!({}),
                })
                .collect())
        }
        _ => Err(anyhow::anyhow!("not a relational database")),
    }
}

pub async fn browse(
    state: &State,
    database: &DatabaseRecord,
    namespace: Option<&str>,
    object: &str,
    offset: u64,
    limit: u32,
) -> Result<QueryOutput, anyhow::Error> {
    validate_identifier_input(object)?;
    let started = Instant::now();
    let fetch_limit = limit.saturating_add(1);
    match database.protocol {
        DatabaseProtocol::Postgres => {
            let pool = postgres_pool(state, database).await?;
            let namespace = resolve_postgres_namespace(&pool, database, namespace).await?;
            let query = format!(
                "SELECT * FROM {}.{} LIMIT $1 OFFSET $2",
                quote_postgres(&namespace),
                quote_postgres(object),
            );
            let rows = sqlx::query(sqlx::AssertSqlSafe(query))
                .bind(i64::from(fetch_limit))
                .bind(i64::try_from(offset).unwrap_or(i64::MAX))
                .fetch_all(&pool)
                .await?;
            let truncated = rows.len() > limit as usize;
            let mut rows = rows;
            rows.truncate(limit as usize);
            Ok(pg_output(rows, started, truncated, None))
        }
        DatabaseProtocol::Mysql | DatabaseProtocol::Mariadb => {
            let query = format!("SELECT * FROM {} LIMIT ? OFFSET ?", quote_mysql(object),);
            let pool = mysql_pool(state, database).await?;
            let rows = sqlx::query(sqlx::AssertSqlSafe(query))
                .bind(u64::from(fetch_limit))
                .bind(offset)
                .fetch_all(&pool)
                .await?;
            let truncated = rows.len() > limit as usize;
            let mut rows = rows;
            rows.truncate(limit as usize);
            Ok(mysql_output(rows, started, truncated, None))
        }
        _ => Err(anyhow::anyhow!("not a relational database")),
    }
}

pub async fn describe(
    state: &State,
    database: &DatabaseRecord,
    namespace: Option<&str>,
    object: &str,
) -> Result<Vec<DataColumn>, anyhow::Error> {
    validate_identifier_input(object)?;
    match database.protocol {
        DatabaseProtocol::Postgres => {
            let pool = postgres_pool(state, database).await?;
            let namespace = resolve_postgres_namespace(&pool, database, namespace).await?;
            let rows = sqlx::query(
                r#"
                SELECT c.column_name, c.data_type, c.udt_name, c.is_nullable,
                       c.column_default, c.is_identity,
                       EXISTS (
                           SELECT 1
                           FROM information_schema.table_constraints tc
                           JOIN information_schema.key_column_usage kcu
                             ON tc.constraint_name = kcu.constraint_name
                            AND tc.constraint_schema = kcu.constraint_schema
                            AND tc.table_name = kcu.table_name
                           WHERE tc.constraint_type = 'PRIMARY KEY'
                             AND tc.table_schema = c.table_schema
                             AND tc.table_name = c.table_name
                             AND kcu.column_name = c.column_name
                       ) AS primary_key
                FROM information_schema.columns c
                WHERE c.table_schema = $1 AND c.table_name = $2
                ORDER BY c.ordinal_position
                "#,
            )
            .bind(&namespace)
            .bind(object)
            .fetch_all(&pool)
            .await?;

            rows.into_iter()
                .map(|row| {
                    let data_type: String = row.try_get("data_type")?;
                    let udt_name: String = row.try_get("udt_name")?;
                    let is_identity: String = row.try_get("is_identity")?;
                    Ok(DataColumn {
                        name: row.try_get("column_name")?,
                        data_type: if data_type.eq_ignore_ascii_case("array") {
                            format!("{udt_name}[]")
                        } else {
                            data_type
                        },
                        nullable: row.try_get::<String, _>("is_nullable")? == "YES",
                        primary_key: row.try_get("primary_key")?,
                        default_value: row.try_get("column_default")?,
                        extra: (is_identity == "YES").then(|| "identity".to_owned()),
                    })
                })
                .collect::<Result<Vec<_>, sqlx::Error>>()
                .map_err(Into::into)
        }
        DatabaseProtocol::Mysql | DatabaseProtocol::Mariadb => {
            let pool = mysql_pool(state, database).await?;
            // Decode by position because MySQL metadata label casing varies.
            let rows =
                sqlx::query_as::<_, (String, String, String, Option<String>, String, String)>(
                    r#"
                SELECT column_name, column_type, is_nullable, column_default, column_key, extra
                FROM information_schema.columns
                WHERE table_schema = DATABASE() AND table_name = ?
                ORDER BY ordinal_position
                "#,
                )
                .bind(object)
                .fetch_all(&pool)
                .await?;

            Ok(rows
                .into_iter()
                .map(
                    |(name, data_type, is_nullable, default_value, column_key, extra)| DataColumn {
                        name,
                        data_type,
                        nullable: is_nullable == "YES",
                        primary_key: column_key == "PRI",
                        default_value,
                        extra: (!extra.is_empty()).then_some(extra),
                    },
                )
                .collect())
        }
        _ => Err(anyhow::anyhow!("not a relational database")),
    }
}

pub async fn execute(
    state: &State,
    database: &DatabaseRecord,
    command: &str,
    max_rows: u32,
) -> Result<QueryOutput, anyhow::Error> {
    let command = command.trim();
    if command.is_empty() || command.len() > 1_048_576 {
        return Err(shared::response::DisplayError::new(
            "query must contain between 1 byte and 1 MiB",
        )
        .into());
    }
    let started = Instant::now();
    let returns_rows = returns_rows(command);
    match database.protocol {
        DatabaseProtocol::Postgres => {
            let pool = postgres_pool(state, database).await?;
            if returns_rows {
                let mut stream = sqlx::query(sqlx::AssertSqlSafe(command.to_owned())).fetch(&pool);
                let mut rows = Vec::new();
                while rows.len() <= max_rows as usize {
                    let Some(row) = stream.try_next().await.map_err(console_query_error)? else {
                        break;
                    };
                    rows.push(row);
                }
                let truncated = rows.len() > max_rows as usize;
                rows.truncate(max_rows as usize);
                Ok(pg_output(rows, started, truncated, None))
            } else {
                let result = sqlx::raw_sql(sqlx::AssertSqlSafe(command.to_owned()))
                    .execute(&pool)
                    .await
                    .map_err(console_query_error)?;
                Ok(QueryOutput {
                    columns: Vec::new(),
                    rows: Vec::new(),
                    affected_rows: Some(result.rows_affected()),
                    elapsed_ms: started.elapsed().as_millis(),
                    truncated: false,
                })
            }
        }
        DatabaseProtocol::Mysql | DatabaseProtocol::Mariadb => {
            let pool = mysql_pool(state, database).await?;
            if returns_rows {
                let mut stream = sqlx::query(sqlx::AssertSqlSafe(command.to_owned())).fetch(&pool);
                let mut rows = Vec::new();
                while rows.len() <= max_rows as usize {
                    let Some(row) = stream.try_next().await.map_err(console_query_error)? else {
                        break;
                    };
                    rows.push(row);
                }
                let truncated = rows.len() > max_rows as usize;
                rows.truncate(max_rows as usize);
                Ok(mysql_output(rows, started, truncated, None))
            } else {
                let result = sqlx::raw_sql(sqlx::AssertSqlSafe(command.to_owned()))
                    .execute(&pool)
                    .await
                    .map_err(console_query_error)?;
                Ok(QueryOutput {
                    columns: Vec::new(),
                    rows: Vec::new(),
                    affected_rows: Some(result.rows_affected()),
                    elapsed_ms: started.elapsed().as_millis(),
                    truncated: false,
                })
            }
        }
        _ => Err(anyhow::anyhow!("not a relational database")),
    }
}

/// Returns query diagnostics without exposing connection or credential failures.
fn console_query_error(error: sqlx::Error) -> anyhow::Error {
    let sqlx::Error::Database(database_error) = error else {
        return error.into();
    };

    let message = if let Some(error) =
        database_error.try_downcast_ref::<sqlx::mysql::MySqlDatabaseError>()
    {
        format_console_database_error(Some(error.number()), error.code(), error.message())
    } else if let Some(error) = database_error.try_downcast_ref::<sqlx::postgres::PgDatabaseError>()
    {
        format_console_database_error(None, Some(error.code()), error.message())
    } else {
        let code = database_error.code();
        format_console_database_error(None, code.as_deref(), database_error.message())
    };

    shared::response::DisplayError::new(message)
        .with_status(axum::http::StatusCode::BAD_REQUEST)
        .into()
}

fn format_console_database_error(number: Option<u16>, code: Option<&str>, message: &str) -> String {
    match (number, code) {
        (Some(number), Some(code)) => format!("{number} ({code}): {message}"),
        (Some(number), None) => format!("{number}: {message}"),
        (None, Some(code)) => format!("{code}: {message}"),
        (None, None) => message.to_owned(),
    }
}

pub(super) async fn postgres_pool(
    state: &State,
    database: &DatabaseRecord,
) -> Result<sqlx::PgPool, anyhow::Error> {
    use sqlx::postgres::{PgConnectOptions, PgPoolOptions, PgSslMode};
    let password = database.decrypted_password(state).await?;
    let options = PgConnectOptions::new()
        .host(&database.public_host)
        .port(u16::try_from(database.public_port)?)
        .database(&database.database_name)
        .username(&database.username)
        .password(&password)
        .ssl_mode(if database.tls {
            PgSslMode::Require
        } else {
            PgSslMode::Disable
        });
    Ok(PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(std::time::Duration::from_secs(10))
        .connect_with(options)
        .await?)
}

pub(super) async fn mysql_pool(
    state: &State,
    database: &DatabaseRecord,
) -> Result<sqlx::MySqlPool, anyhow::Error> {
    use sqlx::mysql::{MySqlConnectOptions, MySqlSslMode};
    let password = database.decrypted_password(state).await?;
    let options = MySqlConnectOptions::new()
        .host(&database.public_host)
        .port(u16::try_from(database.public_port)?)
        .database(&database.database_name)
        .username(&database.username)
        .password(&password)
        .ssl_mode(if database.tls {
            MySqlSslMode::Required
        } else {
            MySqlSslMode::Disabled
        });
    match connect_mysql(options.clone()).await {
        Ok(pool) => Ok(pool),
        Err(error) if is_missing_mysql_gateway_route(&error) => {
            // Restore a missing gateway route, but never replay the query.
            tracing::warn!(
                database = %database.uuid,
                "repairing a missing DatabasesEverywhere MySQL gateway route"
            );
            crate::services::reconcile_database(state, database).await?;
            Ok(connect_mysql(options).await?)
        }
        Err(error) => Err(error.into()),
    }
}

async fn connect_mysql(
    options: sqlx::mysql::MySqlConnectOptions,
) -> Result<sqlx::MySqlPool, sqlx::Error> {
    sqlx::mysql::MySqlPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(std::time::Duration::from_secs(10))
        .connect_with(options)
        .await
}

fn is_missing_mysql_gateway_route(error: &sqlx::Error) -> bool {
    error
        .to_string()
        .contains("Access denied for requested database")
}

fn pg_output(
    rows: Vec<sqlx::postgres::PgRow>,
    started: Instant,
    truncated: bool,
    affected_rows: Option<u64>,
) -> QueryOutput {
    let columns = rows
        .first()
        .map(|row| {
            row.columns()
                .iter()
                .map(|column| column.name().to_owned())
                .collect()
        })
        .unwrap_or_default();
    let rows = rows
        .iter()
        .map(|row| {
            let mut object = serde_json::Map::new();
            for (index, column) in row.columns().iter().enumerate() {
                object.insert(
                    column.name().to_owned(),
                    pg_value(row, index, column.type_info().name()),
                );
            }
            serde_json::Value::Object(object)
        })
        .collect();
    QueryOutput {
        columns,
        rows,
        affected_rows,
        elapsed_ms: started.elapsed().as_millis(),
        truncated,
    }
}

fn mysql_output(
    rows: Vec<sqlx::mysql::MySqlRow>,
    started: Instant,
    truncated: bool,
    affected_rows: Option<u64>,
) -> QueryOutput {
    let columns = rows
        .first()
        .map(|row| {
            row.columns()
                .iter()
                .map(|column| column.name().to_owned())
                .collect()
        })
        .unwrap_or_default();
    let rows = rows
        .iter()
        .map(|row| {
            let mut object = serde_json::Map::new();
            for (index, column) in row.columns().iter().enumerate() {
                object.insert(
                    column.name().to_owned(),
                    mysql_value(row, index, column.type_info().name()),
                );
            }
            serde_json::Value::Object(object)
        })
        .collect();
    QueryOutput {
        columns,
        rows,
        affected_rows,
        elapsed_ms: started.elapsed().as_millis(),
        truncated,
    }
}

fn pg_value(row: &sqlx::postgres::PgRow, index: usize, data_type: &str) -> serde_json::Value {
    if row.try_get_raw(index).map_or(true, |value| value.is_null()) {
        return serde_json::Value::Null;
    }
    match data_type {
        "BOOL" => value(row.try_get::<bool, _>(index)),
        "INT2" => value(row.try_get::<i16, _>(index)),
        "INT4" => value(row.try_get::<i32, _>(index)),
        "INT8" => value(row.try_get::<i64, _>(index)),
        "FLOAT4" => value(row.try_get::<f32, _>(index)),
        "FLOAT8" => value(row.try_get::<f64, _>(index)),
        "JSON" | "JSONB" => row
            .try_get::<serde_json::Value, _>(index)
            .unwrap_or_default(),
        "UUID" => value(
            row.try_get::<uuid::Uuid, _>(index)
                .map(|value| value.to_string()),
        ),
        "TIMESTAMPTZ" => value(
            row.try_get::<chrono::DateTime<chrono::Utc>, _>(index)
                .map(|value| value.to_rfc3339()),
        ),
        "TIMESTAMP" => value(
            row.try_get::<chrono::NaiveDateTime, _>(index)
                .map(|value| value.to_string()),
        ),
        "DATE" => value(
            row.try_get::<chrono::NaiveDate, _>(index)
                .map(|value| value.to_string()),
        ),
        "TIME" => value(
            row.try_get::<chrono::NaiveTime, _>(index)
                .map(|value| value.to_string()),
        ),
        "BYTEA" => value(
            row.try_get::<Vec<u8>, _>(index)
                .map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes)),
        ),
        _ => string_or_unsupported(row.try_get::<String, _>(index), data_type),
    }
}

fn mysql_value(row: &sqlx::mysql::MySqlRow, index: usize, data_type: &str) -> serde_json::Value {
    if row.try_get_raw(index).map_or(true, |value| value.is_null()) {
        return serde_json::Value::Null;
    }
    match data_type {
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "BIGINT" => {
            row.try_get::<i64, _>(index).map_or_else(
                |_| value(row.try_get::<u64, _>(index)),
                serde_json::Value::from,
            )
        }
        "FLOAT" | "DOUBLE" => value(row.try_get::<f64, _>(index)),
        "DECIMAL" | "NEWDECIMAL" => value(row.try_get_unchecked::<String, _>(index)),
        "JSON" => row
            .try_get::<serde_json::Value, _>(index)
            .unwrap_or_default(),
        "DATE" => value(
            row.try_get::<chrono::NaiveDate, _>(index)
                .map(|value| value.to_string()),
        ),
        "TIME" => value(
            row.try_get::<chrono::NaiveTime, _>(index)
                .map(|value| value.to_string()),
        ),
        "DATETIME" | "TIMESTAMP" => value(
            row.try_get::<chrono::NaiveDateTime, _>(index)
                .map(|value| value.to_string()),
        ),
        "BINARY" | "VARBINARY" | "BLOB" | "TINYBLOB" | "MEDIUMBLOB" | "LONGBLOB" => {
            row.try_get_unchecked::<String, _>(index).map_or_else(
                |_| {
                    value(
                        row.try_get::<Vec<u8>, _>(index)
                            .map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes)),
                    )
                },
                serde_json::Value::String,
            )
        }
        _ => string_or_unsupported(row.try_get::<String, _>(index), data_type),
    }
}

fn value<T: serde::Serialize>(result: Result<T, sqlx::Error>) -> serde_json::Value {
    result
        .ok()
        .and_then(|value| serde_json::to_value(value).ok())
        .unwrap_or_default()
}

fn string_or_unsupported(
    result: Result<String, sqlx::Error>,
    data_type: &str,
) -> serde_json::Value {
    result.map_or_else(
        |_| serde_json::Value::String(format!("<unsupported {data_type}>")),
        serde_json::Value::String,
    )
}

fn returns_rows(command: &str) -> bool {
    let keyword = command
        .trim_start()
        .split(|character: char| character.is_ascii_whitespace() || character == '(')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    matches!(
        keyword.as_str(),
        "SELECT" | "WITH" | "SHOW" | "DESCRIBE" | "DESC" | "EXPLAIN" | "VALUES" | "TABLE"
    )
}

pub(super) fn validate_identifier_input(identifier: &str) -> Result<(), anyhow::Error> {
    if identifier.is_empty()
        || identifier.len() > 255
        || identifier.chars().any(|character| character.is_control())
    {
        return Err(shared::response::DisplayError::new("invalid database object name").into());
    }
    Ok(())
}

pub(super) async fn resolve_postgres_namespace(
    pool: &sqlx::PgPool,
    database: &DatabaseRecord,
    namespace: Option<&str>,
) -> Result<String, anyhow::Error> {
    let namespace = namespace.unwrap_or("public");
    validate_identifier_input(namespace)?;

    if namespace != database.database_name {
        return Ok(namespace.to_owned());
    }

    let exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = $1)",
    )
    .bind(namespace)
    .fetch_one(pool)
    .await?;
    if exists {
        return Ok(namespace.to_owned());
    }

    tracing::warn!(
        database = %database.uuid,
        physical_database = %database.database_name,
        "received the PostgreSQL physical database name as a nonexistent schema; using public for compatibility"
    );
    Ok("public".to_owned())
}

pub(super) fn quote_postgres(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

pub(super) fn quote_mysql(identifier: &str) -> String {
    format!("`{}`", identifier.replace('`', "``"))
}

#[cfg(test)]
mod tests {
    use super::{format_console_database_error, is_missing_mysql_gateway_route};

    #[test]
    fn detects_the_dbev_missing_route_diagnostic_only() {
        let missing_route =
            sqlx::Error::Protocol("1045 (28000): Access denied for requested database".to_owned());
        let invalid_credentials =
            sqlx::Error::Protocol("1045 (28000): Access denied for user 'tenant'".to_owned());

        assert!(is_missing_mysql_gateway_route(&missing_route));
        assert!(!is_missing_mysql_gateway_route(&invalid_credentials));
    }

    #[test]
    fn formats_mysql_console_diagnostics_with_vendor_and_sqlstate_codes() {
        assert_eq!(
            format_console_database_error(
                Some(1146),
                Some("42S02"),
                "Table 'database.tables' doesn't exist",
            ),
            "1146 (42S02): Table 'database.tables' doesn't exist"
        );
    }

    #[test]
    fn formats_postgres_console_diagnostics_with_sqlstate_code() {
        assert_eq!(
            format_console_database_error(
                None,
                Some("42P01"),
                "relation \"tables\" does not exist",
            ),
            "42P01: relation \"tables\" does not exist"
        );
    }
}
