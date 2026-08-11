use crate::persistence::{HostAssignment, LOCATION_HOSTS_TABLE, PANEL_NODE_HOSTS_TABLE};
use compact_str::CompactString;
use garde::Validate;
use serde::{Deserialize, Serialize};
use shared::{
    Extendible,
    models::{
        BaseModel, CreatableModel, DeletableModel, ListenerPriority, ModelExtension,
        ModelExtensionMapType, SafeModelExtension, UpdatableModel,
        server::{ApiServerFeatureLimits, Server},
    },
};
use sqlx::{Row, postgres::PgRow};
use std::collections::BTreeMap;
use utoipa::ToSchema;

const EXTENSION_NAME: &str = "com.tomaxikz.databaseseverywhere";
const DATABASES_TABLE: &str = "com_tomaxikz_databaseseverywhere_databases";
const OPERATIONS_TABLE: &str = "com_tomaxikz_databaseseverywhere_operations";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerDatabaseConfiguration {
    pub cpu_cores: Option<f64>,
    pub memory_mib: Option<i64>,
    pub disk_mib: Option<i64>,
    pub backup_limit: i32,
}

pub struct ServerDatabaseConfigurationExtension;

impl SafeModelExtension for ServerDatabaseConfigurationExtension {
    type Value = ServerDatabaseConfiguration;

    fn name() -> &'static str {
        EXTENSION_NAME
    }
}

impl ModelExtension for ServerDatabaseConfigurationExtension {
    fn extension_name(&self) -> &'static str {
        EXTENSION_NAME
    }

    fn extended_columns(&self, prefix: &str) -> BTreeMap<&'static str, CompactString> {
        BTreeMap::from([
            (
                "servers.dbev_database_cpu_cores",
                compact_str::format_compact!("{prefix}dbev_database_cpu_cores"),
            ),
            (
                "servers.dbev_database_memory_mib",
                compact_str::format_compact!("{prefix}dbev_database_memory_mib"),
            ),
            (
                "servers.dbev_database_disk_mib",
                compact_str::format_compact!("{prefix}dbev_database_disk_mib"),
            ),
            (
                "servers.dbev_database_backup_limit",
                compact_str::format_compact!("{prefix}dbev_database_backup_limit"),
            ),
        ])
    }

    fn map_extended(
        &self,
        prefix: &str,
        row: &PgRow,
    ) -> Result<ModelExtensionMapType, shared::database::DatabaseError> {
        Ok(Box::new(ServerDatabaseConfiguration {
            cpu_cores: row.try_get(
                compact_str::format_compact!("{prefix}dbev_database_cpu_cores").as_str(),
            )?,
            memory_mib: row.try_get(
                compact_str::format_compact!("{prefix}dbev_database_memory_mib").as_str(),
            )?,
            disk_mib: row
                .try_get(compact_str::format_compact!("{prefix}dbev_database_disk_mib").as_str())?,
            backup_limit: row.try_get(
                compact_str::format_compact!("{prefix}dbev_database_backup_limit").as_str(),
            )?,
        }))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, Validate)]
pub struct ExtendedServerDatabaseLimits {
    #[garde(skip)]
    pub databases_everywhere_available: Option<bool>,
    #[garde(skip)]
    pub databases_everywhere_in_use: Option<bool>,
    #[garde(range(min = 0.0, max = 1024.0))]
    #[schema(minimum = 0, maximum = 1024)]
    pub database_cpu_cores: Option<f64>,
    #[garde(range(min = 0, max = 1048576))]
    #[schema(minimum = 0, maximum = 1048576)]
    pub database_memory_mib: Option<i64>,
    #[garde(range(min = 0))]
    #[schema(minimum = 0)]
    pub database_disk_mib: Option<i64>,
    #[garde(range(min = 0))]
    #[schema(minimum = 0)]
    pub database_backups: Option<i32>,
}

fn normalized_f64(value: Option<f64>) -> Option<f64> {
    value.filter(|value| *value > 0.0)
}

fn normalized_i64(value: Option<i64>) -> Option<i64> {
    value.filter(|value| *value > 0)
}

async fn may_configure_databases_everywhere(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    panel_node_uuid: uuid::Uuid,
    server_uuid: Option<uuid::Uuid>,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar::<_, bool>(sqlx::AssertSqlSafe(format!(
        r#"
        SELECT EXISTS (
            SELECT 1
            FROM nodes AS panel_node
            WHERE panel_node.uuid = $1
              AND (
                EXISTS (
                    SELECT 1 FROM {PANEL_NODE_HOSTS_TABLE} AS assignment
                    WHERE assignment.node_uuid = panel_node.uuid
                )
                OR EXISTS (
                    SELECT 1 FROM {LOCATION_HOSTS_TABLE} AS assignment
                    WHERE assignment.location_uuid = panel_node.location_uuid
                )
              )
        ) OR (
            $2::uuid IS NOT NULL
            AND EXISTS (SELECT 1 FROM {DATABASES_TABLE} WHERE server_uuid = $2)
        )
        "#
    )))
    .bind(panel_node_uuid)
    .bind(server_uuid)
    .fetch_one(&mut **transaction)
    .await
}

pub fn register_server_integration() {
    Server::register_model_extension(ServerDatabaseConfigurationExtension);

    Server::register_create_handler(
        ListenerPriority::Normal,
        |options, query_builder, _state, transaction| {
            Box::pin(async move {
                let extended = options
                    .feature_limits
                    .parse_extended::<ExtendedServerDatabaseLimits>()
                    .ok();
                let configurable =
                    may_configure_databases_everywhere(transaction, options.node_uuid, None)
                        .await?;

                query_builder
                    .set(
                        "dbev_database_cpu_cores",
                        configurable
                            .then(|| {
                                normalized_f64(
                                    extended.as_ref().and_then(|value| value.database_cpu_cores),
                                )
                            })
                            .flatten(),
                    )
                    .set(
                        "dbev_database_memory_mib",
                        configurable
                            .then(|| {
                                normalized_i64(
                                    extended
                                        .as_ref()
                                        .and_then(|value| value.database_memory_mib),
                                )
                            })
                            .flatten(),
                    )
                    .set(
                        "dbev_database_disk_mib",
                        configurable
                            .then(|| {
                                normalized_i64(
                                    extended.as_ref().and_then(|value| value.database_disk_mib),
                                )
                            })
                            .flatten(),
                    )
                    .set(
                        "dbev_database_backup_limit",
                        if configurable {
                            extended
                                .as_ref()
                                .and_then(|value| value.database_backups)
                                .unwrap_or(0)
                        } else {
                            0
                        },
                    );
                Ok(())
            })
        },
    );

    Server::register_update_handler(
        ListenerPriority::Normal,
        |server, options, query_builder, _state, transaction| {
            Box::pin(async move {
                let Some(feature_limits) = &options.feature_limits else {
                    return Ok(());
                };
                let Ok(extended) = feature_limits.parse_extended::<ExtendedServerDatabaseLimits>()
                else {
                    return Ok(());
                };
                let configurable = may_configure_databases_everywhere(
                    transaction,
                    server.node.uuid,
                    Some(server.uuid),
                )
                .await?;

                let resources_changed = extended.database_cpu_cores.is_some()
                    || extended.database_memory_mib.is_some()
                    || extended.database_disk_mib.is_some();

                if extended.database_cpu_cores.is_some() {
                    query_builder.set(
                        "dbev_database_cpu_cores",
                        configurable
                            .then(|| normalized_f64(extended.database_cpu_cores))
                            .flatten(),
                    );
                }
                if extended.database_memory_mib.is_some() {
                    query_builder.set(
                        "dbev_database_memory_mib",
                        configurable
                            .then(|| normalized_i64(extended.database_memory_mib))
                            .flatten(),
                    );
                }
                if extended.database_disk_mib.is_some() {
                    query_builder.set(
                        "dbev_database_disk_mib",
                        configurable
                            .then(|| normalized_i64(extended.database_disk_mib))
                            .flatten(),
                    );
                }
                if let Some(backup_limit) = extended.database_backups {
                    query_builder.set(
                        "dbev_database_backup_limit",
                        Some(if configurable { backup_limit } else { 0 }),
                    );
                }

                if resources_changed {
                    sqlx::query(sqlx::AssertSqlSafe(format!(
                        "UPDATE {DATABASES_TABLE} SET limits_sync_pending = true, updated = now() WHERE server_uuid = $1"
                    )))
                    .bind(server.uuid)
                    .execute(&mut **transaction)
                    .await?;
                }

                Ok(())
            })
        },
    );

    Server::register_delete_handler(
        ListenerPriority::Normal,
        |server, _options, _state, transaction| {
            Box::pin(async move {
                sqlx::query(sqlx::AssertSqlSafe(format!(
                    r#"
                    INSERT INTO {OPERATIONS_TABLE}
                        (kind, dbev_node_uuid, instance_id, reason)
                    SELECT 'delete_instance', dbev_node_uuid, uuid::text, 'Calagopus server deleted'
                    FROM {DATABASES_TABLE}
                    WHERE server_uuid = $1
                    ON CONFLICT (kind, dbev_node_uuid, instance_id) DO NOTHING
                    "#,
                )))
                .bind(server.uuid)
                .execute(&mut **transaction)
                .await?;
                Ok(())
            })
        },
    );

    ApiServerFeatureLimits::extend_validated(
        |server, state| {
            Box::pin(async move {
                let configuration =
                    server.parse_model_extension::<ServerDatabaseConfigurationExtension>()?;
                let panel_node = server.node.fetch_cached(&state.database).await?;
                let availability =
                    HostAssignment::availability(state, panel_node.uuid, panel_node.location.uuid)
                        .await?;
                let in_use = sqlx::query_scalar::<_, bool>(sqlx::AssertSqlSafe(format!(
                    "SELECT EXISTS(SELECT 1 FROM {DATABASES_TABLE} WHERE server_uuid = $1)"
                )))
                .bind(server.uuid)
                .fetch_one(state.database.read())
                .await?;
                Ok(ServerDatabaseProjection {
                    configuration,
                    available: availability.available,
                    in_use,
                })
            })
        },
        |_limits, projection, _state| ExtendedServerDatabaseLimits {
            databases_everywhere_available: Some(projection.available),
            databases_everywhere_in_use: Some(projection.in_use),
            database_cpu_cores: Some(projection.configuration.cpu_cores.unwrap_or(0.0)),
            database_memory_mib: Some(projection.configuration.memory_mib.unwrap_or(0)),
            database_disk_mib: Some(projection.configuration.disk_mib.unwrap_or(0)),
            database_backups: Some(projection.configuration.backup_limit),
        },
    );
}

struct ServerDatabaseProjection {
    configuration: ServerDatabaseConfiguration,
    available: bool,
    in_use: bool,
}
