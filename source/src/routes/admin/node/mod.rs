use crate::persistence::NodeRecord;
use axum::{
    extract::{Path, Request},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
};
use shared::{GetState, State, models::user::GetPermissionManager, response::ApiResponse};
use std::collections::HashMap;
use utoipa_axum::router::OpenApiRouter;

mod images;
mod lifecycle;
mod operations;

async fn auth(
    state: GetState,
    permissions: GetPermissionManager,
    Path(path): Path<HashMap<String, String>>,
    mut request: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    if let Err(error) = permissions.has_admin_permission("databases-everywhere-nodes.read") {
        return Ok(error.into_response());
    }
    let uuid = match path.get("dbev_node").and_then(|value| value.parse().ok()) {
        Some(uuid) => uuid,
        None => {
            return Ok(ApiResponse::error("invalid DatabasesEverywhere node UUID")
                .with_status(StatusCode::BAD_REQUEST)
                .into_response());
        }
    };
    let node = match NodeRecord::by_uuid(&state, uuid).await {
        Ok(Some(node)) => node,
        Ok(None) => {
            return Ok(ApiResponse::error("DatabasesEverywhere node not found")
                .with_status(StatusCode::NOT_FOUND)
                .into_response());
        }
        Err(error) => return Ok(ApiResponse::from(error).into_response()),
    };
    request.extensions_mut().insert(node);
    Ok(next.run(request).await)
}

pub fn router(state: &State) -> OpenApiRouter<State> {
    OpenApiRouter::new()
        .merge(lifecycle::router(state))
        .nest("/images", images::router(state))
        .merge(operations::router(state))
        .route_layer(axum::middleware::from_fn_with_state(state.clone(), auth))
        .with_state(state.clone())
}
