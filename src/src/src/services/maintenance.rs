use crate::{
    dbev::{DbevClient, validate_system_response},
    domain::{ResourceLimits, ServerDatabaseConfigurationExtension},
    persistence::{DatabaseRecord, DeleteInstanceOperation, NodeRecord},
    settings::{ExtensionSettingsData, normalize_node_health_interval},
};
use shared::{
    State,
    models::{BaseModel, ByUuid, server::Server},
};
use std::time::Duration;

pub async fn run_maintenance_loop(state: State) {
    let mut next_health_refresh = tokio::time::Instant::now();
    let mut next_limit_sync = tokio::time::Instant::now();
    loop {
        let (enabled, health_interval) = match maintenance_settings(&state).await {
            Ok(settings) => settings,
            Err(error) => {
                tracing::error!(error = ?error, "failed to read DatabasesEverywhere settings");
                (true, 300)
            }
        };

        if enabled {
            let now = tokio::time::Instant::now();
            if now >= next_health_refresh {
                if let Err(error) = refresh_node_health(&state).await {
                    tracing::warn!(error = ?error, "DatabasesEverywhere node health refresh failed");
                }
                next_health_refresh = now + Duration::from_secs(health_interval);
            }
            if let Err(error) = process_deletion_operations(&state).await {
                tracing::warn!(error = ?error, "DatabasesEverywhere deletion outbox processing failed");
            }
            if now >= next_limit_sync {
                if let Err(error) = synchronize_database_limits(&state).await {
                    tracing::warn!(error = ?error, "DatabasesEverywhere resource synchronization failed");
                }
                next_limit_sync = now + Duration::from_secs(60);
            }
        } else {
            next_health_refresh = tokio::time::Instant::now();
            next_limit_sync = tokio::time::Instant::now();
        }

        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

pub async fn synchronize_database_limits(state: &State) -> Result<(), anyhow::Error> {
    for database in DatabaseRecord::pending_limit_sync(state).await? {
        let result = synchronize_one(state, &database).await;
        if let Err(error) = result {
            database.store_error(state, &error.to_string()).await?;
            tracing::warn!(database = %database.uuid, error = ?error, "failed to synchronize DatabasesEverywhere limits");
        }
    }
    Ok(())
}

async fn synchronize_one(state: &State, database: &DatabaseRecord) -> Result<(), anyhow::Error> {
    let server = Server::by_uuid_optional(&state.database, database.server_uuid)
        .await?
        .ok_or_else(|| anyhow::anyhow!("server no longer exists"))?;
    let configuration = server.parse_model_extension::<ServerDatabaseConfigurationExtension>()?;
    let node = NodeRecord::by_uuid(state, database.dbev_node_uuid)
        .await?
        .ok_or_else(|| anyhow::anyhow!("DatabasesEverywhere node no longer exists"))?;
    let requested = ResourceLimits {
        cpu_cores: configuration.cpu_cores.unwrap_or(node.default_cpu_cores),
        memory_mib: configuration.memory_mib.unwrap_or(node.default_memory_mib),
        disk_mib: configuration.disk_mib.unwrap_or(node.default_disk_mib),
    }
    .with_protocol_floors(database.protocol);
    let client = DbevClient::for_mutation(state, &node).await?;
    let path = format!(
        "/api/instances/{}/limits",
        urlencoding::encode(&database.instance_id())
    );
    client
        .patch::<serde_json::Value, _>(&path, &requested)
        .await?;
    database.update_limits(state, requested, true).await
}

async fn refresh_node_health(state: &State) -> Result<(), anyhow::Error> {
    for node in NodeRecord::all(state)
        .await?
        .into_iter()
        .filter(|node| node.enabled)
    {
        let client = match DbevClient::for_node(state, &node).await {
            Ok(client) => client,
            Err(error) => {
                node.store_health(state, None, None, Some(&error.to_string()))
                    .await?;
                continue;
            }
        };
        let health = async {
            let heartbeat = client.get::<serde_json::Value>("/api/heartbeat").await?;
            if heartbeat.get("status").and_then(serde_json::Value::as_str) != Some("ok") {
                return Err(anyhow::anyhow!("node heartbeat is not ready"));
            }
            let system = client.get::<serde_json::Value>("/api/system").await?;
            Ok::<_, anyhow::Error>(system)
        }
        .await;
        match health {
            Ok(system) => {
                let contract_error = validate_system_response(&system)
                    .err()
                    .map(|error| error.to_string());
                node.store_health(state, Some(&system), None, contract_error.as_deref())
                    .await?;
            }
            Err(error) => {
                node.store_health(state, None, None, Some(&error.to_string()))
                    .await?;
            }
        }
    }
    Ok(())
}

async fn process_deletion_operations(state: &State) -> Result<(), anyhow::Error> {
    for operation in DeleteInstanceOperation::due(state).await? {
        let result = async {
            let node = NodeRecord::by_uuid(state, operation.dbev_node_uuid)
                .await?
                .ok_or_else(|| anyhow::anyhow!("DatabasesEverywhere node no longer exists"))?;
            let client = DbevClient::for_mutation(state, &node).await?;
            let path = format!(
                "/api/instances/{}?confirm=true&reason={}",
                urlencoding::encode(&operation.instance_id),
                urlencoding::encode(&operation.reason),
            );
            client.delete_allow_not_found(&path).await?;
            Ok::<_, anyhow::Error>(())
        }
        .await;
        match result {
            Ok(()) => operation.complete(state).await?,
            Err(error) => operation.fail(state, &error.to_string()).await?,
        }
    }
    Ok(())
}

async fn maintenance_settings(state: &State) -> Result<(bool, u64), anyhow::Error> {
    let settings = state.settings.get().await?;
    let extension = settings
        .get_extension_settings::<ExtensionSettingsData>("com.tomaxikz.databaseseverywhere")?;
    Ok((
        extension.enabled,
        normalize_node_health_interval(extension.node_health_interval_seconds),
    ))
}
