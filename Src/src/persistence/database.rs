use crate::{
    domain::{DatabaseProtocol, ResourceLimits},
    persistence::{DATABASES_TABLE, NodeRecord},
};
use serde::Serialize;
use shared::State;
use sqlx::{Row, postgres::PgRow};
use std::str::FromStr;
use utoipa::ToSchema;

#[derive(Debug, Clone)]
pub struct DatabaseRecord {
    pub uuid: uuid::Uuid,
    pub server_uuid: uuid::Uuid,
    pub dbev_node_uuid: uuid::Uuid,
    pub protocol: DatabaseProtocol,
    pub display_name: String,
    pub database_name: String,
    pub username: String,
    pub password: Vec<u8>,
    pub public_host: String,
    pub public_port: i32,
    pub tls: bool,
    pub status: String,
    pub image: Option<String>,
    pub cpu_cores: f64,
    pub memory_mib: i64,
    pub disk_mib: i64,
    pub limits_sync_pending: bool,
    pub last_error: Option<String>,
    pub metadata: serde_json::Value,
    pub created: chrono::DateTime<chrono::Utc>,
    pub updated: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct DatabaseRecordApi {
    pub uuid: uuid::Uuid,
    pub node_uuid: uuid::Uuid,
    pub protocol: DatabaseProtocol,
    pub protocol_label: &'static str,
    pub display_name: String,
    pub database_name: String,
    pub username: String,
    pub password: Option<String>,
    pub public_host: String,
    pub public_port: i32,
    pub tls: bool,
    pub connection_uri: Option<String>,
    pub status: String,
    pub image: Option<String>,
    pub default_image: Option<String>,
    pub allowed_images: Vec<String>,
    pub stream_exports_only: bool,
    pub max_artifacts_per_instance: u32,
    pub limits: ResourceLimits,
    pub limits_sync_pending: bool,
    pub last_error: Option<String>,
    pub metadata: serde_json::Value,
    pub created: chrono::DateTime<chrono::Utc>,
    pub updated: chrono::DateTime<chrono::Utc>,
}

impl DatabaseRecord {
    fn map(row: &PgRow) -> Result<Self, anyhow::Error> {
        let protocol: String = row.try_get("protocol")?;
        Ok(Self {
            uuid: row.try_get("uuid")?,
            server_uuid: row.try_get("server_uuid")?,
            dbev_node_uuid: row.try_get("dbev_node_uuid")?,
            protocol: DatabaseProtocol::from_str(&protocol)?,
            display_name: row.try_get("display_name")?,
            database_name: row.try_get("database_name")?,
            username: row.try_get("username")?,
            password: row.try_get("password")?,
            public_host: row.try_get("public_host")?,
            public_port: row.try_get("public_port")?,
            tls: row.try_get("tls")?,
            status: row.try_get("status")?,
            image: row.try_get("image")?,
            cpu_cores: row.try_get("cpu_cores")?,
            memory_mib: row.try_get("memory_mib")?,
            disk_mib: row.try_get("disk_mib")?,
            limits_sync_pending: row.try_get("limits_sync_pending")?,
            last_error: row.try_get("last_error")?,
            metadata: row.try_get("metadata")?,
            created: row.try_get("created")?,
            updated: row.try_get("updated")?,
        })
    }

    pub fn instance_id(&self) -> String {
        self.uuid.to_string()
    }

    pub fn limits(&self) -> ResourceLimits {
        ResourceLimits {
            cpu_cores: self.cpu_cores,
            memory_mib: self.memory_mib,
            disk_mib: self.disk_mib,
        }
    }

    pub async fn decrypted_password(&self, state: &State) -> Result<String, anyhow::Error> {
        Ok(state
            .database
            .decrypt(self.password.clone())
            .await?
            .to_string())
    }

    pub async fn into_api(
        self,
        state: &State,
        include_password: bool,
    ) -> Result<DatabaseRecordApi, anyhow::Error> {
        let password = if include_password {
            Some(self.decrypted_password(state).await?)
        } else {
            None
        };
        let connection_uri = password
            .as_deref()
            .and_then(|password| self.connection_uri(password).ok());
        let protocol_label = self.protocol.label();
        let limits = self.limits();
        let node = NodeRecord::by_uuid(state, self.dbev_node_uuid).await?;
        let default_image = node
            .as_ref()
            .and_then(|node| node.default_image(self.protocol));
        let allowed_images = node
            .as_ref()
            .map(|node| node.allowed_images(self.protocol))
            .unwrap_or_default();
        let stream_exports_only = node.as_ref().is_some_and(NodeRecord::stream_exports_only);
        let max_artifacts_per_instance = node
            .as_ref()
            .map(NodeRecord::max_artifacts_per_instance)
            .unwrap_or(20);

        Ok(DatabaseRecordApi {
            uuid: self.uuid,
            node_uuid: self.dbev_node_uuid,
            protocol: self.protocol,
            protocol_label,
            display_name: self.display_name,
            database_name: self.database_name,
            username: self.username,
            password,
            public_host: self.public_host,
            public_port: self.public_port,
            tls: self.tls,
            connection_uri,
            status: self.status,
            image: self.image,
            default_image,
            allowed_images,
            stream_exports_only,
            max_artifacts_per_instance,
            limits,
            limits_sync_pending: self.limits_sync_pending,
            last_error: self.last_error,
            metadata: self.metadata,
            created: self.created,
            updated: self.updated,
        })
    }

    fn connection_uri(&self, password: &str) -> Result<String, anyhow::Error> {
        let host = if self.public_host.contains(':') && !self.public_host.starts_with('[') {
            format!("[{}]", self.public_host)
        } else {
            self.public_host.clone()
        };
        if self.protocol == DatabaseProtocol::Qdrant {
            return Ok(format!(
                "{}://{host}:{}",
                if self.tls { "grpcs" } else { "grpc" },
                self.public_port,
            ));
        }

        let scheme = match self.protocol {
            DatabaseProtocol::Postgres => "postgresql",
            DatabaseProtocol::Mysql => "mysql",
            DatabaseProtocol::Mariadb => "mariadb",
            DatabaseProtocol::Redis => {
                if self.tls {
                    "rediss"
                } else {
                    "redis"
                }
            }
            DatabaseProtocol::Valkey => {
                if self.tls {
                    "rediss"
                } else {
                    "redis"
                }
            }
            DatabaseProtocol::Mongodb => "mongodb",
            DatabaseProtocol::Clickhouse => {
                if self.tls {
                    "clickhouses"
                } else {
                    "clickhouse"
                }
            }
            DatabaseProtocol::Qdrant => unreachable!("Qdrant handled above"),
        };
        let database = if matches!(
            self.protocol,
            DatabaseProtocol::Redis | DatabaseProtocol::Valkey
        ) {
            "0"
        } else {
            &self.database_name
        };
        Ok(format!(
            "{scheme}://{}:{}@{host}:{}/{}",
            urlencoding::encode(&self.username),
            urlencoding::encode(password),
            self.public_port,
            urlencoding::encode(database),
        ))
    }

    pub async fn all_for_server(
        state: &State,
        server_uuid: uuid::Uuid,
    ) -> Result<Vec<Self>, anyhow::Error> {
        let rows = safe_query!(
            ("SELECT * FROM {DATABASES_TABLE} WHERE server_uuid = $1 ORDER BY created")
        )
        .bind(server_uuid)
        .fetch_all(state.database.read())
        .await?;
        rows.iter().map(Self::map).collect()
    }

    pub async fn pending_limit_sync(state: &State) -> Result<Vec<Self>, anyhow::Error> {
        let rows = safe_query!((
            "SELECT * FROM {DATABASES_TABLE} WHERE limits_sync_pending = true ORDER BY updated LIMIT 50"
        ))
        .fetch_all(state.database.read())
        .await?;
        rows.iter().map(Self::map).collect()
    }

    pub async fn by_server_uuid(
        state: &State,
        server_uuid: uuid::Uuid,
        uuid: uuid::Uuid,
    ) -> Result<Option<Self>, anyhow::Error> {
        let row =
            safe_query!(("SELECT * FROM {DATABASES_TABLE} WHERE server_uuid = $1 AND uuid = $2"))
                .bind(server_uuid)
                .bind(uuid)
                .fetch_optional(state.database.read())
                .await?;
        row.as_ref().map(Self::map).transpose()
    }

    pub async fn count_all_for_server(
        state: &State,
        server_uuid: uuid::Uuid,
    ) -> Result<i64, anyhow::Error> {
        let count = sqlx::query_scalar(
            r#"
            SELECT
                (SELECT COUNT(*) FROM server_databases WHERE server_uuid = $1)
              + (SELECT COUNT(*) FROM server_database_instances WHERE server_uuid = $1)
              + (SELECT COUNT(*) FROM com_tomaxikz_databaseseverywhere_databases WHERE server_uuid = $1)
            "#,
        )
        .bind(server_uuid)
        .fetch_one(state.database.read())
        .await?;
        Ok(count)
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn create(
        state: &State,
        uuid: uuid::Uuid,
        server_uuid: uuid::Uuid,
        node_uuid: uuid::Uuid,
        protocol: DatabaseProtocol,
        display_name: &str,
        database_name: &str,
        username: &str,
        password: &str,
        public_host: &str,
        public_port: i32,
        tls: bool,
        status: &str,
        image: Option<&str>,
        limits: ResourceLimits,
        metadata: serde_json::Value,
    ) -> Result<Self, anyhow::Error> {
        let encrypted_password = state.database.encrypt(password.to_owned()).await?;
        let row = safe_query!((r#"
            INSERT INTO {DATABASES_TABLE}
                (uuid, server_uuid, dbev_node_uuid, protocol, display_name, database_name,
                 username, password, public_host, public_port, tls, status, image,
                 cpu_cores, memory_mib, disk_mib, metadata)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
            RETURNING *
            "#,))
        .bind(uuid)
        .bind(server_uuid)
        .bind(node_uuid)
        .bind(protocol.as_str())
        .bind(display_name)
        .bind(database_name)
        .bind(username)
        .bind(encrypted_password)
        .bind(public_host)
        .bind(public_port)
        .bind(tls)
        .bind(status)
        .bind(image)
        .bind(limits.cpu_cores)
        .bind(limits.memory_mib)
        .bind(limits.disk_mib)
        .bind(metadata)
        .fetch_one(state.database.write())
        .await?;
        Self::map(&row)
    }

    pub async fn update_remote_state(
        &self,
        state: &State,
        remote: &serde_json::Value,
    ) -> Result<(), anyhow::Error> {
        // Lifecycle responses wrap the authoritative metadata in `instance`.
        let instance = remote_instance(remote);
        let status = instance
            .get("status")
            .and_then(serde_json::Value::as_str)
            .unwrap_or(&self.status);
        let public_host = instance
            .pointer("/public/host")
            .and_then(serde_json::Value::as_str)
            .unwrap_or(&self.public_host);
        let public_port = instance
            .pointer("/public/port")
            .and_then(serde_json::Value::as_i64)
            .and_then(|value| i32::try_from(value).ok())
            .unwrap_or(self.public_port);
        let image = instance
            .pointer("/image/current")
            .and_then(serde_json::Value::as_str)
            .or_else(|| remote.get("image").and_then(serde_json::Value::as_str))
            .or(self.image.as_deref());
        let metadata = merge_remote_metadata(&self.metadata, instance);
        let last_error = remote
            .pointer("/progress/diagnostic/message")
            .or_else(|| remote.pointer("/diagnostic/message"))
            .or_else(|| instance.pointer("/diagnostic/message"))
            .and_then(serde_json::Value::as_str)
            .filter(|message| !message.trim().is_empty());

        safe_query!((r#"
            UPDATE {DATABASES_TABLE}
            SET status = $2, public_host = $3, public_port = $4, image = $5,
                metadata = $6, last_error = $7, updated = now()
            WHERE uuid = $1
            "#,))
        .bind(self.uuid)
        .bind(status)
        .bind(public_host)
        .bind(public_port)
        .bind(image)
        .bind(metadata)
        .bind(last_error)
        .execute(state.database.write())
        .await?;
        Ok(())
    }

    pub async fn update_limits(
        &self,
        state: &State,
        limits: ResourceLimits,
        synchronized: bool,
    ) -> Result<(), anyhow::Error> {
        safe_query!((r#"
            UPDATE {DATABASES_TABLE}
            SET cpu_cores = $2, memory_mib = $3, disk_mib = $4,
                limits_sync_pending = $5, last_error = NULL, updated = now()
            WHERE uuid = $1
            "#,))
        .bind(self.uuid)
        .bind(limits.cpu_cores)
        .bind(limits.memory_mib)
        .bind(limits.disk_mib)
        .bind(!synchronized)
        .execute(state.database.write())
        .await?;
        Ok(())
    }

    pub async fn update_password(
        &self,
        state: &State,
        password: &str,
    ) -> Result<(), anyhow::Error> {
        let encrypted_password = state.database.encrypt(password.to_owned()).await?;
        safe_query!((
            "UPDATE {DATABASES_TABLE} SET password = $2, last_error = NULL, updated = now() WHERE uuid = $1"
        ))
        .bind(self.uuid)
        .bind(encrypted_password)
        .execute(state.database.write())
        .await?;
        Ok(())
    }

    pub async fn store_error(&self, state: &State, error: &str) -> Result<(), anyhow::Error> {
        safe_query!(
            ("UPDATE {DATABASES_TABLE} SET last_error = $2, updated = now() WHERE uuid = $1")
        )
        .bind(self.uuid)
        .bind(error)
        .execute(state.database.write())
        .await?;
        Ok(())
    }

    pub async fn delete_local(&self, state: &State) -> Result<(), anyhow::Error> {
        safe_query!(("DELETE FROM {DATABASES_TABLE} WHERE uuid = $1"))
            .bind(self.uuid)
            .execute(state.database.write())
            .await?;
        Ok(())
    }
}

fn remote_instance(remote: &serde_json::Value) -> &serde_json::Value {
    remote
        .get("instance")
        .filter(|instance| instance.is_object())
        .unwrap_or(remote)
}

fn merge_remote_metadata(
    existing: &serde_json::Value,
    remote: &serde_json::Value,
) -> serde_json::Value {
    let mut merged = existing.as_object().cloned().unwrap_or_default();
    if let Some(remote) = remote.as_object() {
        merged.extend(remote.clone());
    }
    serde_json::Value::Object(merged)
}

#[cfg(test)]
mod tests {
    use super::{merge_remote_metadata, remote_instance};

    #[test]
    fn unwraps_lifecycle_instance_metadata() {
        let response = serde_json::json!({
            "action": "restart",
            "instance": {
                "status": "running",
                "image": { "current": "mysql:8.4" }
            }
        });

        assert_eq!(remote_instance(&response)["status"], "running");
        assert_eq!(remote_instance(&response)["image"]["current"], "mysql:8.4");
    }

    #[test]
    fn keeps_unwrapped_remote_metadata() {
        let response = serde_json::json!({ "status": "stopped" });
        assert_eq!(remote_instance(&response)["status"], "stopped");
    }

    #[test]
    fn partial_status_responses_preserve_runtime_metadata() {
        let existing = serde_json::json!({
            "status": "running",
            "image": { "current": "mysql:8.4", "update_available": false },
            "api_version": "v1"
        });
        let status = serde_json::json!({ "instance_id": "database-1", "status": "stopped" });

        let merged = merge_remote_metadata(&existing, &status);
        assert_eq!(merged["status"], "stopped");
        assert_eq!(merged["image"]["current"], "mysql:8.4");
        assert_eq!(merged["api_version"], "v1");
    }
}
