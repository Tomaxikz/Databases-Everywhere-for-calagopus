use crate::{
    domain::DatabaseProtocol,
    persistence::{NodeRecord, NodeRecordApi},
};
use axum::{Extension, extract::Path};
use serde::{Deserialize, Serialize};
use shared::{
    ApiError, GetState, State,
    models::{admin_activity::GetAdminActivityLogger, user::GetPermissionManager},
    response::{ApiResponse, ApiResponseResult, DisplayError},
};
use std::str::FromStr;
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};

#[derive(Debug, Deserialize, ToSchema)]
struct Payload {
    default_image: String,
    allowed_images: Vec<String>,
}

#[derive(Serialize, ToSchema)]
struct Response {
    node: NodeRecordApi,
}

#[utoipa::path(patch, path = "/{protocol}", params(
    ("protocol" = String, Path),
), request_body = inline(Payload), responses(
    (status = OK, body = inline(Response)),
    (status = BAD_REQUEST, body = ApiError),
))]
async fn patch(
    state: GetState,
    permissions: GetPermissionManager,
    activity_logger: GetAdminActivityLogger,
    Extension(node): Extension<NodeRecord>,
    Path(protocol): Path<String>,
    shared::Payload(data): shared::Payload<Payload>,
) -> ApiResponseResult {
    permissions.has_admin_permission("databases-everywhere-nodes.update")?;
    let protocol = DatabaseProtocol::from_str(&protocol)
        .map_err(|_| DisplayError::new("unsupported database image type"))?;
    let mut configuration = node.configuration.clone();
    let images = configuration
        .get_mut("images")
        .and_then(serde_json::Value::as_object_mut)
        .ok_or_else(|| DisplayError::new("node image configuration is missing"))?;
    images.insert(
        protocol.as_str().to_owned(),
        serde_json::Value::String(data.default_image.clone()),
    );
    let allowed = images
        .get_mut("allowed")
        .and_then(serde_json::Value::as_object_mut)
        .ok_or_else(|| DisplayError::new("node image allow-list configuration is missing"))?;
    allowed.insert(
        protocol.as_str().to_owned(),
        serde_json::to_value(&data.allowed_images)?,
    );
    node.update_configuration(&state, configuration).await?;
    let updated = NodeRecord::by_uuid(&state, node.uuid)
        .await?
        .ok_or_else(|| anyhow::anyhow!("updated DatabasesEverywhere node disappeared"))?;
    activity_logger
        .log(
            "databases-everywhere-node:update-images",
            serde_json::json!({
                "uuid": updated.uuid,
                "protocol": protocol,
                "default_image": data.default_image,
                "allowed_image_count": data.allowed_images.len(),
            }),
        )
        .await;
    ApiResponse::new_serialized(Response {
        node: updated.into_api(),
    })
    .ok()
}

pub fn router(state: &State) -> OpenApiRouter<State> {
    OpenApiRouter::new()
        .routes(routes!(patch))
        .with_state(state.clone())
}
