use crate::persistence::{
    GeneratedNodeCredentials, NodeConfigurationSecretsPatch, NodeRecord, NodeRecordApi,
    default_daemon_configuration,
};
use serde::{Deserialize, Serialize};
use shared::{
    ApiError, GetState, State,
    models::{admin_activity::GetAdminActivityLogger, user::GetPermissionManager},
    response::{ApiResponse, ApiResponseResult, DisplayError},
};
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};

mod assignments;
mod image_registry;
mod node;
mod settings;

#[derive(Serialize, ToSchema)]
struct ListResponse {
    nodes: Vec<NodeRecordApi>,
}

#[utoipa::path(get, path = "/", responses((status = OK, body = inline(ListResponse))))]
async fn get(state: GetState, permissions: GetPermissionManager) -> ApiResponseResult {
    permissions.has_admin_permission("databases-everywhere-nodes.read")?;
    ApiResponse::new_serialized(ListResponse {
        nodes: NodeRecord::all(&state)
            .await?
            .into_iter()
            .map(NodeRecord::into_api)
            .collect(),
    })
    .ok()
}

#[derive(Deserialize, ToSchema)]
struct CreatePayload {
    name: String,
    enabled: Option<bool>,
    api_url: String,
    public_host: String,
    default_cpu_cores: Option<f64>,
    default_memory_mib: Option<i64>,
    default_disk_mib: Option<i64>,
    #[schema(value_type = Option<serde_json::Value>)]
    configuration: Option<serde_json::Value>,
    configuration_secrets: Option<NodeConfigurationSecretsPatch>,
}

#[derive(Serialize, ToSchema)]
struct CreateResponse {
    node: NodeRecordApi,
    credentials: GeneratedNodeCredentials,
}

#[utoipa::path(post, path = "/", request_body = inline(CreatePayload), responses(
    (status = OK, body = inline(CreateResponse)),
    (status = BAD_REQUEST, body = ApiError),
    (status = CONFLICT, body = ApiError),
))]
async fn post(
    state: GetState,
    permissions: GetPermissionManager,
    activity_logger: GetAdminActivityLogger,
    shared::Payload(data): shared::Payload<CreatePayload>,
) -> ApiResponseResult {
    permissions.has_admin_permission("databases-everywhere-nodes.create")?;
    validate_name_and_endpoint(&data.name, &data.api_url, &data.public_host)?;
    let cpu = data.default_cpu_cores.unwrap_or(0.5);
    let memory = data.default_memory_mib.unwrap_or(512);
    let disk = data.default_disk_mib.unwrap_or(1024);
    validate_defaults(cpu, memory, disk)?;
    let configuration = data
        .configuration
        .unwrap_or_else(default_daemon_configuration);
    let panel_url = panel_url(&state).await?;
    let (node, credentials) = NodeRecord::create(
        &state,
        data.name.trim(),
        data.enabled.unwrap_or(true),
        data.api_url.trim_end_matches('/'),
        data.public_host.trim(),
        cpu,
        memory,
        disk,
        configuration,
        data.configuration_secrets,
        &panel_url,
    )
    .await?;
    activity_logger
        .log(
            "databases-everywhere-node:create",
            serde_json::json!({
                "uuid": node.uuid,
                "name": node.name,
                "enabled": node.enabled,
                "api_url": node.api_url,
                "public_host": node.public_host,
            }),
        )
        .await;
    ApiResponse::new_serialized(CreateResponse {
        node: node.into_api(),
        credentials,
    })
    .ok()
}

pub fn router(state: &State) -> OpenApiRouter<State> {
    OpenApiRouter::new()
        .nest("/assignments", assignments::router(state))
        .nest("/image-registry", image_registry::router(state))
        .nest("/settings", settings::router(state))
        .nest("/{dbev_node}", node::router(state))
        .routes(routes!(get))
        .routes(routes!(post))
        .with_state(state.clone())
}

pub(super) async fn panel_url(state: &State) -> Result<String, anyhow::Error> {
    let settings = state.settings.get().await?;
    let extension = settings.get_extension_settings::<crate::settings::ExtensionSettingsData>(
        "com.tomaxikz.databaseseverywhere",
    )?;
    Ok(if extension.panel_url.trim().is_empty() {
        settings.app.url.trim_end_matches('/').to_owned()
    } else {
        extension.panel_url.trim_end_matches('/').to_owned()
    })
}

pub(super) fn validate_defaults(cpu: f64, memory: i64, disk: i64) -> Result<(), anyhow::Error> {
    if !cpu.is_finite() || !(0.01..=1024.0).contains(&cpu) {
        return Err(DisplayError::new("default CPU must be between 0.01 and 1024 cores").into());
    }
    if !(1..=1_048_576).contains(&memory) {
        return Err(DisplayError::new("default memory must be between 1 and 1048576 MiB").into());
    }
    if disk < 1 {
        return Err(DisplayError::new("default disk must be at least 1 MiB").into());
    }
    Ok(())
}

pub(super) fn validate_name_and_endpoint(
    name: &str,
    api_url: &str,
    public_host: &str,
) -> Result<(), anyhow::Error> {
    if name.trim().is_empty() || name.chars().count() > 191 {
        return Err(DisplayError::new("node name must contain 1 to 191 characters").into());
    }
    let url = url::Url::parse(api_url.trim()).map_err(|_| DisplayError::new("invalid API URL"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(DisplayError::new(
            "API URL must be an HTTP(S) origin without credentials, query, or fragment",
        )
        .into());
    }
    if public_host.trim().is_empty()
        || public_host.len() > 253
        || public_host.chars().any(char::is_whitespace)
        || public_host.contains('/')
    {
        return Err(DisplayError::new("invalid public database host").into());
    }
    Ok(())
}
