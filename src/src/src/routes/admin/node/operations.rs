use crate::{
    dbev::{DbevCapabilities, DbevClient, validate_system_response},
    domain::DatabaseProtocol,
    persistence::NodeRecord,
};
use axum::{Extension, extract::Query, http::StatusCode};
use serde::{Deserialize, Serialize};
use shared::{
    ApiError, GetState, State,
    models::{admin_activity::GetAdminActivityLogger, user::GetPermissionManager},
    response::{ApiResponse, ApiResponseResult},
};
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};

#[derive(Serialize, ToSchema)]
struct Response {
    #[schema(value_type = serde_json::Value)]
    result: serde_json::Value,
}

mod test {
    use super::*;

    #[derive(Serialize, ToSchema)]
    struct TestResponse {
        #[schema(value_type = serde_json::Value)]
        heartbeat: serde_json::Value,
        #[schema(value_type = serde_json::Value)]
        system: serde_json::Value,
        #[schema(value_type = serde_json::Value)]
        resources: serde_json::Value,
        mutations_allowed: bool,
        mutation_block_reason: Option<String>,
    }

    #[utoipa::path(get, path = "/test", responses(
        (status = OK, body = inline(TestResponse)),
        (status = BAD_GATEWAY, body = ApiError),
    ))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
        Extension(node): Extension<NodeRecord>,
    ) -> ApiResponseResult {
        permissions.has_admin_permission("databases-everywhere-nodes.operations")?;
        let client = DbevClient::for_node(&state, &node).await?;
        let heartbeat = client.get::<serde_json::Value>("/api/heartbeat").await?;
        let system = client.get::<serde_json::Value>("/api/system").await?;
        let resources = client
            .get::<serde_json::Value>("/api/admin/resources/summary")
            .await?;
        let mutation_block_reason = crate::dbev::mutation_contract_block_reason(Some(&system));
        node.store_health(
            &state,
            Some(&system),
            Some(&resources),
            mutation_block_reason.as_deref(),
        )
        .await?;
        ApiResponse::new_serialized(TestResponse {
            heartbeat,
            system,
            resources,
            mutations_allowed: mutation_block_reason.is_none(),
            mutation_block_reason,
        })
        .ok()
    }
}

mod resources {
    use super::*;

    #[utoipa::path(get, path = "/resources", responses((status = OK, body = inline(Response))))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
        Extension(node): Extension<NodeRecord>,
    ) -> ApiResponseResult {
        permissions.has_admin_permission("databases-everywhere-nodes.operations")?;
        let result = DbevClient::for_node(&state, &node)
            .await?
            .get::<serde_json::Value>("/api/admin/resources")
            .await?;
        ApiResponse::new_serialized(Response { result }).ok()
    }
}

mod backup_status {
    use super::*;

    #[utoipa::path(get, path = "/backup-status", responses((status = OK, body = inline(Response))))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
        Extension(node): Extension<NodeRecord>,
    ) -> ApiResponseResult {
        permissions.has_admin_permission("databases-everywhere-nodes.operations")?;
        let result = DbevClient::for_node(&state, &node)
            .await?
            .get::<serde_json::Value>("/api/admin/backups/status")
            .await?;
        ApiResponse::new_serialized(Response { result }).ok()
    }
}

mod backup_run {
    use super::*;

    #[utoipa::path(post, path = "/backup-run", responses((status = OK, body = inline(Response))))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
        activity_logger: GetAdminActivityLogger,
        Extension(node): Extension<NodeRecord>,
    ) -> ApiResponseResult {
        permissions.has_admin_permission("databases-everywhere-nodes.operations")?;
        let result = DbevClient::for_mutation(&state, &node)
            .await?
            .post::<serde_json::Value, _>("/api/admin/backups/run", &serde_json::json!({}))
            .await?;
        activity_logger
            .log(
                "databases-everywhere-node:backup-run",
                serde_json::json!({ "uuid": node.uuid }),
            )
            .await;
        ApiResponse::new_serialized(Response { result }).ok()
    }
}

mod config {
    use super::*;

    #[derive(Deserialize, Serialize, ToSchema)]
    struct ConfigPatchResponse {
        applied: bool,
        restart_required: bool,
        config_path: String,
    }

    #[derive(Serialize, ToSchema)]
    struct ConfigResponse {
        result: ConfigPatchResponse,
    }

    #[derive(Deserialize, ToSchema)]
    pub struct Payload {
        #[schema(value_type = serde_json::Value)]
        patch: serde_json::Value,
    }

    #[utoipa::path(patch, path = "/remote-config", request_body = inline(Payload), responses(
        (status = OK, body = inline(ConfigResponse)),
        (status = BAD_REQUEST, body = ApiError),
    ))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
        activity_logger: GetAdminActivityLogger,
        Extension(node): Extension<NodeRecord>,
        shared::Payload(data): shared::Payload<Payload>,
    ) -> ApiResponseResult {
        permissions.has_admin_permission("databases-everywhere-nodes.update")?;
        if !data.patch.is_object() {
            return Err(ApiResponse::error(
                "configuration patch must be a JSON object",
            ));
        }
        reject_unsafe_live_patch(&data.patch)?;
        let result = DbevClient::for_mutation(&state, &node)
            .await?
            .patch::<ConfigPatchResponse, _>("/api/system/config", &data.patch)
            .await?;
        if !result.applied {
            return Err(anyhow::anyhow!(
                "DatabasesEverywhere did not confirm that the configuration patch was applied"
            )
            .into());
        }
        let mut configuration = node.configuration.clone();
        merge_patch(&mut configuration, &data.patch);
        node.update_configuration(&state, configuration).await?;
        if result.restart_required {
            node.mark_restart_required(&state, true).await?;
        }
        let keys = data
            .patch
            .as_object()
            .map(|object| object.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        activity_logger
            .log(
                "databases-everywhere-node:config-patch",
                serde_json::json!({ "uuid": node.uuid, "keys": keys }),
            )
            .await;
        ApiResponse::new_serialized(ConfigResponse { result }).ok()
    }
}

mod scheduler_recommendation {
    use super::*;
    use shared::response::DisplayError;

    const MAX_SIZE_BYTES: u64 = 68_719_476_736;

    #[derive(Debug, Deserialize, ToSchema)]
    pub struct Params {
        protocol: DatabaseProtocol,
        action: String,
        size_bytes: u64,
        target_disk_mib: u64,
        mode: String,
        compressed: bool,
    }

    impl Params {
        fn upstream_query(&self) -> Result<String, anyhow::Error> {
            if !matches!(self.action.as_str(), "import" | "export") {
                return Err(DisplayError::new("scheduler action must be import or export").into());
            }
            if !(1..=MAX_SIZE_BYTES).contains(&self.size_bytes) {
                return Err(DisplayError::new(format!(
                    "scheduler size must be between 1 and {MAX_SIZE_BYTES} bytes"
                ))
                .into());
            }
            if self.target_disk_mib < 1 {
                return Err(
                    DisplayError::new("scheduler target disk must be at least 1 MiB").into(),
                );
            }
            if !matches!(self.mode.as_str(), "merge" | "wipe") {
                return Err(DisplayError::new("scheduler mode must be merge or wipe").into());
            }

            // Normalize combinations the scheduler contract rejects.
            let mode = if self.action == "export" {
                "merge"
            } else {
                self.mode.as_str()
            };
            let compressed = self.compressed
                || matches!(
                    self.protocol,
                    DatabaseProtocol::Mongodb
                        | DatabaseProtocol::Redis
                        | DatabaseProtocol::Valkey
                        | DatabaseProtocol::Qdrant
                );
            Ok(format!(
                "protocol={}&action={}&size_bytes={}&target_disk_mib={}&mode={}&compressed={}",
                self.protocol.as_str(),
                self.action,
                self.size_bytes,
                self.target_disk_mib,
                mode,
                compressed
            ))
        }
    }

    #[utoipa::path(get, path = "/scheduler/recommendation", params(
        ("protocol" = DatabaseProtocol, Query),
        ("action" = String, Query),
        ("size_bytes" = u64, Query),
        ("target_disk_mib" = u64, Query),
        ("mode" = String, Query),
        ("compressed" = bool, Query),
    ), responses(
        (status = OK, body = inline(Response)),
        (status = BAD_REQUEST, body = ApiError),
        (status = NOT_FOUND, body = ApiError),
    ))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
        Extension(node): Extension<NodeRecord>,
        Query(params): Query<Params>,
    ) -> ApiResponseResult {
        permissions.has_admin_permission("databases-everywhere-nodes.operations")?;
        let client = DbevClient::for_node(&state, &node).await?;
        let system = client.get::<serde_json::Value>("/api/system").await?;
        if !DbevCapabilities::from_system(&system).scheduler_recommendations {
            return Err(DisplayError::new(
                "scheduler recommendations require DatabasesEverywhere API 0.12 or newer",
            )
            .with_status(StatusCode::NOT_FOUND)
            .into());
        }
        let result = client
            .get::<serde_json::Value>(&format!(
                "/api/system/import-export-scheduler/recommendation?{}",
                params.upstream_query()?
            ))
            .await?;
        ApiResponse::new_serialized(Response { result }).ok()
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn serializes_exact_scheduler_query_and_normalizes_physical_archives() {
            let params = Params {
                protocol: DatabaseProtocol::Mongodb,
                action: "export".to_owned(),
                size_bytes: 1,
                target_disk_mib: 1,
                mode: "wipe".to_owned(),
                compressed: false,
            };
            assert_eq!(
                params.upstream_query().unwrap(),
                "protocol=mongodb&action=export&size_bytes=1&target_disk_mib=1&mode=merge&compressed=true"
            );
        }

        #[test]
        fn rejects_scheduler_query_boundaries() {
            let mut params = Params {
                protocol: DatabaseProtocol::Postgres,
                action: "import".to_owned(),
                size_bytes: 1,
                target_disk_mib: 1,
                mode: "merge".to_owned(),
                compressed: false,
            };
            assert!(params.upstream_query().is_ok());
            params.size_bytes = MAX_SIZE_BYTES + 1;
            assert!(params.upstream_query().is_err());
            params.size_bytes = 1;
            params.target_disk_mib = 0;
            assert!(params.upstream_query().is_err());
        }
    }
}

mod pull_image {
    use super::*;

    #[derive(Deserialize, ToSchema)]
    pub struct Payload {
        protocol: DatabaseProtocol,
        image: Option<String>,
    }

    #[utoipa::path(post, path = "/pull-image", request_body = inline(Payload), responses(
        (status = OK, body = inline(Response)),
        (status = BAD_REQUEST, body = ApiError),
    ))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
        activity_logger: GetAdminActivityLogger,
        Extension(node): Extension<NodeRecord>,
        shared::Payload(data): shared::Payload<Payload>,
    ) -> ApiResponseResult {
        permissions.has_admin_permission("databases-everywhere-nodes.operations")?;
        if data
            .image
            .as_deref()
            .is_some_and(|image| image.trim().is_empty() || image.len() > 255)
        {
            return Err(ApiResponse::error("invalid image reference"));
        }
        let result = DbevClient::for_mutation(&state, &node)
            .await?
            .post::<serde_json::Value, _>(
                "/api/admin/images/pull",
                &serde_json::json!({ "protocol": data.protocol, "image": data.image }),
            )
            .await?;
        activity_logger
            .log(
                "databases-everywhere-node:pull-image",
                serde_json::json!({
                    "uuid": node.uuid,
                    "protocol": data.protocol,
                    "image": data.image,
                }),
            )
            .await;
        ApiResponse::new_serialized(Response { result }).ok()
    }
}

mod restart_confirm {
    use super::*;

    #[utoipa::path(post, path = "/restart-confirm", responses(
        (status = OK, body = inline(Response)),
        (status = CONFLICT, body = ApiError),
    ))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
        activity_logger: GetAdminActivityLogger,
        Extension(node): Extension<NodeRecord>,
    ) -> ApiResponseResult {
        permissions.has_admin_permission("databases-everywhere-nodes.operations")?;
        let client = DbevClient::for_node(&state, &node).await?;
        let system = client.get::<serde_json::Value>("/api/system").await?;
        if let Err(error) = validate_system_response(&system) {
            let message = error.to_string();
            node.store_health(&state, Some(&system), None, Some(&message))
                .await?;
            return Err(error.into());
        }
        node.store_health(&state, Some(&system), None, None).await?;
        node.mark_restart_required(&state, false).await?;
        activity_logger
            .log(
                "databases-everywhere-node:restart-confirmed",
                serde_json::json!({ "uuid": node.uuid }),
            )
            .await;
        ApiResponse::new_serialized(Response { result: system }).ok()
    }
}

const FORBIDDEN_LIVE_PATCH_PATHS: &[&[&str]] = &[
    &["remote"],
    &["uuid"],
    &["token_id"],
    &["token"],
    &["jwt_signing_key"],
    &["paths"],
    &["tls", "cert"],
    &["tls", "key"],
    &["api", "ssl", "cert"],
    &["api", "ssl", "key"],
    &["api", "ssl", "client_ca"],
    &["daemon", "socket_path"],
    &["disk", "fuse_quota_binary"],
    &["disk", "fuse_quota_binary_sha256"],
    &["backups", "storage", "s3", "access_key_id"],
    &["backups", "storage", "s3", "secret_access_key"],
    &["backups", "storage", "s3", "session_token"],
    &["backups", "storage", "kopia", "executable"],
    &["backups", "storage", "kopia", "config_file"],
    &["backups", "storage", "kopia", "repository_password"],
];

fn reject_unsafe_live_patch(patch: &serde_json::Value) -> Result<(), anyhow::Error> {
    for path in FORBIDDEN_LIVE_PATCH_PATHS {
        if value_has_path(patch, path) {
            return Err(shared::response::DisplayError::new(format!(
                "Live configuration patches may not modify {}. Save the Calagopus node record and deploy its generated config.yml instead.",
                path.join(".")
            ))
            .with_status(StatusCode::BAD_REQUEST)
            .into());
        }
    }
    Ok(())
}

fn value_has_path(value: &serde_json::Value, path: &[&str]) -> bool {
    let mut current = value;
    for segment in path {
        let Some(next) = current.get(*segment) else {
            return false;
        };
        current = next;
    }
    true
}

fn merge_patch(target: &mut serde_json::Value, patch: &serde_json::Value) {
    let Some(patch) = patch.as_object() else {
        *target = patch.clone();
        return;
    };
    if !target.is_object() {
        *target = serde_json::json!({});
    }
    let target = target
        .as_object_mut()
        .expect("target was converted to an object");
    for (key, value) in patch {
        if value.is_null() {
            target.remove(key);
        } else {
            merge_patch(target.entry(key).or_insert(serde_json::Value::Null), value);
        }
    }
}

pub fn router(state: &State) -> OpenApiRouter<State> {
    OpenApiRouter::new()
        .routes(routes!(test::route))
        .routes(routes!(resources::route))
        .routes(routes!(backup_status::route))
        .routes(routes!(backup_run::route))
        .routes(routes!(config::route))
        .routes(routes!(scheduler_recommendation::route))
        .routes(routes!(pull_image::route))
        .routes(routes!(restart_confirm::route))
        .with_state(state.clone())
}

#[cfg(test)]
mod live_patch_tests {
    use super::*;

    #[test]
    fn rejects_identity_secret_and_path_patches_before_proxying() {
        for patch in [
            serde_json::json!({ "remote": "https://example.invalid" }),
            serde_json::json!({ "paths": { "data": "/tmp/data" } }),
            serde_json::json!({ "tls": { "key": "/tmp/key.pem" } }),
            serde_json::json!({ "daemon": { "socket_path": "/run/podman/podman.sock" } }),
            serde_json::json!({ "backups": { "storage": { "s3": { "secret_access_key": "secret" } } } }),
        ] {
            assert!(reject_unsafe_live_patch(&patch).is_err());
        }
        assert!(
            reject_unsafe_live_patch(&serde_json::json!({
                "allocation": { "prevent_cpu_overallocation": true }
            }))
            .is_ok()
        );
    }
}
