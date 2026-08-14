use crate::{
    persistence::DatabaseRecord,
    services::data::{
        self, BatchDataMutationInput, DataMutationInput, ExplorerOverview, QueryOutput,
        SchemaMutationInput,
    },
};
use axum::{Extension, extract::Query};
use serde::{Deserialize, Serialize};
use shared::{
    ApiError, GetState, State,
    models::{server::GetServerActivityLogger, user::GetPermissionManager},
    response::{ApiResponse, ApiResponseResult},
};
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};

#[derive(Serialize, ToSchema)]
struct OverviewResponse {
    explorer: ExplorerOverview,
}

#[utoipa::path(get, path = "/", responses(
    (status = OK, body = inline(OverviewResponse)),
    (status = CONFLICT, body = ApiError),
))]
async fn get(
    state: GetState,
    permissions: GetPermissionManager,
    Extension(database): Extension<DatabaseRecord>,
) -> ApiResponseResult {
    permissions.has_server_permission("databases-everywhere.data")?;
    ApiResponse::new_serialized(OverviewResponse {
        explorer: data::overview(&state, &database).await?,
    })
    .ok()
}

mod browse {
    use super::*;

    #[derive(Deserialize, ToSchema)]
    pub struct Params {
        namespace: Option<String>,
        object: String,
        offset: Option<u64>,
        limit: Option<u32>,
    }

    #[derive(Serialize, ToSchema)]
    struct Response {
        output: QueryOutput,
    }

    #[utoipa::path(get, path = "/browse", params(
        ("namespace" = Option<String>, Query),
        ("object" = String, Query),
        ("offset" = Option<u64>, Query),
        ("limit" = Option<u32>, Query),
    ), responses(
        (status = OK, body = inline(Response)),
        (status = BAD_REQUEST, body = ApiError),
    ))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
        Extension(database): Extension<DatabaseRecord>,
        Query(params): Query<Params>,
    ) -> ApiResponseResult {
        permissions.has_server_permission("databases-everywhere.data")?;
        let output = data::browse(
            &state,
            &database,
            params.namespace.as_deref(),
            &params.object,
            params.offset.unwrap_or(0),
            params.limit.unwrap_or(100),
        )
        .await?;
        ApiResponse::new_serialized(Response { output }).ok()
    }
}

mod describe {
    use super::*;

    #[derive(Deserialize, ToSchema)]
    pub struct Params {
        namespace: Option<String>,
        object: String,
    }

    #[derive(Serialize, ToSchema)]
    struct Response {
        columns: Vec<data::DataColumn>,
    }

    #[utoipa::path(get, path = "/describe", params(
        ("namespace" = Option<String>, Query),
        ("object" = String, Query),
    ), responses(
        (status = OK, body = inline(Response)),
        (status = BAD_REQUEST, body = ApiError),
        (status = CONFLICT, body = ApiError),
    ))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
        Extension(database): Extension<DatabaseRecord>,
        Query(params): Query<Params>,
    ) -> ApiResponseResult {
        permissions.has_server_permission("databases-everywhere.data")?;
        ApiResponse::new_serialized(Response {
            columns: data::describe(
                &state,
                &database,
                params.namespace.as_deref(),
                &params.object,
            )
            .await?,
        })
        .ok()
    }
}

mod console {
    use super::*;

    #[derive(Deserialize, ToSchema)]
    pub struct Payload {
        command: String,
    }

    #[derive(Serialize, ToSchema)]
    struct Response {
        output: QueryOutput,
    }

    #[utoipa::path(post, path = "/console", request_body = inline(Payload), responses(
        (status = OK, body = inline(Response)),
        (status = BAD_REQUEST, body = ApiError),
        (status = CONFLICT, body = ApiError),
    ))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
        activity_logger: GetServerActivityLogger,
        Extension(database): Extension<DatabaseRecord>,
        shared::Payload(data): shared::Payload<Payload>,
    ) -> ApiResponseResult {
        permissions.has_server_permission("databases-everywhere.console")?;
        let output = data::execute(&state, &database, &data.command).await?;
        activity_logger
            .log(
                "server:databases-everywhere.console",
                serde_json::json!({
                    "uuid": database.uuid,
                    "protocol": database.protocol,
                    "elapsed_ms": output.elapsed_ms,
                    "affected_rows": output.affected_rows,
                }),
            )
            .await;
        ApiResponse::new_serialized(Response { output }).ok()
    }
}

mod mutate {
    use super::*;

    #[derive(Serialize, ToSchema)]
    struct Response {
        output: QueryOutput,
    }

    #[utoipa::path(post, path = "/mutate", request_body = DataMutationInput, responses(
        (status = OK, body = inline(Response)),
        (status = BAD_REQUEST, body = ApiError),
        (status = CONFLICT, body = ApiError),
    ))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
        activity_logger: GetServerActivityLogger,
        Extension(database): Extension<DatabaseRecord>,
        shared::Payload(input): shared::Payload<DataMutationInput>,
    ) -> ApiResponseResult {
        permissions.has_server_permission("databases-everywhere.data-write")?;
        let output = data::mutate(&state, &database, &input).await?;
        activity_logger
            .log(
                "server:databases-everywhere.data-mutate",
                serde_json::json!({
                    "uuid": database.uuid,
                    "protocol": database.protocol,
                    "operation": input.operation,
                    "namespace": input.namespace,
                    "object": input.object,
                    "affected_rows": output.affected_rows,
                }),
            )
            .await;
        ApiResponse::new_serialized(Response { output }).ok()
    }
}

mod mutate_batch {
    use super::*;

    #[derive(Serialize, ToSchema)]
    struct Response {
        output: QueryOutput,
    }

    #[utoipa::path(post, path = "/mutate/batch", request_body = BatchDataMutationInput, responses(
        (status = OK, body = inline(Response)),
        (status = BAD_REQUEST, body = ApiError),
        (status = CONFLICT, body = ApiError),
    ))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
        activity_logger: GetServerActivityLogger,
        Extension(database): Extension<DatabaseRecord>,
        shared::Payload(input): shared::Payload<BatchDataMutationInput>,
    ) -> ApiResponseResult {
        permissions.has_server_permission("databases-everywhere.data-write")?;
        let requested = input.originals.len();
        let output = data::mutate_batch(&state, &database, &input).await?;
        activity_logger
            .log(
                "server:databases-everywhere.data-mutate-batch",
                serde_json::json!({
                    "uuid": database.uuid,
                    "protocol": database.protocol,
                    "operation": input.operation,
                    "namespace": input.namespace,
                    "object": input.object,
                    "requested_rows": requested,
                    "affected_rows": output.affected_rows,
                }),
            )
            .await;
        ApiResponse::new_serialized(Response { output }).ok()
    }
}

mod schema {
    use super::*;

    #[derive(Serialize, ToSchema)]
    struct Response {
        changed: bool,
    }

    #[utoipa::path(post, path = "/schema", request_body = SchemaMutationInput, responses(
        (status = OK, body = inline(Response)),
        (status = BAD_REQUEST, body = ApiError),
        (status = CONFLICT, body = ApiError),
    ))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
        activity_logger: GetServerActivityLogger,
        Extension(database): Extension<DatabaseRecord>,
        shared::Payload(input): shared::Payload<SchemaMutationInput>,
    ) -> ApiResponseResult {
        permissions.has_server_permission("databases-everywhere.data-write")?;
        data::mutate_schema(&state, &database, &input).await?;
        activity_logger
            .log(
                "server:databases-everywhere.schema-mutate",
                serde_json::json!({
                    "uuid": database.uuid,
                    "protocol": database.protocol,
                    "operation": input.operation,
                    "namespace": input.namespace,
                    "object": input.object,
                }),
            )
            .await;
        ApiResponse::new_serialized(Response { changed: true }).ok()
    }
}

pub fn router(state: &State) -> OpenApiRouter<State> {
    OpenApiRouter::new()
        .routes(routes!(get))
        .routes(routes!(browse::route))
        .routes(routes!(describe::route))
        .routes(routes!(console::route))
        .routes(routes!(mutate_batch::route))
        .routes(routes!(mutate::route))
        .routes(routes!(schema::route))
        .with_state(state.clone())
}
