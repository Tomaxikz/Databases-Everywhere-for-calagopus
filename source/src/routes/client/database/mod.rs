use crate::persistence::DatabaseRecord;
use axum::{
    extract::{Path, Request},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
};
use shared::{
    GetState, State,
    models::{server::GetServer, user::GetPermissionManager},
    response::ApiResponse,
};
use std::collections::HashMap;
use utoipa_axum::router::OpenApiRouter;

mod data;
mod lifecycle;
mod monitoring;
mod transfers;

pub async fn auth(
    state: GetState,
    permissions: GetPermissionManager,
    server: GetServer,
    Path(path): Path<HashMap<String, String>>,
    mut request: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    if let Err(error) = permissions.has_server_permission("databases-everywhere.read") {
        return Ok(error.into_response());
    }
    let database_uuid = match path.get("database").and_then(|value| value.parse().ok()) {
        Some(uuid) => uuid,
        None => {
            return Ok(ApiResponse::error("invalid database UUID")
                .with_status(StatusCode::BAD_REQUEST)
                .into_response());
        }
    };
    let database = match DatabaseRecord::by_server_uuid(&state, server.uuid, database_uuid).await {
        Ok(Some(database)) => database,
        Ok(None) => {
            return Ok(ApiResponse::error("database not found")
                .with_status(StatusCode::NOT_FOUND)
                .into_response());
        }
        Err(error) => return Ok(ApiResponse::from(error).into_response()),
    };
    // Preserve the consumed server model for downstream extractors.
    request.extensions_mut().insert(server.0);
    request.extensions_mut().insert(database);
    Ok(next.run(request).await)
}

pub fn router(state: &State) -> OpenApiRouter<State> {
    OpenApiRouter::new()
        .merge(lifecycle::router(state))
        .nest("/monitoring", monitoring::router(state))
        .nest("/transfers", transfers::router(state))
        .nest("/data", data::router(state))
        .route_layer(axum::middleware::from_fn_with_state(state.clone(), auth))
        .with_state(state.clone())
}
