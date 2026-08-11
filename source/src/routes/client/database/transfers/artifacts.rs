use super::{client, proxy_download, validate_id};
use crate::persistence::DatabaseRecord;
use axum::{Extension, extract::Path};
use serde::{Deserialize, Serialize};
use shared::{
    ApiError, GetState, State,
    models::{server::GetServerActivityLogger, user::GetPermissionManager},
    response::{ApiResponse, ApiResponseResult},
};
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};

#[derive(Serialize, ToSchema)]
struct Response {
    #[schema(value_type = serde_json::Value)]
    result: serde_json::Value,
}

mod list {
    use super::*;

    #[utoipa::path(get, path = "/", responses((status = OK, body = inline(Response))))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
        Extension(database): Extension<DatabaseRecord>,
    ) -> ApiResponseResult {
        permissions.has_server_permission("databases-everywhere.transfers")?;
        let client = client(&state, &database).await?;
        let result = client
            .get::<serde_json::Value>(&format!(
                "/api/instances/{}/artifacts",
                urlencoding::encode(&database.instance_id())
            ))
            .await?;
        ApiResponse::new_serialized(Response { result }).ok()
    }
}

mod delete {
    use super::*;

    #[utoipa::path(delete, path = "/", params(
        (
            "server" = uuid::Uuid,
            description = "The server ID",
            example = "123e4567-e89b-12d3-a456-426614174000",
        ),
        (
            "database" = uuid::Uuid,
            description = "The DatabasesEverywhere database ID",
            example = "123e4567-e89b-12d3-a456-426614174001",
        ),
        (
            "artifact" = String,
            description = "Artifact ID",
            example = "01JDBEVEXAMPLEARTIFACT0000",
        ),
    ), responses(
        (status = OK, body = inline(Response)),
        (status = BAD_REQUEST, body = ApiError),
    ))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
        activity_logger: GetServerActivityLogger,
        Extension(database): Extension<DatabaseRecord>,
        Path((_server, _database, artifact)): Path<(String, uuid::Uuid, String)>,
    ) -> ApiResponseResult {
        permissions.has_server_permission("databases-everywhere.export")?;
        validate_id("artifact", &artifact)?;
        let client = client(&state, &database).await?;
        let result = client
            .delete::<serde_json::Value>(&format!(
                "/api/instances/{}/artifacts/{}",
                urlencoding::encode(&database.instance_id()),
                urlencoding::encode(&artifact),
            ))
            .await?;
        activity_logger
            .log(
                "server:databases-everywhere.artifact-delete",
                serde_json::json!({ "uuid": database.uuid, "artifact_id": artifact }),
            )
            .await;
        ApiResponse::new_serialized(Response { result }).ok()
    }
}

mod download {
    use super::*;

    #[utoipa::path(get, path = "/download", params(
        (
            "server" = uuid::Uuid,
            description = "The server ID",
            example = "123e4567-e89b-12d3-a456-426614174000",
        ),
        (
            "database" = uuid::Uuid,
            description = "The DatabasesEverywhere database ID",
            example = "123e4567-e89b-12d3-a456-426614174001",
        ),
        (
            "artifact" = String,
            description = "Artifact ID",
            example = "01JDBEVEXAMPLEARTIFACT0000",
        ),
    ), responses(
        (status = OK, content_type = "application/octet-stream"),
        (status = BAD_REQUEST, body = ApiError),
    ))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
        activity_logger: GetServerActivityLogger,
        Extension(database): Extension<DatabaseRecord>,
        Path((_server, _database, artifact)): Path<(String, uuid::Uuid, String)>,
    ) -> ApiResponseResult {
        permissions.has_server_permission("databases-everywhere.download")?;
        let response = proxy_download(&state, &database, "artifacts", &artifact).await?;
        activity_logger
            .log(
                "server:databases-everywhere.artifact-download",
                serde_json::json!({ "uuid": database.uuid, "artifact_id": artifact }),
            )
            .await;
        Ok(response)
    }
}

mod retention {
    use super::*;

    #[derive(Deserialize, Serialize, ToSchema)]
    pub struct Payload {
        keep_latest: Option<u32>,
        max_age_days: Option<u32>,
    }

    #[utoipa::path(post, path = "/retention", request_body = inline(Payload), responses(
        (status = OK, body = inline(Response)),
        (status = BAD_REQUEST, body = ApiError),
    ))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
        activity_logger: GetServerActivityLogger,
        Extension(database): Extension<DatabaseRecord>,
        shared::Payload(data): shared::Payload<Payload>,
    ) -> ApiResponseResult {
        permissions.has_server_permission("databases-everywhere.export")?;
        if data.keep_latest.is_none() && data.max_age_days.is_none() {
            return Err(ApiResponse::error(
                "at least one retention limit is required",
            ));
        }
        let client = client(&state, &database).await?;
        let result = client
            .post::<serde_json::Value, _>(
                &format!(
                    "/api/instances/{}/artifacts/retention",
                    urlencoding::encode(&database.instance_id())
                ),
                &data,
            )
            .await?;
        activity_logger
            .log(
                "server:databases-everywhere.artifact-retention",
                serde_json::json!({
                    "uuid": database.uuid,
                    "keep_latest": data.keep_latest,
                    "max_age_days": data.max_age_days,
                }),
            )
            .await;
        ApiResponse::new_serialized(Response { result }).ok()
    }
}

pub fn router(state: &State) -> OpenApiRouter<State> {
    OpenApiRouter::new()
        .routes(routes!(list::route))
        .routes(routes!(retention::route))
        .nest(
            "/{artifact}",
            OpenApiRouter::new()
                .routes(routes!(delete::route))
                .routes(routes!(download::route))
                .with_state(state.clone()),
        )
        .with_state(state.clone())
}
