mod document;
mod http_databases;
mod key_value;
mod mutation;
mod qdrant;
mod relational;
mod schema;

pub use schema::SchemaMutationInput;

use crate::{
    dbev::DbevClient,
    domain::DatabaseProtocol,
    persistence::{DatabaseRecord, NodeRecord},
};
use serde::{Deserialize, Serialize};
use shared::State;
use utoipa::ToSchema;

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct DataObject {
    pub name: String,
    pub namespace: Option<String>,
    pub kind: String,
    pub metadata: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct DataColumn {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub primary_key: bool,
    pub default_value: Option<String>,
    pub extra: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ExplorerOverview {
    pub protocol: DatabaseProtocol,
    pub objects: Vec<DataObject>,
    pub selective_export_supported: bool,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct QueryOutput {
    pub columns: Vec<String>,
    pub rows: Vec<serde_json::Value>,
    pub affected_rows: Option<u64>,
    pub elapsed_ms: u128,
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DataMutationOperation {
    Insert,
    Update,
    Delete,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct DataMutationInput {
    pub operation: DataMutationOperation,
    pub namespace: Option<String>,
    pub object: String,
    #[schema(value_type = Option<serde_json::Value>)]
    pub original: Option<serde_json::Value>,
    #[schema(value_type = Option<serde_json::Value>)]
    pub value: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct BatchDataMutationInput {
    pub operation: DataMutationOperation,
    pub namespace: Option<String>,
    pub object: String,
    #[schema(value_type = Vec<serde_json::Value>)]
    pub originals: Vec<serde_json::Value>,
}

pub async fn overview(
    state: &State,
    database: &DatabaseRecord,
) -> Result<ExplorerOverview, anyhow::Error> {
    ensure_running(state, database).await?;
    let objects = match database.protocol {
        DatabaseProtocol::Postgres | DatabaseProtocol::Mysql | DatabaseProtocol::Mariadb => {
            relational::overview(state, database).await?
        }
        DatabaseProtocol::Mongodb => document::overview(state, database).await?,
        DatabaseProtocol::Redis | DatabaseProtocol::Valkey => {
            key_value::overview(state, database).await?
        }
        DatabaseProtocol::Clickhouse => http_databases::overview(state, database).await?,
        DatabaseProtocol::Qdrant => qdrant::overview(state, database).await?,
    };
    Ok(ExplorerOverview {
        protocol: database.protocol,
        objects,
        selective_export_supported: database.protocol.supports_selective_export(),
    })
}

pub async fn browse(
    state: &State,
    database: &DatabaseRecord,
    namespace: Option<&str>,
    object: &str,
    offset: u64,
    limit: u32,
) -> Result<QueryOutput, anyhow::Error> {
    ensure_running(state, database).await?;
    let limit = limit.clamp(1, max_rows(state).await?);
    match database.protocol {
        DatabaseProtocol::Postgres | DatabaseProtocol::Mysql | DatabaseProtocol::Mariadb => {
            relational::browse(state, database, namespace, object, offset, limit).await
        }
        DatabaseProtocol::Mongodb => document::browse(state, database, object, offset, limit).await,
        DatabaseProtocol::Redis | DatabaseProtocol::Valkey => {
            key_value::browse(state, database, object).await
        }
        DatabaseProtocol::Clickhouse => {
            http_databases::browse(state, database, namespace, object, offset, limit).await
        }
        DatabaseProtocol::Qdrant => qdrant::browse(state, database, object, offset, limit).await,
    }
}

pub async fn describe(
    state: &State,
    database: &DatabaseRecord,
    namespace: Option<&str>,
    object: &str,
) -> Result<Vec<DataColumn>, anyhow::Error> {
    ensure_running(state, database).await?;
    match database.protocol {
        DatabaseProtocol::Postgres | DatabaseProtocol::Mysql | DatabaseProtocol::Mariadb => {
            relational::describe(state, database, namespace, object).await
        }
        DatabaseProtocol::Clickhouse => {
            http_databases::describe(state, database, namespace, object).await
        }
        _ => Ok(Vec::new()),
    }
}

pub async fn execute(
    state: &State,
    database: &DatabaseRecord,
    command: &str,
) -> Result<QueryOutput, anyhow::Error> {
    ensure_running(state, database).await?;
    let settings = state.settings.get().await?;
    let extension = settings.get_extension_settings::<crate::settings::ExtensionSettingsData>(
        "com.tomaxikz.databaseseverywhere",
    )?;
    if !extension.raw_console_enabled {
        return Err(shared::response::DisplayError::new("the database console is disabled").into());
    }
    let timeout = extension.query_timeout_seconds.clamp(1, 300);
    let max_rows = extension.max_console_rows.clamp(1, 5000);
    drop(settings);
    let future = async {
        match database.protocol {
            DatabaseProtocol::Postgres | DatabaseProtocol::Mysql | DatabaseProtocol::Mariadb => {
                relational::execute(state, database, command, max_rows).await
            }
            DatabaseProtocol::Mongodb => document::execute(state, database, command).await,
            DatabaseProtocol::Redis | DatabaseProtocol::Valkey => {
                key_value::execute(state, database, command).await
            }
            DatabaseProtocol::Clickhouse => {
                http_databases::execute(state, database, command, max_rows).await
            }
            DatabaseProtocol::Qdrant => qdrant::execute(state, database, command, max_rows).await,
        }
    };
    tokio::time::timeout(std::time::Duration::from_secs(timeout), future)
        .await
        .map_err(|_| shared::response::DisplayError::new("database query timed out"))?
}

pub async fn mutate(
    state: &State,
    database: &DatabaseRecord,
    input: &DataMutationInput,
) -> Result<QueryOutput, anyhow::Error> {
    ensure_running(state, database).await?;
    let settings = state.settings.get().await?;
    let timeout = settings
        .get_extension_settings::<crate::settings::ExtensionSettingsData>(
            "com.tomaxikz.databaseseverywhere",
        )?
        .query_timeout_seconds
        .clamp(1, 300);
    drop(settings);

    let future = dispatch_mutation(state, database, input);
    tokio::time::timeout(std::time::Duration::from_secs(timeout), future)
        .await
        .map_err(|_| shared::response::DisplayError::new("database mutation timed out"))?
}

pub async fn mutate_batch(
    state: &State,
    database: &DatabaseRecord,
    input: &BatchDataMutationInput,
) -> Result<QueryOutput, anyhow::Error> {
    ensure_running(state, database).await?;
    if !matches!(input.operation, DataMutationOperation::Delete) {
        return Err(shared::response::DisplayError::new(
            "batch mutations currently support deletion only",
        )
        .into());
    }
    if input.originals.is_empty() || input.originals.len() > 100 {
        return Err(shared::response::DisplayError::new(
            "batch deletion requires between 1 and 100 selected rows",
        )
        .into());
    }

    let settings = state.settings.get().await?;
    let timeout = settings
        .get_extension_settings::<crate::settings::ExtensionSettingsData>(
            "com.tomaxikz.databaseseverywhere",
        )?
        .query_timeout_seconds
        .clamp(1, 300);
    drop(settings);

    let started = std::time::Instant::now();
    let future = async {
        let mut affected = Some(0_u64);
        for original in &input.originals {
            let output = dispatch_mutation(
                state,
                database,
                &DataMutationInput {
                    operation: DataMutationOperation::Delete,
                    namespace: input.namespace.clone(),
                    object: input.object.clone(),
                    original: Some(original.clone()),
                    value: None,
                },
            )
            .await?;
            affected = match (affected, output.affected_rows) {
                (Some(total), Some(current)) => Some(total.saturating_add(current)),
                _ => None,
            };
        }
        Ok::<_, anyhow::Error>(QueryOutput {
            columns: Vec::new(),
            rows: Vec::new(),
            affected_rows: affected,
            elapsed_ms: started.elapsed().as_millis(),
            truncated: false,
        })
    };

    tokio::time::timeout(std::time::Duration::from_secs(timeout), future)
        .await
        .map_err(|_| shared::response::DisplayError::new("database batch mutation timed out"))?
}

async fn dispatch_mutation(
    state: &State,
    database: &DatabaseRecord,
    input: &DataMutationInput,
) -> Result<QueryOutput, anyhow::Error> {
    match database.protocol {
        DatabaseProtocol::Postgres | DatabaseProtocol::Mysql | DatabaseProtocol::Mariadb => {
            mutation::relational::mutate(state, database, input).await
        }
        DatabaseProtocol::Mongodb => mutation::document::mutate(state, database, input).await,
        DatabaseProtocol::Redis | DatabaseProtocol::Valkey => {
            mutation::key_value::mutate(state, database, input).await
        }
        DatabaseProtocol::Clickhouse => {
            mutation::http_databases::mutate(state, database, input).await
        }
        DatabaseProtocol::Qdrant => mutation::qdrant::mutate(state, database, input).await,
    }
}

pub async fn mutate_schema(
    state: &State,
    database: &DatabaseRecord,
    input: &SchemaMutationInput,
) -> Result<(), anyhow::Error> {
    ensure_running(state, database).await?;
    let settings = state.settings.get().await?;
    let timeout = settings
        .get_extension_settings::<crate::settings::ExtensionSettingsData>(
            "com.tomaxikz.databaseseverywhere",
        )?
        .query_timeout_seconds
        .clamp(1, 300);
    drop(settings);
    tokio::time::timeout(
        std::time::Duration::from_secs(timeout),
        schema::mutate(state, database, input),
    )
    .await
    .map_err(|_| shared::response::DisplayError::new("database schema operation timed out"))?
}

async fn max_rows(state: &State) -> Result<u32, anyhow::Error> {
    let settings = state.settings.get().await?;
    Ok(settings
        .get_extension_settings::<crate::settings::ExtensionSettingsData>(
            "com.tomaxikz.databaseseverywhere",
        )?
        .max_console_rows
        .clamp(1, 5000))
}

async fn ensure_running(state: &State, database: &DatabaseRecord) -> Result<(), anyhow::Error> {
    if database.status == "running" {
        return Ok(());
    }

    // Refresh only transitional Panel state before opening a data connection.
    let node = NodeRecord::by_uuid(state, database.dbev_node_uuid)
        .await?
        .ok_or_else(|| anyhow::anyhow!("DatabasesEverywhere node no longer exists"))?;
    let client = DbevClient::for_node(state, &node).await?;
    let remote = client
        .get::<serde_json::Value>(&format!(
            "/api/instances/{}/status",
            urlencoding::encode(&database.instance_id())
        ))
        .await?;
    database.update_remote_state(state, &remote).await?;

    let status = remote
        .pointer("/instance/status")
        .or_else(|| remote.get("status"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or(&database.status);
    if status == "running" {
        return Ok(());
    }

    Err(shared::response::DisplayError::new(
        "the database must be running before using the data explorer",
    )
    .with_status(axum::http::StatusCode::CONFLICT)
    .into())
}
