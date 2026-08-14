use crate::{
    persistence::{DatabaseRecord, DatabaseRecordApi},
    services::{
        delete_database, reconcile_database, reset_database_password, set_database_image,
        set_database_power,
    },
};
use axum::Extension;
use serde::{Deserialize, Serialize};
use shared::{
    ApiError, GetState, State,
    models::{server::GetServerActivityLogger, user::GetPermissionManager},
    response::{ApiResponse, ApiResponseResult},
};
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};

mod get {
    use super::*;

    #[derive(Serialize, ToSchema)]
    struct Response {
        database: DatabaseRecordApi,
    }

    #[utoipa::path(get, path = "/", responses(
        (status = OK, body = inline(Response)),
        (status = NOT_FOUND, body = ApiError),
    ))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
        Extension(database): Extension<DatabaseRecord>,
    ) -> ApiResponseResult {
        let include_password = permissions
            .has_server_permission("databases-everywhere.credentials")
            .is_ok();
        ApiResponse::new_serialized(Response {
            database: database.into_api(&state, include_password).await?,
        })
        .ok()
    }
}

mod delete {
    use super::*;

    #[derive(Deserialize, ToSchema)]
    pub struct Payload {
        reason: String,
    }

    #[derive(Serialize, ToSchema)]
    struct Response {
        deferred: bool,
    }

    #[utoipa::path(delete, path = "/", request_body = inline(Payload), responses(
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
        permissions.has_server_permission("databases-everywhere.delete")?;
        let outcome = delete_database(&state, &database, &data.reason).await?;
        activity_logger
            .log(
                "server:databases-everywhere.delete",
                serde_json::json!({
                    "uuid": database.uuid,
                    "protocol": database.protocol,
                    "name": database.display_name,
                    "deferred": outcome.deferred,
                    "reason": data.reason,
                }),
            )
            .await;
        ApiResponse::new_serialized(Response {
            deferred: outcome.deferred,
        })
        .ok()
    }
}

mod power {
    use super::*;

    #[derive(Deserialize, ToSchema)]
    pub struct Payload {
        #[schema(example = "restart")]
        action: String,
    }

    #[derive(Serialize, ToSchema)]
    struct Response {
        #[schema(value_type = Object)]
        result: serde_json::Value,
    }

    #[utoipa::path(post, path = "/", request_body = inline(Payload), responses(
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
        permissions.has_server_permission("databases-everywhere.power")?;
        let result = set_database_power(&state, &database, &data.action).await?;
        activity_logger
            .log(
                "server:databases-everywhere.power",
                serde_json::json!({ "uuid": database.uuid, "action": data.action }),
            )
            .await;
        ApiResponse::new_serialized(Response { result }).ok()
    }
}

mod image {
    use super::*;

    #[derive(Deserialize, ToSchema)]
    pub struct Payload {
        image: String,
        #[schema(min_length = 1, max_length = 4096, write_only)]
        password: Option<String>,
        #[serde(default)]
        major_upgrade: bool,
    }

    #[derive(Serialize, ToSchema)]
    struct Response {
        #[schema(value_type = Object)]
        result: serde_json::Value,
    }

    #[utoipa::path(patch, path = "/", request_body = inline(Payload), responses(
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
        permissions.has_server_permission("databases-everywhere.update")?;
        let result = set_database_image(
            &state,
            &database,
            &data.image,
            data.major_upgrade,
            data.password.as_deref(),
        )
        .await?;
        activity_logger
            .log(
                "server:databases-everywhere.image",
                serde_json::json!({
                    "uuid": database.uuid,
                    "image": data.image,
                    "major_upgrade": data.major_upgrade,
                }),
            )
            .await;
        ApiResponse::new_serialized(Response { result }).ok()
    }
}

mod reconcile {
    use super::*;

    #[derive(Serialize, ToSchema)]
    struct Response {
        #[schema(value_type = Object)]
        result: serde_json::Value,
    }

    #[utoipa::path(post, path = "/", responses(
        (status = OK, body = inline(Response)),
        (status = BAD_GATEWAY, body = ApiError),
    ))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
        activity_logger: GetServerActivityLogger,
        Extension(database): Extension<DatabaseRecord>,
    ) -> ApiResponseResult {
        permissions.has_server_permission("databases-everywhere.update")?;
        let result = reconcile_database(&state, &database).await?;
        activity_logger
            .log(
                "server:databases-everywhere.reconcile",
                serde_json::json!({ "uuid": database.uuid }),
            )
            .await;
        ApiResponse::new_serialized(Response { result }).ok()
    }
}

mod password {
    use super::*;

    #[derive(Deserialize, ToSchema)]
    pub struct Payload {
        #[schema(min_length = 1, max_length = 4096, write_only)]
        password: String,
    }

    #[derive(Serialize, ToSchema)]
    struct Response {
        restarted: bool,
    }

    #[utoipa::path(patch, path = "/", request_body = inline(Payload), responses(
        (status = OK, body = inline(Response)),
        (status = BAD_REQUEST, body = ApiError),
        (status = CONFLICT, body = ApiError),
        (status = BAD_GATEWAY, body = ApiError),
    ))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
        activity_logger: GetServerActivityLogger,
        Extension(database): Extension<DatabaseRecord>,
        shared::Payload(data): shared::Payload<Payload>,
    ) -> ApiResponseResult {
        permissions.has_server_permission("databases-everywhere.update")?;
        permissions.has_server_permission("databases-everywhere.credentials")?;
        let outcome = reset_database_password(&state, &database, &data.password).await?;
        activity_logger
            .log(
                "server:databases-everywhere.password-reset",
                serde_json::json!({
                    "uuid": database.uuid,
                    "protocol": database.protocol,
                    "restarted": outcome.restarted,
                }),
            )
            .await;
        ApiResponse::new_serialized(Response {
            restarted: outcome.restarted,
        })
        .ok()
    }
}

pub fn router(state: &State) -> OpenApiRouter<State> {
    OpenApiRouter::new()
        .routes(routes!(get::route))
        .routes(routes!(delete::route))
        .nest(
            "/power",
            OpenApiRouter::new()
                .routes(routes!(power::route))
                .with_state(state.clone()),
        )
        .nest(
            "/image",
            OpenApiRouter::new()
                .routes(routes!(image::route))
                .with_state(state.clone()),
        )
        .nest(
            "/reconcile",
            OpenApiRouter::new()
                .routes(routes!(reconcile::route))
                .with_state(state.clone()),
        )
        .nest(
            "/password",
            OpenApiRouter::new()
                .routes(routes!(password::route))
                .with_state(state.clone()),
        )
        .with_state(state.clone())
}
