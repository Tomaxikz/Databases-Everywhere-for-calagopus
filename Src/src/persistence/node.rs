use super::node_configuration::{
    NodeConfigurationSecrets, NodeConfigurationSecretsPatch, apply_configuration_secrets,
    embedded_configuration_secrets, normalize_daemon_configuration, public_daemon_configuration,
};
use crate::{
    domain::DatabaseProtocol,
    persistence::{DATABASES_TABLE, NODES_TABLE, OPERATIONS_TABLE},
};
use rand::distr::SampleString;
use serde::Serialize;
use shared::State;
use sqlx::{Row, postgres::PgRow};
use utoipa::ToSchema;

#[derive(Debug, Clone)]
pub struct NodeRecord {
    pub uuid: uuid::Uuid,
    pub name: String,
    pub enabled: bool,
    pub api_url: String,
    pub public_host: String,
    pub daemon_uuid: String,
    pub token_id: String,
    pub api_token: Vec<u8>,
    pub jwt_signing_key: Vec<u8>,
    pub default_cpu_cores: f64,
    pub default_memory_mib: i64,
    pub default_disk_mib: i64,
    pub configuration: serde_json::Value,
    pub configuration_secrets: Option<Vec<u8>>,
    pub cached_system: Option<serde_json::Value>,
    pub cached_resources: Option<serde_json::Value>,
    pub last_seen: Option<chrono::DateTime<chrono::Utc>>,
    pub last_error: Option<String>,
    pub created: chrono::DateTime<chrono::Utc>,
    pub updated: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct NodeRecordApi {
    pub uuid: uuid::Uuid,
    pub name: String,
    pub enabled: bool,
    pub api_url: String,
    pub public_host: String,
    pub daemon_uuid: String,
    pub token_id: String,
    pub default_cpu_cores: f64,
    pub default_memory_mib: i64,
    pub default_disk_mib: i64,
    pub configuration: serde_json::Value,
    pub has_configuration_secrets: bool,
    pub cached_system: Option<serde_json::Value>,
    pub cached_resources: Option<serde_json::Value>,
    pub last_seen: Option<chrono::DateTime<chrono::Utc>>,
    pub last_error: Option<String>,
    pub created: chrono::DateTime<chrono::Utc>,
    pub updated: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct GeneratedNodeCredentials {
    pub daemon_uuid: String,
    pub token_id: String,
    pub token: String,
    pub jwt_signing_key: String,
    pub configuration_yaml: String,
}

impl NodeRecord {
    pub(super) fn map(row: &PgRow) -> Result<Self, sqlx::Error> {
        Ok(Self {
            uuid: row.try_get("uuid")?,
            name: row.try_get("name")?,
            enabled: row.try_get("enabled")?,
            api_url: row.try_get("api_url")?,
            public_host: row.try_get("public_host")?,
            daemon_uuid: row.try_get("daemon_uuid")?,
            token_id: row.try_get("token_id")?,
            api_token: row.try_get("api_token")?,
            jwt_signing_key: row.try_get("jwt_signing_key")?,
            default_cpu_cores: row.try_get("default_cpu_cores")?,
            default_memory_mib: row.try_get("default_memory_mib")?,
            default_disk_mib: row.try_get("default_disk_mib")?,
            configuration: row.try_get("configuration")?,
            configuration_secrets: row.try_get("configuration_secrets")?,
            cached_system: row.try_get("cached_system")?,
            cached_resources: row.try_get("cached_resources")?,
            last_seen: row.try_get("last_seen")?,
            last_error: row.try_get("last_error")?,
            created: row.try_get("created")?,
            updated: row.try_get("updated")?,
        })
    }

    pub fn into_api(self) -> NodeRecordApi {
        let has_configuration_secrets = self.configuration_secrets.is_some()
            || !embedded_configuration_secrets(&self.configuration).is_empty();
        NodeRecordApi {
            uuid: self.uuid,
            name: self.name,
            enabled: self.enabled,
            api_url: self.api_url,
            public_host: self.public_host,
            daemon_uuid: self.daemon_uuid,
            token_id: self.token_id,
            default_cpu_cores: self.default_cpu_cores,
            default_memory_mib: self.default_memory_mib,
            default_disk_mib: self.default_disk_mib,
            configuration: public_daemon_configuration(&self.configuration),
            has_configuration_secrets,
            cached_system: self.cached_system,
            cached_resources: self.cached_resources,
            last_seen: self.last_seen,
            last_error: self.last_error,
            created: self.created,
            updated: self.updated,
        }
    }

    pub async fn all(state: &State) -> Result<Vec<Self>, anyhow::Error> {
        let rows = safe_query!(("SELECT * FROM {NODES_TABLE} ORDER BY name, created"))
            .fetch_all(state.database.read())
            .await?;
        rows.iter()
            .map(Self::map)
            .collect::<Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    pub async fn by_uuid(state: &State, uuid: uuid::Uuid) -> Result<Option<Self>, anyhow::Error> {
        let row = safe_query!(("SELECT * FROM {NODES_TABLE} WHERE uuid = $1"))
            .bind(uuid)
            .fetch_optional(state.database.read())
            .await?;
        row.as_ref().map(Self::map).transpose().map_err(Into::into)
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn create(
        state: &State,
        name: &str,
        enabled: bool,
        api_url: &str,
        public_host: &str,
        default_cpu_cores: f64,
        default_memory_mib: i64,
        default_disk_mib: i64,
        configuration: serde_json::Value,
        configuration_secrets: Option<NodeConfigurationSecretsPatch>,
        panel_url: &str,
    ) -> Result<(Self, GeneratedNodeCredentials), anyhow::Error> {
        let daemon_uuid = uuid::Uuid::new_v4().to_string();
        let token_id = rand::distr::Alphanumeric.sample_string(&mut rand::rng(), 16);
        let token = rand::distr::Alphanumeric.sample_string(&mut rand::rng(), 64);
        let jwt_signing_key = rand::distr::Alphanumeric.sample_string(&mut rand::rng(), 64);
        let encrypted_token = state.database.encrypt(token.clone()).await?;
        let encrypted_jwt = state.database.encrypt(jwt_signing_key.clone()).await?;
        let (configuration, embedded_secrets) = normalize_daemon_configuration(configuration)?;
        let mut secrets = NodeConfigurationSecrets::default();
        secrets.overlay_non_empty(embedded_secrets);
        secrets.apply_patch(configuration_secrets);
        let encrypted_configuration_secrets =
            Self::encrypt_configuration_secrets(state, &secrets).await?;

        let row = safe_query!((r#"
            INSERT INTO {NODES_TABLE}
                (name, enabled, api_url, public_host, daemon_uuid, token_id,
                 api_token, jwt_signing_key, default_cpu_cores, default_memory_mib,
                 default_disk_mib, configuration, configuration_secrets)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            RETURNING *
            "#,))
        .bind(name)
        .bind(enabled)
        .bind(api_url)
        .bind(public_host)
        .bind(&daemon_uuid)
        .bind(&token_id)
        .bind(encrypted_token)
        .bind(encrypted_jwt)
        .bind(default_cpu_cores)
        .bind(default_memory_mib)
        .bind(default_disk_mib)
        .bind(configuration)
        .bind(encrypted_configuration_secrets)
        .fetch_one(state.database.write())
        .await?;

        let record = Self::map(&row)?;
        let configuration_yaml = record
            .render_configuration(state, panel_url, Some((&token, &jwt_signing_key)))
            .await?;
        Ok((
            record,
            GeneratedNodeCredentials {
                daemon_uuid,
                token_id,
                token,
                jwt_signing_key,
                configuration_yaml,
            },
        ))
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn update(
        &self,
        state: &State,
        name: &str,
        enabled: bool,
        api_url: &str,
        public_host: &str,
        default_cpu_cores: f64,
        default_memory_mib: i64,
        default_disk_mib: i64,
        configuration: serde_json::Value,
        configuration_secrets: Option<NodeConfigurationSecretsPatch>,
    ) -> Result<Self, anyhow::Error> {
        let (configuration, embedded_secrets) = normalize_daemon_configuration(configuration)?;
        let mut secrets = self.decrypted_configuration_secrets(state).await?;
        secrets.overlay_non_empty(embedded_secrets);
        secrets.apply_patch(configuration_secrets);
        let encrypted_configuration_secrets =
            Self::encrypt_configuration_secrets(state, &secrets).await?;

        let row = safe_query!((r#"
            UPDATE {NODES_TABLE}
            SET name = $2, enabled = $3, api_url = $4, public_host = $5,
                default_cpu_cores = $6, default_memory_mib = $7,
                default_disk_mib = $8, configuration = $9,
                configuration_secrets = $10, updated = now()
            WHERE uuid = $1
            RETURNING *
            "#,))
        .bind(self.uuid)
        .bind(name)
        .bind(enabled)
        .bind(api_url)
        .bind(public_host)
        .bind(default_cpu_cores)
        .bind(default_memory_mib)
        .bind(default_disk_mib)
        .bind(configuration)
        .bind(encrypted_configuration_secrets)
        .fetch_one(state.database.write())
        .await?;

        safe_query!((r#"
            UPDATE {DATABASES_TABLE} AS database
            SET limits_sync_pending = true, updated = now()
            FROM servers
            WHERE database.server_uuid = servers.uuid
              AND database.dbev_node_uuid = $1
              AND (servers.dbev_database_cpu_cores IS NULL
                OR servers.dbev_database_memory_mib IS NULL
                OR servers.dbev_database_disk_mib IS NULL)
            "#,))
        .bind(self.uuid)
        .execute(state.database.write())
        .await?;

        Self::map(&row).map_err(Into::into)
    }

    pub async fn delete(&self, state: &State) -> Result<(), anyhow::Error> {
        let database_count: i64 = safe_query_scalar!(
            ("SELECT COUNT(*) FROM {DATABASES_TABLE} WHERE dbev_node_uuid = $1")
        )
        .bind(self.uuid)
        .fetch_one(state.database.read())
        .await?;
        let operation_count: i64 = safe_query_scalar!(
            ("SELECT COUNT(*) FROM {OPERATIONS_TABLE} WHERE dbev_node_uuid = $1")
        )
        .bind(self.uuid)
        .fetch_one(state.database.read())
        .await?;
        if database_count > 0 || operation_count > 0 {
            return Err(anyhow::anyhow!(
                "delete or reconcile every database and pending operation assigned to this node first"
            ));
        }

        safe_query!(("DELETE FROM {NODES_TABLE} WHERE uuid = $1"))
            .bind(self.uuid)
            .execute(state.database.write())
            .await?;
        Ok(())
    }

    pub async fn decrypted_token(&self, state: &State) -> Result<String, anyhow::Error> {
        Ok(state
            .database
            .decrypt(self.api_token.clone())
            .await?
            .to_string())
    }

    pub async fn decrypted_jwt_key(&self, state: &State) -> Result<String, anyhow::Error> {
        Ok(state
            .database
            .decrypt(self.jwt_signing_key.clone())
            .await?
            .to_string())
    }

    async fn decrypted_configuration_secrets(
        &self,
        state: &State,
    ) -> Result<NodeConfigurationSecrets, anyhow::Error> {
        let mut secrets = match &self.configuration_secrets {
            Some(encrypted) => {
                serde_json::from_str(state.database.decrypt(encrypted.clone()).await?.as_ref())?
            }
            None => NodeConfigurationSecrets::default(),
        };
        secrets.overlay_non_empty(embedded_configuration_secrets(&self.configuration));
        Ok(secrets)
    }

    async fn encrypt_configuration_secrets(
        state: &State,
        secrets: &NodeConfigurationSecrets,
    ) -> Result<Option<Vec<u8>>, anyhow::Error> {
        if secrets.is_empty() {
            Ok(None)
        } else {
            Ok(Some(
                state
                    .database
                    .encrypt(serde_json::to_string(secrets)?)
                    .await?,
            ))
        }
    }

    pub async fn reset_credentials(
        &self,
        state: &State,
        panel_url: &str,
    ) -> Result<GeneratedNodeCredentials, anyhow::Error> {
        let token_id = rand::distr::Alphanumeric.sample_string(&mut rand::rng(), 16);
        let token = rand::distr::Alphanumeric.sample_string(&mut rand::rng(), 64);
        let jwt_signing_key = rand::distr::Alphanumeric.sample_string(&mut rand::rng(), 64);
        let encrypted_token = state.database.encrypt(token.clone()).await?;
        let encrypted_jwt = state.database.encrypt(jwt_signing_key.clone()).await?;

        safe_query!((
            "UPDATE {NODES_TABLE} SET token_id = $2, api_token = $3, jwt_signing_key = $4, updated = now() WHERE uuid = $1"
        ))
        .bind(self.uuid)
        .bind(&token_id)
        .bind(encrypted_token)
        .bind(encrypted_jwt)
        .execute(state.database.write())
        .await?;

        let mut updated = self.clone();
        updated.token_id.clone_from(&token_id);
        let configuration_yaml = updated
            .render_configuration(state, panel_url, Some((&token, &jwt_signing_key)))
            .await?;

        Ok(GeneratedNodeCredentials {
            daemon_uuid: self.daemon_uuid.clone(),
            token_id,
            token,
            jwt_signing_key,
            configuration_yaml,
        })
    }

    pub async fn render_configuration(
        &self,
        state: &State,
        panel_url: &str,
        supplied_secrets: Option<(&str, &str)>,
    ) -> Result<String, anyhow::Error> {
        let (token, jwt_signing_key) = match supplied_secrets {
            Some((token, jwt)) => (token.to_owned(), jwt.to_owned()),
            None => (
                self.decrypted_token(state).await?,
                self.decrypted_jwt_key(state).await?,
            ),
        };

        let (mut configuration, _) = normalize_daemon_configuration(self.configuration.clone())?;
        let configuration_secrets = self.decrypted_configuration_secrets(state).await?;
        apply_configuration_secrets(&mut configuration, &configuration_secrets);
        let object = configuration
            .as_object_mut()
            .ok_or_else(|| anyhow::anyhow!("node configuration must be a JSON object"))?;
        object.insert(
            "remote".into(),
            serde_json::json!(panel_url.trim_end_matches('/')),
        );
        object.insert("uuid".into(), serde_json::json!(self.daemon_uuid));
        object.insert("token_id".into(), serde_json::json!(self.token_id));
        object.insert("token".into(), serde_json::json!(token));
        object.insert("jwt_signing_key".into(), serde_json::json!(jwt_signing_key));
        Ok(serde_norway::to_string(&configuration)?)
    }

    pub fn gateway_port(&self, protocol: DatabaseProtocol) -> u16 {
        self.configuration
            .get(protocol.as_str())
            .and_then(|value| value.get("bind"))
            .and_then(serde_json::Value::as_str)
            .and_then(|bind| {
                bind.rsplit_once(':')
                    .and_then(|(_, port)| port.parse().ok())
            })
            .unwrap_or_else(|| protocol.default_gateway_port())
    }

    pub fn clickhouse_http_port(&self) -> u16 {
        self.configuration
            .get("clickhouse")
            .and_then(|value| value.get("http_bind"))
            .and_then(serde_json::Value::as_str)
            .and_then(|bind| {
                bind.rsplit_once(':')
                    .and_then(|(_, port)| port.parse().ok())
            })
            .unwrap_or(20026)
    }

    pub fn protocol_tls(&self, protocol: DatabaseProtocol) -> bool {
        self.configuration
            .get(protocol.as_str())
            .and_then(|value| value.get("tls"))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
    }

    pub fn protocol_enabled(&self, protocol: DatabaseProtocol) -> bool {
        self.configuration
            .get(protocol.as_str())
            .and_then(|value| value.get("enabled"))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
    }

    pub fn default_image(&self, protocol: DatabaseProtocol) -> Option<String> {
        self.configuration
            .pointer(&format!("/images/{}", protocol.as_str()))
            .and_then(serde_json::Value::as_str)
            .filter(|image| !image.trim().is_empty())
            .map(str::to_owned)
    }

    pub fn allowed_images(&self, protocol: DatabaseProtocol) -> Vec<String> {
        let mut images = self
            .configuration
            .pointer(&format!("/images/allowed/{}", protocol.as_str()))
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(serde_json::Value::as_str)
            .filter(|image| !image.trim().is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if let Some(default) = self.default_image(protocol)
            && !images.contains(&default)
        {
            images.insert(0, default);
        }
        images.sort();
        images.dedup();
        images
    }

    pub fn allows_image(&self, protocol: DatabaseProtocol, image: Option<&str>) -> bool {
        let Some(image) = image.map(str::trim).filter(|image| !image.is_empty()) else {
            return true;
        };
        self.allowed_images(protocol)
            .iter()
            .any(|allowed| allowed == image)
    }

    pub fn stream_exports_only(&self) -> bool {
        self.configuration
            .pointer("/artifacts/stream_exports_only")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
    }

    pub fn max_artifacts_per_instance(&self) -> u32 {
        self.configuration
            .pointer("/artifacts/max_artifacts_per_instance")
            .and_then(serde_json::Value::as_u64)
            .and_then(|value| u32::try_from(value).ok())
            .filter(|value| (1..=10_000).contains(value))
            .unwrap_or(20)
    }

    pub async fn store_health(
        &self,
        state: &State,
        system: Option<&serde_json::Value>,
        resources: Option<&serde_json::Value>,
        error: Option<&str>,
    ) -> Result<(), anyhow::Error> {
        safe_query!((r#"
            UPDATE {NODES_TABLE}
            SET cached_system = COALESCE($2, cached_system),
                cached_resources = COALESCE($3, cached_resources),
                last_seen = CASE WHEN $4::text IS NULL THEN now() ELSE last_seen END,
                last_error = $4,
                updated = now()
            WHERE uuid = $1
            "#,))
        .bind(self.uuid)
        .bind(system)
        .bind(resources)
        .bind(error)
        .execute(state.database.write())
        .await?;
        Ok(())
    }

    pub async fn update_configuration(
        &self,
        state: &State,
        configuration: serde_json::Value,
    ) -> Result<(), anyhow::Error> {
        let (configuration, embedded_secrets) = normalize_daemon_configuration(configuration)?;
        let mut secrets = self.decrypted_configuration_secrets(state).await?;
        secrets.overlay_non_empty(embedded_secrets);
        let encrypted_configuration_secrets =
            Self::encrypt_configuration_secrets(state, &secrets).await?;
        safe_query!((
            "UPDATE {NODES_TABLE} SET configuration = $2, configuration_secrets = $3, updated = now() WHERE uuid = $1"
        ))
        .bind(self.uuid)
        .bind(configuration)
        .bind(encrypted_configuration_secrets)
        .execute(state.database.write())
        .await?;
        Ok(())
    }
}
