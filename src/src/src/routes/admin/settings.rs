use crate::settings::{
    ExtensionSettingsData, MAX_NODE_HEALTH_INTERVAL_SECONDS, MIN_NODE_HEALTH_INTERVAL_SECONDS,
};
use serde::{Deserialize, Serialize};
use shared::{
    ApiError, GetState, State,
    models::{admin_activity::GetAdminActivityLogger, user::GetPermissionManager},
    response::{ApiResponse, ApiResponseResult, DisplayError},
};
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};

const EXTENSION_NAME: &str = "com.tomaxikz.databaseseverywhere";

#[derive(Serialize, ToSchema)]
struct Response {
    settings: ExtensionSettingsData,
}

#[utoipa::path(get, path = "/", responses(
    (status = OK, body = inline(Response)),
    (status = FORBIDDEN, body = ApiError),
))]
async fn get(state: GetState, permissions: GetPermissionManager) -> ApiResponseResult {
    permissions.has_admin_permission("extensions.read")?;
    let settings = state.settings.get().await?;
    let extension = settings
        .get_extension_settings::<ExtensionSettingsData>(EXTENSION_NAME)?
        .clone();
    ApiResponse::new_serialized(Response {
        settings: extension,
    })
    .ok()
}

#[derive(Deserialize, ToSchema)]
struct UpdatePayload {
    enabled: Option<bool>,
    panel_url: Option<String>,
    raw_console_enabled: Option<bool>,
    query_timeout_seconds: Option<u64>,
    max_console_rows: Option<u32>,
    node_health_interval_seconds: Option<u64>,
}

#[utoipa::path(put, path = "/", request_body = inline(UpdatePayload), responses(
    (status = OK, body = inline(Response)),
    (status = BAD_REQUEST, body = ApiError),
    (status = FORBIDDEN, body = ApiError),
))]
async fn put(
    state: GetState,
    permissions: GetPermissionManager,
    activity_logger: GetAdminActivityLogger,
    shared::Payload(data): shared::Payload<UpdatePayload>,
) -> ApiResponseResult {
    permissions.has_admin_permission("extensions.manage")?;
    validate_payload(&data)?;

    let mut app_settings = state.settings.get_mut().await?;
    let updated = {
        let settings =
            app_settings.get_mut_extension_settings::<ExtensionSettingsData>(EXTENSION_NAME)?;
        if let Some(enabled) = data.enabled {
            settings.enabled = enabled;
        }
        if let Some(panel_url) = data.panel_url {
            settings.panel_url = panel_url.trim().trim_end_matches('/').to_owned();
        }
        if let Some(enabled) = data.raw_console_enabled {
            settings.raw_console_enabled = enabled;
        }
        if let Some(seconds) = data.query_timeout_seconds {
            settings.query_timeout_seconds = seconds;
        }
        if let Some(rows) = data.max_console_rows {
            settings.max_console_rows = rows;
        }
        if let Some(seconds) = data.node_health_interval_seconds {
            settings.node_health_interval_seconds = seconds;
        }
        settings.clone()
    };
    app_settings.save().await?;

    activity_logger
        .log(
            "databases-everywhere:settings-update",
            serde_json::json!({
                "enabled": updated.enabled,
                "panel_url": updated.panel_url,
                "raw_console_enabled": updated.raw_console_enabled,
                "query_timeout_seconds": updated.query_timeout_seconds,
                "max_console_rows": updated.max_console_rows,
                "node_health_interval_seconds": updated.node_health_interval_seconds,
            }),
        )
        .await;

    ApiResponse::new_serialized(Response { settings: updated }).ok()
}

fn validate_payload(data: &UpdatePayload) -> Result<(), anyhow::Error> {
    if let Some(panel_url) = data.panel_url.as_deref() {
        let panel_url = panel_url.trim();
        if !panel_url.is_empty() {
            let url = url::Url::parse(panel_url)
                .map_err(|_| DisplayError::new("panel URL must be a valid HTTP(S) origin"))?;
            if !matches!(url.scheme(), "http" | "https")
                || url.host().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || !matches!(url.path(), "" | "/")
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err(DisplayError::new(
                    "panel URL must be an HTTP(S) origin without credentials, path, query, or fragment",
                )
                .into());
            }
        }
    }
    if let Some(seconds) = data.query_timeout_seconds
        && !(1..=300).contains(&seconds)
    {
        return Err(DisplayError::new("query timeout must be between 1 and 300 seconds").into());
    }
    if let Some(rows) = data.max_console_rows
        && !(1..=5000).contains(&rows)
    {
        return Err(DisplayError::new("maximum console rows must be between 1 and 5000").into());
    }
    if let Some(seconds) = data.node_health_interval_seconds
        && !(MIN_NODE_HEALTH_INTERVAL_SECONDS..=MAX_NODE_HEALTH_INTERVAL_SECONDS).contains(&seconds)
    {
        return Err(
            DisplayError::new("node health interval must be between 60 and 3600 seconds").into(),
        );
    }
    Ok(())
}

pub fn router(state: &State) -> OpenApiRouter<State> {
    OpenApiRouter::new()
        .routes(routes!(get))
        .routes(routes!(put))
        .with_state(state.clone())
}
