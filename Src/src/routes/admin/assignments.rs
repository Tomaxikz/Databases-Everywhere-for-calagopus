use crate::persistence::{
    AssignedHost, HostAssignment, NodeRecord, NodeRecordApi, PanelNodeHostAvailability,
};
use axum::{extract::Path, http::StatusCode};
use serde::{Deserialize, Serialize};
use shared::{
    ApiError, GetState, State,
    models::{
        ByUuid, admin_activity::GetAdminActivityLogger, location::Location, node::Node,
        user::GetPermissionManager,
    },
    response::{ApiResponse, ApiResponseResult},
};
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};

#[derive(Serialize, ToSchema)]
struct AssignedHostApi {
    host: NodeRecordApi,
    created: chrono::DateTime<chrono::Utc>,
}

impl From<AssignedHost> for AssignedHostApi {
    fn from(value: AssignedHost) -> Self {
        Self {
            host: value.host.into_api(),
            created: value.created,
        }
    }
}

#[derive(Serialize, ToSchema)]
struct ListResponse {
    hosts: Vec<AssignedHostApi>,
}

#[derive(Deserialize, ToSchema)]
struct AssignPayload {
    dbev_node_uuid: uuid::Uuid,
}

#[derive(Serialize, ToSchema)]
struct EmptyResponse {}

async fn require_panel_node(state: &State, uuid: uuid::Uuid) -> Result<Node, anyhow::Error> {
    Node::by_uuid_optional(&state.database, uuid)
        .await?
        .ok_or_else(|| {
            shared::response::DisplayError::new("panel node not found")
                .with_status(StatusCode::NOT_FOUND)
                .into()
        })
}

async fn require_location(state: &State, uuid: uuid::Uuid) -> Result<Location, anyhow::Error> {
    Location::by_uuid_optional(&state.database, uuid)
        .await?
        .ok_or_else(|| {
            shared::response::DisplayError::new("location not found")
                .with_status(StatusCode::NOT_FOUND)
                .into()
        })
}

async fn require_dbev_node(state: &State, uuid: uuid::Uuid) -> Result<NodeRecord, anyhow::Error> {
    NodeRecord::by_uuid(state, uuid).await?.ok_or_else(|| {
        shared::response::DisplayError::new("DatabasesEverywhere host not found")
            .with_status(StatusCode::NOT_FOUND)
            .into()
    })
}

#[utoipa::path(get, path = "/nodes/{panel_node}", responses(
    (status = OK, body = inline(ListResponse)),
    (status = NOT_FOUND, body = ApiError),
))]
async fn get_panel_node(
    state: GetState,
    permissions: GetPermissionManager,
    Path(panel_node): Path<uuid::Uuid>,
) -> ApiResponseResult {
    permissions.has_admin_permission("databases-everywhere-nodes.read")?;
    require_panel_node(&state, panel_node).await?;
    ApiResponse::new_serialized(ListResponse {
        hosts: HostAssignment::for_panel_node(&state, panel_node)
            .await?
            .into_iter()
            .map(Into::into)
            .collect(),
    })
    .ok()
}

#[utoipa::path(post, path = "/nodes/{panel_node}", request_body = inline(AssignPayload), responses(
    (status = OK, body = inline(EmptyResponse)),
    (status = CONFLICT, body = ApiError),
    (status = NOT_FOUND, body = ApiError),
))]
async fn post_panel_node(
    state: GetState,
    permissions: GetPermissionManager,
    activity_logger: GetAdminActivityLogger,
    Path(panel_node): Path<uuid::Uuid>,
    shared::Payload(data): shared::Payload<AssignPayload>,
) -> ApiResponseResult {
    permissions.has_admin_permission("databases-everywhere-nodes.assign")?;
    require_panel_node(&state, panel_node).await?;
    let host = require_dbev_node(&state, data.dbev_node_uuid).await?;
    if !HostAssignment::assign_to_panel_node(&state, panel_node, host.uuid).await? {
        return ApiResponse::error("DatabasesEverywhere host is already assigned to this node")
            .with_status(StatusCode::CONFLICT)
            .ok();
    }
    activity_logger
        .log(
            "node:databases-everywhere-host.create",
            serde_json::json!({ "node_uuid": panel_node, "dbev_node_uuid": host.uuid }),
        )
        .await;
    ApiResponse::new_serialized(EmptyResponse {}).ok()
}

#[utoipa::path(delete, path = "/nodes/{panel_node}/{dbev_node}", responses(
    (status = OK, body = inline(EmptyResponse)),
    (status = NOT_FOUND, body = ApiError),
))]
async fn delete_panel_node(
    state: GetState,
    permissions: GetPermissionManager,
    activity_logger: GetAdminActivityLogger,
    Path((panel_node, dbev_node)): Path<(uuid::Uuid, uuid::Uuid)>,
) -> ApiResponseResult {
    permissions.has_admin_permission("databases-everywhere-nodes.assign")?;
    require_panel_node(&state, panel_node).await?;
    if !HostAssignment::remove_from_panel_node(&state, panel_node, dbev_node).await? {
        return ApiResponse::error("DatabasesEverywhere host assignment not found")
            .with_status(StatusCode::NOT_FOUND)
            .ok();
    }
    activity_logger
        .log(
            "node:databases-everywhere-host.delete",
            serde_json::json!({ "node_uuid": panel_node, "dbev_node_uuid": dbev_node }),
        )
        .await;
    ApiResponse::new_serialized(EmptyResponse {}).ok()
}

#[utoipa::path(get, path = "/locations/{location}", responses(
    (status = OK, body = inline(ListResponse)),
    (status = NOT_FOUND, body = ApiError),
))]
async fn get_location(
    state: GetState,
    permissions: GetPermissionManager,
    Path(location): Path<uuid::Uuid>,
) -> ApiResponseResult {
    permissions.has_admin_permission("databases-everywhere-nodes.read")?;
    require_location(&state, location).await?;
    ApiResponse::new_serialized(ListResponse {
        hosts: HostAssignment::for_location(&state, location)
            .await?
            .into_iter()
            .map(Into::into)
            .collect(),
    })
    .ok()
}

#[utoipa::path(post, path = "/locations/{location}", request_body = inline(AssignPayload), responses(
    (status = OK, body = inline(EmptyResponse)),
    (status = CONFLICT, body = ApiError),
    (status = NOT_FOUND, body = ApiError),
))]
async fn post_location(
    state: GetState,
    permissions: GetPermissionManager,
    activity_logger: GetAdminActivityLogger,
    Path(location): Path<uuid::Uuid>,
    shared::Payload(data): shared::Payload<AssignPayload>,
) -> ApiResponseResult {
    permissions.has_admin_permission("databases-everywhere-nodes.assign")?;
    require_location(&state, location).await?;
    let host = require_dbev_node(&state, data.dbev_node_uuid).await?;
    if !HostAssignment::assign_to_location(&state, location, host.uuid).await? {
        return ApiResponse::error("DatabasesEverywhere host is already assigned to this location")
            .with_status(StatusCode::CONFLICT)
            .ok();
    }
    activity_logger
        .log(
            "location:databases-everywhere-host.create",
            serde_json::json!({ "location_uuid": location, "dbev_node_uuid": host.uuid }),
        )
        .await;
    ApiResponse::new_serialized(EmptyResponse {}).ok()
}

#[utoipa::path(delete, path = "/locations/{location}/{dbev_node}", responses(
    (status = OK, body = inline(EmptyResponse)),
    (status = NOT_FOUND, body = ApiError),
))]
async fn delete_location(
    state: GetState,
    permissions: GetPermissionManager,
    activity_logger: GetAdminActivityLogger,
    Path((location, dbev_node)): Path<(uuid::Uuid, uuid::Uuid)>,
) -> ApiResponseResult {
    permissions.has_admin_permission("databases-everywhere-nodes.assign")?;
    require_location(&state, location).await?;
    if !HostAssignment::remove_from_location(&state, location, dbev_node).await? {
        return ApiResponse::error("DatabasesEverywhere host assignment not found")
            .with_status(StatusCode::NOT_FOUND)
            .ok();
    }
    activity_logger
        .log(
            "location:databases-everywhere-host.delete",
            serde_json::json!({ "location_uuid": location, "dbev_node_uuid": dbev_node }),
        )
        .await;
    ApiResponse::new_serialized(EmptyResponse {}).ok()
}

#[derive(Serialize, ToSchema)]
struct AvailabilityResponse {
    #[serde(flatten)]
    availability: PanelNodeHostAvailability,
}

#[utoipa::path(get, path = "/eligibility/nodes/{panel_node}", responses(
    (status = OK, body = inline(AvailabilityResponse)),
    (status = NOT_FOUND, body = ApiError),
))]
async fn get_panel_node_eligibility(
    state: GetState,
    permissions: GetPermissionManager,
    Path(panel_node): Path<uuid::Uuid>,
) -> ApiResponseResult {
    permissions.has_admin_permission("servers.create")?;
    let panel_node_model = require_panel_node(&state, panel_node).await?;
    ApiResponse::new_serialized(AvailabilityResponse {
        availability: HostAssignment::availability(
            &state,
            panel_node_model.uuid,
            panel_node_model.location.uuid,
        )
        .await?,
    })
    .ok()
}

pub fn router(state: &State) -> OpenApiRouter<State> {
    OpenApiRouter::new()
        .routes(routes!(get_panel_node))
        .routes(routes!(post_panel_node))
        .routes(routes!(delete_panel_node))
        .routes(routes!(get_location))
        .routes(routes!(post_location))
        .routes(routes!(delete_location))
        .routes(routes!(get_panel_node_eligibility))
        .with_state(state.clone())
}
