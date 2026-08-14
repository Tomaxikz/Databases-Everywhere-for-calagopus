use super::validate_id;
use crate::{
    dbev::DbevCapabilities,
    persistence::{DatabaseRecord, NodeRecord},
};
use axum::{
    Extension,
    body::Body,
    extract::{DefaultBodyLimit, Path},
    http::{HeaderMap, StatusCode},
};
use contracts::{
    CSRF_HEADER, CSRF_VALUE, CatalogResponse, DeleteResponse, DumpInspection, MAX_UPLOAD_BYTES,
    TemporaryUpload, UploadListResponse, UploadResponse, validate_upload_headers,
};
use serde::{Deserialize, Serialize};
use shared::{
    ApiError, GetState, State,
    models::{server::GetServerActivityLogger, user::GetPermissionManager},
    response::{ApiResponse, ApiResponseResult, DisplayError, extract_readable_error},
};
use utoipa::ToSchema;
use utoipa_axum::{
    router::{OpenApiRouter, UtoipaMethodRouterExt},
    routes,
};

mod contracts;
mod legacy;

#[derive(Debug, Serialize, ToSchema)]
struct DetailResponse {
    upload: TemporaryUpload,
}

async fn system_and_capabilities(
    state: &State,
    database: &DatabaseRecord,
) -> Result<
    (
        crate::dbev::DbevClient,
        serde_json::Value,
        DbevCapabilities,
        u64,
    ),
    anyhow::Error,
> {
    let node = NodeRecord::by_uuid(state, database.dbev_node_uuid)
        .await?
        .ok_or_else(|| anyhow::anyhow!("DatabasesEverywhere node no longer exists"))?;
    let max_upload_bytes = configured_upload_max_bytes(&node.configuration);
    let client = crate::dbev::DbevClient::for_node(state, &node).await?;
    // Temporary uploads are gated only by the advertised API contract.
    let system = client.get::<serde_json::Value>("/api/system").await?;
    let capabilities = DbevCapabilities::from_system(&system);
    Ok((client, system, capabilities, max_upload_bytes))
}

async fn mutation_system_and_capabilities(
    state: &State,
    database: &DatabaseRecord,
) -> Result<
    (
        crate::dbev::DbevClient,
        serde_json::Value,
        DbevCapabilities,
        u64,
    ),
    anyhow::Error,
> {
    let node = NodeRecord::by_uuid(state, database.dbev_node_uuid)
        .await?
        .ok_or_else(|| anyhow::anyhow!("DatabasesEverywhere node no longer exists"))?;
    let max_upload_bytes = configured_upload_max_bytes(&node.configuration);
    let (client, system) = crate::dbev::DbevClient::for_mutation_with_system(state, &node).await?;
    let capabilities = DbevCapabilities::from_system(&system);
    Ok((client, system, capabilities, max_upload_bytes))
}

fn configured_upload_max_bytes(configuration: &serde_json::Value) -> u64 {
    configuration
        .pointer("/artifacts/import_upload_max_bytes")
        .and_then(serde_json::Value::as_u64)
        .filter(|value| (1..=MAX_UPLOAD_BYTES).contains(value))
        .unwrap_or(MAX_UPLOAD_BYTES)
}

fn api_version(system: &serde_json::Value) -> Option<String> {
    system
        .get("api_version")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
}

fn temporary_uploads(value: serde_json::Value) -> Result<Vec<TemporaryUpload>, anyhow::Error> {
    let values = if value.is_array() {
        value
    } else {
        value
            .get("uploads")
            .or_else(|| value.get("items"))
            .or_else(|| value.get("data"))
            .cloned()
            .unwrap_or(serde_json::Value::Array(Vec::new()))
    };
    serde_json::from_value(values).map_err(|_| {
        DisplayError::new("DatabasesEverywhere returned an invalid temporary upload list")
            .with_status(StatusCode::BAD_GATEWAY)
            .into()
    })
}

fn dump_inspection(value: serde_json::Value) -> Result<DumpInspection, anyhow::Error> {
    // Accept both current upload records and early API 0.11 raw catalogs.
    let catalog = value.get("catalog").cloned().unwrap_or(value);
    serde_json::from_value(catalog).map_err(|_| {
        DisplayError::new("DatabasesEverywhere returned an invalid temporary upload catalog")
            .with_status(StatusCode::BAD_GATEWAY)
            .into()
    })
}

fn require_temporary_uploads(capabilities: DbevCapabilities) -> Result<(), anyhow::Error> {
    if capabilities.temporary_dump_uploads {
        Ok(())
    } else {
        Err(DisplayError::new(
            "this DBEV node does not advertise the API 0.11 temporary upload contract",
        )
        .with_status(StatusCode::NOT_FOUND)
        .into())
    }
}

fn require_csrf(headers: &HeaderMap) -> Result<(), anyhow::Error> {
    if headers
        .get(CSRF_HEADER)
        .and_then(|value| value.to_str().ok())
        == Some(CSRF_VALUE)
    {
        Ok(())
    } else {
        Err(DisplayError::new("missing or invalid upload CSRF header")
            .with_status(StatusCode::FORBIDDEN)
            .into())
    }
}

fn is_contract_mismatch(error: &anyhow::Error) -> bool {
    extract_readable_error(error).is_some_and(|(_, status)| {
        matches!(
            status,
            StatusCode::NOT_FOUND | StatusCode::UNSUPPORTED_MEDIA_TYPE
        )
    })
}

mod list {
    use super::*;

    #[derive(Debug, Deserialize, ToSchema)]
    pub struct Params {
        /// Set false after a browser-session contract mismatch.
        temporary: Option<bool>,
    }

    #[utoipa::path(get, path = "/", params(
        ("temporary" = Option<bool>, Query, description = "Set false after a session-level DBEV upload-contract mismatch."),
    ), responses(
        (status = OK, body = inline(UploadListResponse)),
        (status = BAD_GATEWAY, body = ApiError),
    ))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
        Extension(database): Extension<DatabaseRecord>,
        axum::extract::Query(params): axum::extract::Query<Params>,
    ) -> ApiResponseResult {
        permissions.has_server_permission("databases-everywhere.transfers")?;
        let (client, system, capabilities, max_upload_bytes) =
            system_and_capabilities(&state, &database).await?;
        let version = api_version(&system);

        if capabilities.temporary_dump_uploads && params.temporary != Some(false) {
            let staged_uploads = legacy::list(&state, &database)
                .await
                .map(|(uploads, _)| uploads)
                .unwrap_or_default();
            let result = client
                .get::<serde_json::Value>(&format!(
                    "/api/instances/{}/import/uploads",
                    urlencoding::encode(&database.instance_id()),
                ))
                .await;
            let result = match result {
                Ok(result) => result,
                Err(error) if is_contract_mismatch(&error) => {
                    return ApiResponse::new_serialized(UploadListResponse {
                        available: false,
                        contract_mismatch: true,
                        reason: Some(
                            "This host advertises API 0.11 but did not accept the temporary-upload contract. PC uploads are disabled for this browser session; saved exports and operator-staged files remain available."
                                .to_owned(),
                        ),
                        api_version: version,
                        max_upload_bytes,
                        uploads: Vec::new(),
                        staged_uploads,
                    })
                    .ok();
                }
                Err(error) => return Err(error.into()),
            };
            return ApiResponse::new_serialized(UploadListResponse {
                available: true,
                contract_mismatch: false,
                reason: None,
                api_version: version,
                max_upload_bytes,
                uploads: temporary_uploads(result)?,
                staged_uploads,
            })
            .ok();
        }

        if capabilities.temporary_dump_uploads {
            let staged_uploads = legacy::list(&state, &database)
                .await
                .map(|(uploads, _)| uploads)
                .unwrap_or_default();
            return ApiResponse::new_serialized(UploadListResponse {
                available: false,
                contract_mismatch: true,
                reason: Some(
                    "PC uploads are disabled for this browser session because this host did not accept the temporary-upload contract. Existing exports and operator-staged files remain available."
                        .to_owned(),
                ),
                api_version: version,
                max_upload_bytes,
                uploads: Vec::new(),
                staged_uploads,
            })
            .ok();
        }
        let (staged_uploads, legacy_reason) = legacy::list(&state, &database).await?;
        ApiResponse::new_serialized(UploadListResponse {
            available: false,
            contract_mismatch: false,
            reason: Some(match legacy_reason {
                Some(reason) => format!(
                    "Upload from computer requires DBEV API 0.11 or newer. {reason}"
                ),
                None => "Upload from computer requires DBEV API 0.11 or newer. Existing operator-staged files remain available under Saved file."
                    .to_owned(),
            }),
            api_version: version,
            max_upload_bytes,
            uploads: Vec::new(),
            staged_uploads,
        })
        .ok()
    }
}

mod upload {
    use super::*;

    #[utoipa::path(post, path = "/", request_body(
        content = Vec<u8>,
        content_type = "application/octet-stream",
    ), responses(
        (status = CREATED, body = inline(UploadResponse)),
        (status = BAD_REQUEST, body = ApiError),
        (status = FORBIDDEN, body = ApiError),
        (status = REQUEST_TIMEOUT, body = ApiError),
        (status = PAYLOAD_TOO_LARGE, body = ApiError),
        (status = UNSUPPORTED_MEDIA_TYPE, body = ApiError),
        (status = TOO_MANY_REQUESTS, body = ApiError),
    ))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
        activity_logger: GetServerActivityLogger,
        Extension(database): Extension<DatabaseRecord>,
        headers: HeaderMap,
        body: Body,
    ) -> ApiResponseResult {
        // Authorization and CSRF checks finish before the body stream is consumed.
        permissions.has_server_permission("databases-everywhere.import")?;
        let (client, _system, capabilities, max_upload_bytes) =
            mutation_system_and_capabilities(&state, &database).await?;
        let upload_headers = validate_upload_headers(&headers, max_upload_bytes)?;
        require_temporary_uploads(capabilities)?;

        let instance_id = database.instance_id();
        let stream = reqwest::Body::wrap_stream(body.into_data_stream());
        let upload = client
            .post_import_upload::<TemporaryUpload>(
                &format!(
                    "/api/instances/{}/import",
                    urlencoding::encode(&instance_id),
                ),
                upload_headers.content_length,
                &upload_headers.encoded_filename,
                upload_headers.sha256.as_deref(),
                stream,
            )
            .await?;

        if upload.instance_id != instance_id
            || upload.size_bytes != upload_headers.content_length
            || upload.original_filename != upload_headers.filename
        {
            return Err(DisplayError::new(
                "DatabasesEverywhere returned inconsistent temporary upload metadata",
            )
            .with_status(StatusCode::BAD_GATEWAY)
            .into());
        }
        activity_logger
            .log(
                "server:databases-everywhere.import-upload",
                serde_json::json!({
                    "uuid": database.uuid,
                    "upload_id": upload.upload_id,
                    "size_bytes": upload.size_bytes,
                }),
            )
            .await;

        Ok(ApiResponse::new_serialized(UploadResponse { upload }).with_status(StatusCode::CREATED))
    }
}

mod detail {
    use super::*;

    #[utoipa::path(get, path = "/", responses(
        (status = OK, body = inline(DetailResponse)),
        (status = NOT_FOUND, body = ApiError),
    ))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
        Extension(database): Extension<DatabaseRecord>,
        Path((_server, _database, upload)): Path<(String, uuid::Uuid, String)>,
    ) -> ApiResponseResult {
        permissions.has_server_permission("databases-everywhere.transfers")?;
        validate_id("upload", &upload)?;
        let (client, _system, capabilities, _max_upload_bytes) =
            system_and_capabilities(&state, &database).await?;
        require_temporary_uploads(capabilities)?;
        let upload = client
            .get::<TemporaryUpload>(&format!(
                "/api/instances/{}/import/uploads/{}",
                urlencoding::encode(&database.instance_id()),
                urlencoding::encode(&upload),
            ))
            .await?;
        ApiResponse::new_serialized(DetailResponse { upload }).ok()
    }
}

mod catalog {
    use super::*;

    #[utoipa::path(post, path = "/", responses(
        (status = OK, body = inline(CatalogResponse)),
        (status = CONFLICT, body = ApiError),
        (status = TOO_MANY_REQUESTS, body = ApiError),
        (status = SERVICE_UNAVAILABLE, body = ApiError),
    ))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
        activity_logger: GetServerActivityLogger,
        Extension(database): Extension<DatabaseRecord>,
        Path((_server, _database, upload)): Path<(String, uuid::Uuid, String)>,
        headers: HeaderMap,
    ) -> ApiResponseResult {
        permissions.has_server_permission("databases-everywhere.import")?;
        require_csrf(&headers)?;
        validate_id("upload", &upload)?;
        let (client, _system, capabilities, _max_upload_bytes) =
            mutation_system_and_capabilities(&state, &database).await?;
        require_temporary_uploads(capabilities)?;
        let result = client
            .post::<serde_json::Value, _>(
                &format!(
                    "/api/instances/{}/import/uploads/{}/catalog",
                    urlencoding::encode(&database.instance_id()),
                    urlencoding::encode(&upload),
                ),
                &serde_json::json!({}),
            )
            .await?;
        let catalog = dump_inspection(result)?;
        activity_logger
            .log(
                "server:databases-everywhere.import-upload-inspect",
                serde_json::json!({ "uuid": database.uuid, "upload_id": upload }),
            )
            .await;
        ApiResponse::new_serialized(CatalogResponse { catalog }).ok()
    }
}

mod delete {
    use super::*;

    #[derive(Debug, Deserialize, ToSchema)]
    pub struct Params {
        source: Option<String>,
    }

    #[utoipa::path(delete, path = "/", params(
        ("source" = Option<String>, Query, description = "Use legacy only for an operator-staged local file."),
    ), responses(
        (status = OK, body = inline(DeleteResponse)),
        (status = CONFLICT, body = ApiError),
        (status = NOT_FOUND, body = ApiError),
    ))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
        activity_logger: GetServerActivityLogger,
        Extension(database): Extension<DatabaseRecord>,
        Path((_server, _database, upload)): Path<(String, uuid::Uuid, String)>,
        axum::extract::Query(params): axum::extract::Query<Params>,
        headers: HeaderMap,
    ) -> ApiResponseResult {
        permissions.has_server_permission("databases-everywhere.import")?;
        require_csrf(&headers)?;
        validate_id("upload", &upload)?;
        let (client, _system, capabilities, _max_upload_bytes) =
            mutation_system_and_capabilities(&state, &database).await?;

        if params
            .source
            .as_deref()
            .is_some_and(|source| source != "legacy")
        {
            return Err(ApiResponse::error("invalid temporary upload source"));
        }

        let delete_legacy =
            params.source.as_deref() == Some("legacy") || !capabilities.temporary_dump_uploads;
        let deleted = if !delete_legacy {
            client
                .delete_success(&format!(
                    "/api/instances/{}/import/uploads/{}",
                    urlencoding::encode(&database.instance_id()),
                    urlencoding::encode(&upload),
                ))
                .await?;
            true
        } else {
            legacy::delete(&state, &database, &upload).await?
        };
        if !deleted {
            return Err(DisplayError::new("temporary upload was not found")
                .with_status(StatusCode::NOT_FOUND)
                .into());
        }
        activity_logger
            .log(
                "server:databases-everywhere.import-upload-delete",
                serde_json::json!({ "uuid": database.uuid, "upload_id": upload }),
            )
            .await;
        ApiResponse::new_serialized(DeleteResponse { deleted: true }).ok()
    }
}

pub fn router(state: &State) -> OpenApiRouter<State> {
    OpenApiRouter::new()
        .routes(routes!(list::route))
        .routes(routes!(upload::route).layer(DefaultBodyLimit::disable()))
        .nest(
            "/{upload}",
            OpenApiRouter::new()
                .routes(routes!(detail::route))
                .routes(routes!(delete::route))
                .nest(
                    "/catalog",
                    OpenApiRouter::new()
                        .routes(routes!(catalog::route))
                        .with_state(state.clone()),
                )
                .with_state(state.clone()),
        )
        .with_state(state.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_array_and_wrapped_upload_lists_without_artifact_conversion() {
        let upload = serde_json::json!({
            "upload_id": "upl_test",
            "instance_id": "instance",
            "original_filename": "dump.sql",
            "protocol": "postgres",
            "archive_format": "plain",
            "state": "ready",
            "size_bytes": 1,
            "sha256": null,
            "created_at": "2026-08-10T00:00:00Z",
            "updated_at": "2026-08-10T00:00:00Z",
            "expires_at": "2026-08-11T00:00:00Z"
        });
        assert_eq!(
            temporary_uploads(serde_json::json!([upload.clone()]))
                .unwrap()
                .len(),
            1
        );
        let parsed = temporary_uploads(serde_json::json!({ "uploads": [upload] })).unwrap();
        assert_eq!(parsed[0].upload_id, "upl_test");
        assert!(parsed[0].extra.get("artifact_id").is_none());
    }

    #[test]
    fn only_404_and_415_disable_the_contract_for_the_session() {
        for status in [StatusCode::NOT_FOUND, StatusCode::UNSUPPORTED_MEDIA_TYPE] {
            let error: anyhow::Error = DisplayError::new("unsupported").with_status(status).into();
            assert!(is_contract_mismatch(&error));
        }
        let conflict: anyhow::Error = DisplayError::new("state changed")
            .with_status(StatusCode::CONFLICT)
            .into();
        assert!(!is_contract_mismatch(&conflict));
    }

    #[test]
    fn accepts_current_wrapped_and_legacy_raw_catalog_responses() {
        let catalog = serde_json::json!({
            "protocol": "mongodb",
            "sha256": "a".repeat(64),
            "source_size_bytes": 1,
            "detected_archive_format": "plain",
            "selection_kind": "full_only",
            "selective_supported": false,
            "catalog_complete": true,
            "namespaces": ["tenant"],
            "objects": [],
            "unselectable_object_count": 0,
            "selective_unavailable_reason": "full import only"
        });
        assert_eq!(
            dump_inspection(serde_json::json!({ "catalog": catalog.clone() }))
                .unwrap()
                .namespaces,
            vec!["tenant"]
        );
        assert_eq!(dump_inspection(catalog).unwrap().namespaces, vec!["tenant"]);
    }

    #[test]
    fn configured_upload_limit_drives_panel_validation_and_scheduler_defaults() {
        assert_eq!(
            configured_upload_max_bytes(&serde_json::json!({
                "artifacts": { "import_upload_max_bytes": 536_870_912_u64 }
            })),
            536_870_912
        );
        assert_eq!(
            configured_upload_max_bytes(&serde_json::json!({
                "artifacts": { "import_upload_max_bytes": MAX_UPLOAD_BYTES + 1 }
            })),
            MAX_UPLOAD_BYTES
        );
    }
}
