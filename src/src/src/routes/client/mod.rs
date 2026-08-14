use crate::{
    dbev::mutation_contract_block_reason,
    domain::{DatabaseProtocol, ServerDatabaseConfigurationExtension},
    persistence::{DatabaseRecord, DatabaseRecordApi, HostAssignment},
    services::{
        CreateDatabaseInput, create_database, extension_provisioning_enabled, total_database_usage,
    },
};
use serde::Serialize;
use shared::{
    ApiError, GetState, State,
    models::{
        BaseModel,
        server::{GetServer, GetServerActivityLogger},
        user::GetPermissionManager,
    },
    response::{ApiResponse, ApiResponseResult},
};
use std::collections::{BTreeMap, BTreeSet};
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};

mod database;

#[derive(Serialize, ToSchema)]
struct ListResponse {
    provider_available: bool,
    provisioning_enabled: bool,
    provisioning_block_reason: Option<String>,
    protocols: Vec<DatabaseProtocol>,
    database_limit: i32,
    database_usage: i64,
    database_cpu_cores: Option<f64>,
    database_memory_mib: Option<i64>,
    database_disk_mib: Option<i64>,
    database_backup_limit: i32,
    image_options: BTreeMap<String, Vec<String>>,
    databases: Vec<DatabaseRecordApi>,
}

#[utoipa::path(get, path = "/", responses(
    (status = OK, body = inline(ListResponse)),
    (status = CONFLICT, body = ApiError),
))]
async fn get(
    state: GetState,
    permissions: GetPermissionManager,
    server: GetServer,
) -> ApiResponseResult {
    permissions.has_server_permission("databases-everywhere.read")?;
    let configuration = server.parse_model_extension::<ServerDatabaseConfigurationExtension>()?;
    let extension_enabled = extension_provisioning_enabled(&state).await?;
    let panel_node = server.node.fetch_cached(&state.database).await?;
    let availability =
        HostAssignment::availability(&state, panel_node.uuid, panel_node.location.uuid).await?;
    let mut image_sets = BTreeMap::<String, BTreeSet<String>>::new();
    let mut provisioning_block_reason = None;
    for eligible in
        HostAssignment::eligible_for_panel_node(&state, panel_node.uuid, panel_node.location.uuid)
            .await?
    {
        if let Some(reason) = node_provisioning_block_reason(&eligible.host) {
            provisioning_block_reason.get_or_insert(reason);
            continue;
        }
        for protocol in DatabaseProtocol::ALL {
            if !eligible
                .host
                .cached_system
                .as_ref()
                .is_some_and(|system| protocol.enabled_by_system(system))
            {
                continue;
            }
            image_sets
                .entry(protocol.as_str().to_owned())
                .or_default()
                .extend(eligible.host.allowed_images(protocol));
        }
    }
    let image_options = image_sets
        .into_iter()
        .map(|(protocol, images)| (protocol, images.into_iter().collect()))
        .collect::<BTreeMap<_, _>>();
    let protocols = DatabaseProtocol::ALL
        .into_iter()
        .filter(|protocol| image_options.contains_key(protocol.as_str()))
        .collect::<Vec<_>>();
    let include_password = permissions
        .has_server_permission("databases-everywhere.credentials")
        .is_ok();
    let mut databases = Vec::new();
    for database in DatabaseRecord::all_for_server(&state, server.uuid).await? {
        databases.push(database.into_api(&state, include_password).await?);
    }
    let provisioning_enabled =
        availability.schedulable && extension_enabled && !protocols.is_empty();
    if !extension_enabled {
        provisioning_block_reason = Some(
            "DatabasesEverywhere provisioning is disabled by the panel administrator.".to_owned(),
        );
    } else if !availability.schedulable {
        provisioning_block_reason = Some(
            "No DatabasesEverywhere host is assigned to this server's node or location.".to_owned(),
        );
    } else if protocols.is_empty() && provisioning_block_reason.is_none() {
        provisioning_block_reason = Some(
            "No database protocol is currently enabled on a ready DatabasesEverywhere node."
                .to_owned(),
        );
    }
    ApiResponse::new_serialized(ListResponse {
        provider_available: availability.available,
        provisioning_enabled,
        provisioning_block_reason,
        protocols,
        database_limit: server.database_limit,
        database_usage: total_database_usage(&state, server.uuid).await?,
        database_cpu_cores: configuration.cpu_cores,
        database_memory_mib: configuration.memory_mib,
        database_disk_mib: configuration.disk_mib,
        database_backup_limit: configuration.backup_limit,
        image_options,
        databases,
    })
    .ok()
}

fn node_provisioning_block_reason(node: &crate::persistence::NodeRecord) -> Option<String> {
    if let Some(reason) = mutation_contract_block_reason(node.cached_system.as_ref()) {
        return Some(reason);
    }
    let gateways = node.cached_system.as_ref()?.get("gateways")?;
    match gateways.get("status").and_then(serde_json::Value::as_str) {
        Some("ready") => None,
        Some("starting" | "stopping") => Some(
            "The DBEV management API is ready, but database listeners are still starting."
                .to_owned(),
        ),
        Some("failed") => Some(format!(
            "DBEV is running, but one or more database gateways failed: {}",
            gateways
                .get("failure")
                .and_then(serde_json::Value::as_str)
                .filter(|failure| !failure.trim().is_empty())
                .unwrap_or("the daemon did not report a listener failure reason")
        )),
        _ => Some(
            "The DBEV management API is ready, but database listener readiness is unavailable."
                .to_owned(),
        ),
    }
}

#[derive(Serialize, ToSchema)]
struct CreateResponse {
    database: DatabaseRecordApi,
}

#[utoipa::path(post, path = "/", request_body = CreateDatabaseInput, responses(
    (status = OK, body = inline(CreateResponse)),
    (status = BAD_REQUEST, body = ApiError),
    (status = CONFLICT, body = ApiError),
    (status = EXPECTATION_FAILED, body = ApiError),
))]
async fn post(
    state: GetState,
    permissions: GetPermissionManager,
    server: GetServer,
    activity_logger: GetServerActivityLogger,
    shared::Payload(data): shared::Payload<CreateDatabaseInput>,
) -> ApiResponseResult {
    permissions.has_server_permission("databases-everywhere.create")?;
    let database = create_database(&state, &server, data).await?;
    activity_logger
        .log(
            "server:databases-everywhere.create",
            serde_json::json!({
                "uuid": database.uuid,
                "node_uuid": database.dbev_node_uuid,
                "protocol": database.protocol,
                "name": database.display_name,
                "limits": database.limits(),
            }),
        )
        .await;
    let include_password = permissions
        .has_server_permission("databases-everywhere.credentials")
        .is_ok();
    ApiResponse::new_serialized(CreateResponse {
        database: database.into_api(&state, include_password).await?,
    })
    .ok()
}

pub fn router(state: &State) -> OpenApiRouter<State> {
    OpenApiRouter::new()
        .nest("/{database}", database::router(state))
        .routes(routes!(get))
        .routes(routes!(post))
        .with_state(state.clone())
}
