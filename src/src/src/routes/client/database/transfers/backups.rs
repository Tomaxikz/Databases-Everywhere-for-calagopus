use super::{client, mutation_client, proxy_download, validate_id};
use crate::{
    domain::ServerDatabaseConfigurationExtension,
    persistence::DatabaseRecord,
    services::{count_backup_records, database_backup_usage},
};
use axum::{
    Extension,
    extract::{Path, Query},
};
use serde::{Deserialize, Serialize};
use shared::{
    ApiError, GetState, State,
    models::{
        BaseModel,
        server::{GetServer, GetServerActivityLogger},
        user::GetPermissionManager,
    },
    response::{ApiResponse, ApiResponseResult},
};
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};

#[derive(Serialize, ToSchema)]
struct Response {
    #[schema(value_type = serde_json::Value)]
    result: serde_json::Value,
}

#[derive(Serialize, ToSchema)]
struct ListResponse {
    #[schema(value_type = serde_json::Value)]
    result: serde_json::Value,
    /// Backups currently held by this database instance.
    backup_usage: i64,
    /// Maximum backups allowed for each database on this server.
    backup_limit: i32,
}

mod list {
    use super::*;

    #[utoipa::path(get, path = "/", responses((status = OK, body = inline(ListResponse))))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
        server: GetServer,
        Extension(database): Extension<DatabaseRecord>,
    ) -> ApiResponseResult {
        permissions.has_server_permission("databases-everywhere.backups")?;
        let client = client(&state, &database).await?;
        let result = client
            .get::<serde_json::Value>(&format!(
                "/api/instances/{}/backups",
                urlencoding::encode(&database.instance_id())
            ))
            .await?;
        let configuration =
            server.parse_model_extension::<ServerDatabaseConfigurationExtension>()?;
        let backup_usage = count_backup_records(&result)?;
        ApiResponse::new_serialized(ListResponse {
            result,
            backup_usage,
            backup_limit: configuration.backup_limit,
        })
        .ok()
    }
}

mod create {
    use super::*;

    #[utoipa::path(post, path = "/", responses(
        (status = OK, body = inline(Response)),
        (status = BAD_GATEWAY, body = ApiError),
        (status = EXPECTATION_FAILED, body = ApiError),
    ))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
        server: GetServer,
        activity_logger: GetServerActivityLogger,
        Extension(database): Extension<DatabaseRecord>,
    ) -> ApiResponseResult {
        permissions.has_server_permission("databases-everywhere.backup-create")?;
        let configuration =
            server.parse_model_extension::<ServerDatabaseConfigurationExtension>()?;
        if configuration.backup_limit <= 0 {
            return ApiResponse::error("DatabasesEverywhere backups are disabled for this server")
                .with_status(axum::http::StatusCode::EXPECTATION_FAILED)
                .ok();
        }
        let backups_lock = state
            .cache
            .lock(
                format!(
                    "servers::{}::databases-everywhere-backups::{}",
                    server.uuid, database.uuid
                ),
                Some(30),
                Some(5),
            )
            .await?;
        let backup_usage = database_backup_usage(&state, &database).await?;
        if backup_usage >= i64::from(configuration.backup_limit) {
            return ApiResponse::error("maximum number of backups for this database reached")
                .with_status(axum::http::StatusCode::EXPECTATION_FAILED)
                .ok();
        }
        let client = mutation_client(&state, &database).await?;
        let result = client
            .post::<serde_json::Value, _>(
                &format!(
                    "/api/instances/{}/backups",
                    urlencoding::encode(&database.instance_id())
                ),
                &serde_json::json!({}),
            )
            .await?;
        drop(backups_lock);
        activity_logger
            .log(
                "server:databases-everywhere.backup-create",
                serde_json::json!({
                    "uuid": database.uuid,
                    "backup_id": result.get("id"),
                }),
            )
            .await;
        ApiResponse::new_serialized(Response { result }).ok()
    }
}

mod contents {
    use super::*;

    #[derive(Deserialize, ToSchema)]
    pub struct Params {
        object: Option<String>,
        offset: Option<u32>,
        limit: Option<u16>,
    }

    #[utoipa::path(get, path = "/contents", params(
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
            "backup" = String,
            description = "Backup ID",
            example = "01JDBEVEXAMPLEBACKUP00000",
        ),
        ("object" = Option<String>, Query),
        ("offset" = Option<u32>, Query),
        ("limit" = Option<u16>, Query),
    ), responses(
        (status = OK, body = inline(Response)),
        (status = NOT_FOUND, body = ApiError),
    ))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
        Extension(database): Extension<DatabaseRecord>,
        Path((_server, _database, backup)): Path<(String, uuid::Uuid, String)>,
        Query(params): Query<Params>,
    ) -> ApiResponseResult {
        permissions.has_server_permission("databases-everywhere.backups")?;
        validate_id("backup", &backup)?;
        let mut query = vec![
            format!("offset={}", params.offset.unwrap_or(0)),
            format!("limit={}", params.limit.unwrap_or(25).clamp(1, 100)),
        ];
        if let Some(object) = params.object {
            query.push(format!("object={}", urlencoding::encode(&object)));
        }
        let client = client(&state, &database).await?;
        let result = client
            .get::<serde_json::Value>(&format!(
                "/api/instances/{}/backups/{}/contents?{}",
                urlencoding::encode(&database.instance_id()),
                urlencoding::encode(&backup),
                query.join("&"),
            ))
            .await?;
        ApiResponse::new_serialized(Response { result }).ok()
    }
}

mod restore {
    use super::*;

    #[derive(Deserialize, ToSchema)]
    pub struct Payload {
        reason: String,
    }

    #[utoipa::path(post, path = "/restore", params(
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
            "backup" = String,
            description = "Backup ID",
            example = "01JDBEVEXAMPLEBACKUP00000",
        ),
    ), request_body = inline(Payload), responses(
        (status = OK, body = inline(Response)),
        (status = BAD_REQUEST, body = ApiError),
    ))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
        activity_logger: GetServerActivityLogger,
        Extension(database): Extension<DatabaseRecord>,
        Path((_server, _database, backup)): Path<(String, uuid::Uuid, String)>,
        shared::Payload(data): shared::Payload<Payload>,
    ) -> ApiResponseResult {
        permissions.has_server_permission("databases-everywhere.backup-restore")?;
        validate_id("backup", &backup)?;
        if data.reason.trim().is_empty() {
            return Err(ApiResponse::error("a restore reason is required"));
        }
        let client = mutation_client(&state, &database).await?;
        let result = client
            .post::<serde_json::Value, _>(
                &format!(
                    "/api/instances/{}/backups/{}/restore",
                    urlencoding::encode(&database.instance_id()),
                    urlencoding::encode(&backup),
                ),
                &serde_json::json!({ "confirm": true, "reason": data.reason }),
            )
            .await?;
        activity_logger
            .log(
                "server:databases-everywhere.backup-restore",
                serde_json::json!({
                    "uuid": database.uuid,
                    "backup_id": backup,
                    "reason": data.reason,
                }),
            )
            .await;
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
            "backup" = String,
            description = "Backup ID",
            example = "01JDBEVEXAMPLEBACKUP00000",
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
        Path((_server, _database, backup)): Path<(String, uuid::Uuid, String)>,
    ) -> ApiResponseResult {
        permissions.has_server_permission("databases-everywhere.backup-delete")?;
        validate_id("backup", &backup)?;
        let client = mutation_client(&state, &database).await?;
        let result = client
            .delete::<serde_json::Value>(&format!(
                "/api/instances/{}/backups/{}",
                urlencoding::encode(&database.instance_id()),
                urlencoding::encode(&backup),
            ))
            .await?;
        activity_logger
            .log(
                "server:databases-everywhere.backup-delete",
                serde_json::json!({ "uuid": database.uuid, "backup_id": backup }),
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
            "backup" = String,
            description = "Backup ID",
            example = "01JDBEVEXAMPLEBACKUP00000",
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
        Path((_server, _database, backup)): Path<(String, uuid::Uuid, String)>,
    ) -> ApiResponseResult {
        permissions.has_server_permission("databases-everywhere.download")?;
        let response = proxy_download(&state, &database, "backups", &backup).await?;
        activity_logger
            .log(
                "server:databases-everywhere.backup-download",
                serde_json::json!({ "uuid": database.uuid, "backup_id": backup }),
            )
            .await;
        Ok(response)
    }
}

pub fn router(state: &State) -> OpenApiRouter<State> {
    OpenApiRouter::new()
        .routes(routes!(list::route))
        .routes(routes!(create::route))
        .nest(
            "/{backup}",
            OpenApiRouter::new()
                .routes(routes!(contents::route))
                .routes(routes!(restore::route))
                .routes(routes!(delete::route))
                .routes(routes!(download::route))
                .with_state(state.clone()),
        )
        .with_state(state.clone())
}
