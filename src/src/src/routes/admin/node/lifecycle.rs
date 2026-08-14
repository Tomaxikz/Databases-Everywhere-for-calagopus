use super::super::{panel_url, validate_defaults, validate_name_and_endpoint};
use crate::{
    dbev::mutation_contract_block_reason,
    persistence::{
        GeneratedNodeCredentials, NodeConfigurationSecretsPatch, NodeRecord, NodeRecordApi,
    },
};
use axum::Extension;
use serde::{Deserialize, Serialize};
use shared::{
    ApiError, GetState, State,
    models::{admin_activity::GetAdminActivityLogger, user::GetPermissionManager},
    response::{ApiResponse, ApiResponseResult},
};
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};

fn ensure_node_record_mutable(
    cached_system: Option<&serde_json::Value>,
) -> Result<(), anyhow::Error> {
    let Some(system) = cached_system else {
        // Keep recovery possible when the API URL or credentials have not produced a sample yet.
        return Ok(());
    };
    if let Some(reason) = mutation_contract_block_reason(Some(system)) {
        return Err(shared::response::DisplayError::new(reason)
            .with_status(axum::http::StatusCode::CONFLICT)
            .into());
    }
    Ok(())
}

#[derive(Serialize, ToSchema)]
struct NodeResponse {
    node: NodeRecordApi,
}

mod get {
    use super::*;

    #[utoipa::path(get, path = "/", responses((status = OK, body = inline(NodeResponse))))]
    pub async fn route(Extension(node): Extension<NodeRecord>) -> ApiResponseResult {
        ApiResponse::new_serialized(NodeResponse {
            node: node.into_api(),
        })
        .ok()
    }
}

mod patch {
    use super::*;

    #[derive(Deserialize, ToSchema)]
    pub struct Payload {
        name: Option<String>,
        enabled: Option<bool>,
        api_url: Option<String>,
        public_host: Option<String>,
        default_cpu_cores: Option<f64>,
        default_memory_mib: Option<i64>,
        default_disk_mib: Option<i64>,
        #[schema(value_type = Option<serde_json::Value>)]
        configuration: Option<serde_json::Value>,
        configuration_secrets: Option<NodeConfigurationSecretsPatch>,
    }

    #[utoipa::path(patch, path = "/", request_body = inline(Payload), responses(
        (status = OK, body = inline(NodeResponse)),
        (status = BAD_REQUEST, body = ApiError),
        (status = CONFLICT, body = ApiError),
    ))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
        activity_logger: GetAdminActivityLogger,
        Extension(node): Extension<NodeRecord>,
        shared::Payload(data): shared::Payload<Payload>,
    ) -> ApiResponseResult {
        permissions.has_admin_permission("databases-everywhere-nodes.update")?;
        ensure_node_record_mutable(node.cached_system.as_ref())?;
        let name = data.name.as_deref().unwrap_or(&node.name);
        let api_url = data.api_url.as_deref().unwrap_or(&node.api_url);
        let public_host = data.public_host.as_deref().unwrap_or(&node.public_host);
        validate_name_and_endpoint(name, api_url, public_host)?;
        let cpu = data.default_cpu_cores.unwrap_or(node.default_cpu_cores);
        let memory = data.default_memory_mib.unwrap_or(node.default_memory_mib);
        let disk = data.default_disk_mib.unwrap_or(node.default_disk_mib);
        validate_defaults(cpu, memory, disk)?;
        let configuration = data
            .configuration
            .unwrap_or_else(|| node.configuration.clone());
        let updated = node
            .update(
                &state,
                name.trim(),
                data.enabled.unwrap_or(node.enabled),
                api_url.trim_end_matches('/'),
                public_host.trim(),
                cpu,
                memory,
                disk,
                configuration,
                data.configuration_secrets,
            )
            .await?;
        activity_logger
            .log(
                "databases-everywhere-node:update",
                serde_json::json!({
                    "uuid": updated.uuid,
                    "name": updated.name,
                    "enabled": updated.enabled,
                    "api_url": updated.api_url,
                    "public_host": updated.public_host,
                    "default_cpu_cores": updated.default_cpu_cores,
                    "default_memory_mib": updated.default_memory_mib,
                    "default_disk_mib": updated.default_disk_mib,
                }),
            )
            .await;
        ApiResponse::new_serialized(NodeResponse {
            node: updated.into_api(),
        })
        .ok()
    }
}

mod delete {
    use super::*;

    #[derive(Serialize, ToSchema)]
    struct Response {}

    #[utoipa::path(delete, path = "/", responses(
        (status = OK, body = inline(Response)),
        (status = BAD_REQUEST, body = ApiError),
        (status = CONFLICT, body = ApiError),
    ))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
        activity_logger: GetAdminActivityLogger,
        Extension(node): Extension<NodeRecord>,
    ) -> ApiResponseResult {
        permissions.has_admin_permission("databases-everywhere-nodes.delete")?;
        ensure_node_record_mutable(node.cached_system.as_ref())?;
        node.delete(&state).await?;
        activity_logger
            .log(
                "databases-everywhere-node:delete",
                serde_json::json!({ "uuid": node.uuid, "name": node.name }),
            )
            .await;
        ApiResponse::new_serialized(Response {}).ok()
    }
}

mod config {
    use super::*;

    #[derive(Serialize, ToSchema)]
    struct Response {
        configuration_yaml: String,
    }

    #[utoipa::path(get, path = "/config", responses((status = OK, body = inline(Response))))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
        Extension(node): Extension<NodeRecord>,
    ) -> ApiResponseResult {
        permissions.has_admin_permission("databases-everywhere-nodes.credentials")?;
        let panel_url = panel_url(&state).await?;
        ApiResponse::new_serialized(Response {
            configuration_yaml: node.render_configuration(&state, &panel_url, None).await?,
        })
        .ok()
    }
}

mod reset_credentials {
    use super::*;

    #[derive(Serialize, ToSchema)]
    struct Response {
        credentials: GeneratedNodeCredentials,
    }

    #[utoipa::path(post, path = "/reset-credentials", responses(
        (status = OK, body = inline(Response)),
        (status = CONFLICT, body = ApiError),
    ))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
        activity_logger: GetAdminActivityLogger,
        Extension(node): Extension<NodeRecord>,
    ) -> ApiResponseResult {
        permissions.has_admin_permission("databases-everywhere-nodes.credentials")?;
        ensure_node_record_mutable(node.cached_system.as_ref())?;
        let panel_url = panel_url(&state).await?;
        let credentials = node.reset_credentials(&state, &panel_url).await?;
        activity_logger
            .log(
                "databases-everywhere-node:reset-credentials",
                serde_json::json!({ "uuid": node.uuid }),
            )
            .await;
        ApiResponse::new_serialized(Response { credentials }).ok()
    }
}

pub fn router(state: &State) -> OpenApiRouter<State> {
    OpenApiRouter::new()
        .routes(routes!(get::route))
        .routes(routes!(patch::route))
        .routes(routes!(delete::route))
        .routes(routes!(config::route))
        .routes(routes!(reset_credentials::route))
        .with_state(state.clone())
}

#[cfg(test)]
mod tests {
    use super::ensure_node_record_mutable;

    #[test]
    fn node_record_recovery_is_allowed_until_a_contract_mismatch_is_known() {
        assert!(ensure_node_record_mutable(None).is_ok());
        assert!(
            ensure_node_record_mutable(Some(&serde_json::json!({
                "service": "databases-everywhere",
                "api_version": "0.12.0",
                "prevent_cpu_overallocation": true,
                "prevent_memory_overallocation": true,
                "prevent_disk_overallocation": true
            })))
            .is_ok()
        );
        assert!(
            ensure_node_record_mutable(Some(&serde_json::json!({
                "service": "databases-everywhere",
                "api_version": "0.11.0"
            })))
            .is_err()
        );
    }
}
