use crate::{
    dbev::DbevClient,
    persistence::{DatabaseRecord, NodeRecord},
};
use axum::{Extension, extract::Query};
use serde::{Deserialize, Serialize};
use shared::{
    ApiError, GetState, State,
    models::{
        server::GetServer,
        user::{GetPermissionManager, GetUser},
    },
    response::{ApiResponse, ApiResponseResult, DisplayError},
};
use std::collections::HashSet;
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};

#[derive(Serialize, ToSchema)]
struct Response {
    #[schema(value_type = serde_json::Value)]
    result: serde_json::Value,
}

#[derive(Debug, Clone, Copy, Deserialize, ToSchema)]
#[serde(rename_all = "kebab-case")]
enum WebSocketChannel {
    Monitor,
    Logs,
    ImportExport,
}

#[derive(Debug, Deserialize, ToSchema)]
struct WebSocketTokenPayload {
    channel: WebSocketChannel,
    /// Optional, server-validated monitor scope used by the native database list.
    instances: Option<Vec<uuid::Uuid>>,
}

#[derive(Debug, Deserialize)]
struct MintedWebSocketToken {
    #[serde(default = "default_token_type")]
    token_type: String,
    #[serde(alias = "jwt")]
    token: String,
    expires_at_unix: i64,
}

#[derive(Serialize, ToSchema)]
struct WebSocketTokenResponse {
    token_type: String,
    token: String,
    expires_at_unix: i64,
    url: String,
    instance_id: String,
    scopes: Vec<&'static str>,
}

fn default_token_type() -> String {
    "Bearer".to_owned()
}

mod websocket_token {
    use super::*;

    #[derive(Serialize)]
    struct MintPayload<'a> {
        subject: String,
        scopes: &'a [&'static str],
        instances: &'a [String],
        ttl_seconds: u16,
    }

    #[utoipa::path(post, path = "/ws-token", request_body = WebSocketTokenPayload, responses(
        (status = OK, body = inline(WebSocketTokenResponse)),
        (status = FORBIDDEN, body = ApiError),
        (status = BAD_REQUEST, body = ApiError),
        (status = NOT_FOUND, body = ApiError),
        (status = BAD_GATEWAY, body = ApiError),
    ))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
        user: GetUser,
        server: GetServer,
        Extension(database): Extension<DatabaseRecord>,
        shared::Payload(payload): shared::Payload<WebSocketTokenPayload>,
    ) -> ApiResponseResult {
        let (scopes, path): (&[&'static str], String) = match payload.channel {
            WebSocketChannel::Monitor => (&["monitor:read"], "/ws/monitoring".to_owned()),
            WebSocketChannel::Logs => {
                permissions.has_server_permission("databases-everywhere.logs")?;
                (
                    &["logs:read"],
                    format!("/ws/instances/{}/logs", database.instance_id()),
                )
            }
            WebSocketChannel::ImportExport => {
                permissions.has_server_permission("databases-everywhere.transfers")?;
                (
                    &["import-export:read"],
                    format!("/ws/instances/{}/import-export", database.instance_id()),
                )
            }
        };

        let instance_ids = monitor_instances(&state, &server, &database, &payload).await?;
        let (node, client) = node_client(&state, &database).await?;
        // Refresh capabilities whenever a new browser token is minted.
        let system = client.get::<serde_json::Value>("/api/system").await?;
        node.store_health(&state, Some(&system), None, None).await?;
        let instance_id = database.instance_id();
        let token = client
            .post::<MintedWebSocketToken, _>(
                "/api/ws-token",
                &MintPayload {
                    subject: format!("panel-user-{}", user.uuid),
                    scopes,
                    instances: &instance_ids,
                    ttl_seconds: 120,
                },
            )
            .await?;

        ApiResponse::new_serialized(WebSocketTokenResponse {
            token_type: token.token_type,
            token: token.token,
            expires_at_unix: token.expires_at_unix,
            url: client.websocket_url(&path)?,
            instance_id,
            scopes: scopes.to_vec(),
        })
        .ok()
    }

    async fn monitor_instances(
        state: &State,
        server: &shared::models::server::Server,
        database: &DatabaseRecord,
        payload: &WebSocketTokenPayload,
    ) -> Result<Vec<String>, anyhow::Error> {
        if !matches!(payload.channel, WebSocketChannel::Monitor) {
            if payload.instances.is_some() {
                return Err(DisplayError::new(
                    "custom instance scopes are only supported for monitoring sockets",
                )
                .with_status(axum::http::StatusCode::BAD_REQUEST)
                .into());
            }
            return Ok(vec![database.instance_id()]);
        }

        let requested = payload
            .instances
            .clone()
            .unwrap_or_else(|| vec![database.uuid]);
        if requested.is_empty() || requested.len() > 128 {
            return Err(DisplayError::new(
                "monitoring WebSocket scopes must contain between 1 and 128 databases",
            )
            .with_status(axum::http::StatusCode::BAD_REQUEST)
            .into());
        }

        let mut seen = HashSet::with_capacity(requested.len());
        let mut instance_ids = Vec::with_capacity(requested.len());
        for uuid in requested {
            if !seen.insert(uuid) {
                continue;
            }
            let scoped = DatabaseRecord::by_server_uuid(state, server.uuid, uuid)
                .await?
                .ok_or_else(|| {
                    DisplayError::new("a requested monitoring database was not found")
                        .with_status(axum::http::StatusCode::NOT_FOUND)
                })?;
            if scoped.dbev_node_uuid != database.dbev_node_uuid {
                return Err(DisplayError::new(
                    "all databases in a monitoring WebSocket scope must use the same DBE node",
                )
                .with_status(axum::http::StatusCode::BAD_REQUEST)
                .into());
            }
            instance_ids.push(scoped.instance_id());
        }

        Ok(instance_ids)
    }
}

mod status {
    use super::*;

    #[utoipa::path(get, path = "/", responses(
        (status = OK, body = inline(Response)),
        (status = BAD_GATEWAY, body = ApiError),
    ))]
    pub async fn route(
        state: GetState,
        Extension(database): Extension<DatabaseRecord>,
    ) -> ApiResponseResult {
        let client = client(&state, &database).await?;
        let result = client
            .get::<serde_json::Value>(&format!(
                "/api/instances/{}/status",
                urlencoding::encode(&database.instance_id())
            ))
            .await?;
        database.update_remote_state(&state, &result).await?;
        ApiResponse::new_serialized(Response { result }).ok()
    }
}

mod instance {
    use super::*;

    #[utoipa::path(get, path = "/", responses(
        (status = OK, body = inline(Response)),
        (status = BAD_GATEWAY, body = ApiError),
    ))]
    pub async fn route(
        state: GetState,
        Extension(database): Extension<DatabaseRecord>,
    ) -> ApiResponseResult {
        let client = client(&state, &database).await?;
        let result = client
            .get::<serde_json::Value>(&format!(
                "/api/instances/{}",
                urlencoding::encode(&database.instance_id())
            ))
            .await?;
        database.update_remote_state(&state, &result).await?;
        ApiResponse::new_serialized(Response { result }).ok()
    }
}

mod resources {
    use super::*;

    #[utoipa::path(get, path = "/", responses(
        (status = OK, body = inline(Response)),
        (status = BAD_GATEWAY, body = ApiError),
    ))]
    pub async fn route(
        state: GetState,
        Extension(database): Extension<DatabaseRecord>,
    ) -> ApiResponseResult {
        let client = client(&state, &database).await?;
        let result = client
            .get::<serde_json::Value>(&format!(
                "/api/instances/{}/resources",
                urlencoding::encode(&database.instance_id())
            ))
            .await?;
        ApiResponse::new_serialized(Response { result }).ok()
    }
}

mod logs {
    use super::*;

    #[derive(Deserialize, ToSchema)]
    pub struct Params {
        tail: Option<u16>,
    }

    #[utoipa::path(get, path = "/", params(
        ("tail" = Option<u16>, Query, description = "Number of log lines (1-2000)"),
    ), responses(
        (status = OK, body = inline(Response)),
        (status = BAD_GATEWAY, body = ApiError),
    ))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
        Extension(database): Extension<DatabaseRecord>,
        Query(params): Query<Params>,
    ) -> ApiResponseResult {
        permissions.has_server_permission("databases-everywhere.logs")?;
        let client = client(&state, &database).await?;
        let tail = params.tail.unwrap_or(200).clamp(1, 2000);
        let result = client
            .get::<serde_json::Value>(&format!(
                "/api/instances/{}/logs?tail={tail}",
                urlencoding::encode(&database.instance_id())
            ))
            .await?;
        ApiResponse::new_serialized(Response { result }).ok()
    }
}

async fn client(state: &State, database: &DatabaseRecord) -> Result<DbevClient, anyhow::Error> {
    Ok(node_client(state, database).await?.1)
}

async fn node_client(
    state: &State,
    database: &DatabaseRecord,
) -> Result<(NodeRecord, DbevClient), anyhow::Error> {
    let node = NodeRecord::by_uuid(state, database.dbev_node_uuid)
        .await?
        .ok_or_else(|| anyhow::anyhow!("DatabasesEverywhere node no longer exists"))?;
    let client = DbevClient::for_node(state, &node).await?;
    Ok((node, client))
}

pub fn router(state: &State) -> OpenApiRouter<State> {
    OpenApiRouter::new()
        .routes(routes!(websocket_token::route))
        .nest(
            "/status",
            OpenApiRouter::new()
                .routes(routes!(status::route))
                .with_state(state.clone()),
        )
        .nest(
            "/instance",
            OpenApiRouter::new()
                .routes(routes!(instance::route))
                .with_state(state.clone()),
        )
        .nest(
            "/resources",
            OpenApiRouter::new()
                .routes(routes!(resources::route))
                .with_state(state.clone()),
        )
        .nest(
            "/logs",
            OpenApiRouter::new()
                .routes(routes!(logs::route))
                .with_state(state.clone()),
        )
        .with_state(state.clone())
}
