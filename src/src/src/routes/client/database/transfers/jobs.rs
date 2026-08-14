use super::{client, mutation_client, mutation_client_with_system, validate_id};
use crate::persistence::DatabaseRecord;
use axum::{
    Extension,
    extract::{Path, Query},
    http::HeaderMap,
};
use serde::{Deserialize, Serialize};
use shared::{
    ApiError, GetState, State,
    models::{server::GetServerActivityLogger, user::GetPermissionManager},
    response::{ApiResponse, ApiResponseResult, DisplayError},
};
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};

#[derive(Serialize, ToSchema)]
struct Response {
    #[schema(value_type = serde_json::Value)]
    result: serde_json::Value,
}

fn accepted_job_response(
    result: serde_json::Value,
    server: &str,
    database: uuid::Uuid,
) -> ApiResponse {
    let location = result
        .get("job_id")
        .or_else(|| result.get("id"))
        .and_then(serde_json::Value::as_str)
        .map(|job_id| {
            format!(
                "/api/client/servers/{}/databases-everywhere/{}/transfers/jobs/{}",
                urlencoding::encode(server),
                database,
                urlencoding::encode(job_id),
            )
        });
    ApiResponse::new_serialized(Response { result })
        .with_status(axum::http::StatusCode::ACCEPTED)
        .with_optional_header("location", location)
}

mod export {
    use super::*;

    #[derive(Deserialize, Serialize, ToSchema)]
    pub struct Payload {
        #[serde(skip_serializing_if = "Option::is_none")]
        archive_format: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[schema(value_type = Option<serde_json::Value>)]
        selection: Option<serde_json::Value>,
    }

    #[utoipa::path(post, path = "/export", request_body = inline(Payload), responses(
        (status = ACCEPTED, body = inline(Response)),
        (status = BAD_REQUEST, body = ApiError),
    ))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
        activity_logger: GetServerActivityLogger,
        Extension(database): Extension<DatabaseRecord>,
        Path((server, _database)): Path<(String, uuid::Uuid)>,
        shared::Payload(mut data): shared::Payload<Payload>,
    ) -> ApiResponseResult {
        permissions.has_server_permission("databases-everywhere.export")?;
        if let Some(format) = data.archive_format.as_deref()
            && !matches!(format, "plain" | "gzip" | "bzip2")
        {
            return Err(ApiResponse::error("invalid export archive format"));
        }
        if data.selection.is_some() && !database.protocol.supports_selective_export() {
            return Err(ApiResponse::error(
                "selective exports are not supported for this database protocol",
            ));
        }
        data.archive_format =
            normalized_export_format(database.protocol, data.archive_format.as_deref());
        let client = mutation_client(&state, &database).await?;
        let result = client
            .post_accepted::<serde_json::Value, _>(
                &format!(
                    "/api/instances/{}/export",
                    urlencoding::encode(&database.instance_id())
                ),
                &data,
            )
            .await?;
        activity_logger
            .log(
                "server:databases-everywhere.export",
                serde_json::json!({
                    "uuid": database.uuid,
                    "archive_format": data.archive_format,
                    "selective": data.selection.is_some(),
                    "job_id": result.get("job_id"),
                }),
            )
            .await;
        Ok(accepted_job_response(result, &server, database.uuid))
    }

    fn normalized_export_format(
        protocol: crate::domain::DatabaseProtocol,
        archive_format: Option<&str>,
    ) -> Option<String> {
        use crate::domain::DatabaseProtocol;
        match protocol {
            DatabaseProtocol::Redis | DatabaseProtocol::Valkey | DatabaseProtocol::Qdrant => None,
            DatabaseProtocol::Mongodb if archive_format == Some("gzip") => Some("plain".to_owned()),
            _ => archive_format.map(str::to_owned),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn default_export_is_a_real_empty_json_object() {
            let payload = Payload {
                archive_format: None,
                selection: None,
            };
            assert_eq!(
                serde_json::to_value(payload).unwrap(),
                serde_json::json!({})
            );
        }

        #[test]
        fn mongodb_does_not_receive_a_second_gzip_wrapper() {
            assert_eq!(
                normalized_export_format(crate::domain::DatabaseProtocol::Mongodb, Some("gzip")),
                Some("plain".to_owned())
            );
            assert_eq!(
                normalized_export_format(crate::domain::DatabaseProtocol::Mongodb, Some("bzip2")),
                Some("bzip2".to_owned())
            );
            assert_eq!(
                normalized_export_format(crate::domain::DatabaseProtocol::Redis, Some("gzip")),
                None
            );
        }

        #[test]
        fn accepted_exports_expose_the_panel_job_location() {
            let database = uuid::Uuid::nil();
            let response = accepted_job_response(
                serde_json::json!({ "job_id": "job_example", "status": "queued" }),
                "server-example",
                database,
            );
            assert_eq!(
                response
                    .headers
                    .get("location")
                    .and_then(|value| value.to_str().ok()),
                Some(
                    "/api/client/servers/server-example/databases-everywhere/00000000-0000-0000-0000-000000000000/transfers/jobs/job_example"
                )
            );
        }
    }
}

mod import {
    use super::*;
    use std::collections::BTreeMap;

    #[derive(Deserialize, Serialize, ToSchema)]
    pub struct Selection {
        mode: String,
        include: Option<Vec<String>>,
        exclude: Option<Vec<String>>,
        fields: Option<BTreeMap<String, Vec<String>>>,
    }

    #[derive(Deserialize, Serialize, ToSchema)]
    pub struct Payload {
        #[schema(value_type = serde_json::Value)]
        source: serde_json::Value,
        mode: Option<String>,
        selection: Option<Selection>,
    }

    #[utoipa::path(post, path = "/import", request_body = inline(Payload), responses(
        (status = ACCEPTED, body = inline(Response)),
        (status = BAD_REQUEST, body = ApiError),
    ))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
        activity_logger: GetServerActivityLogger,
        Extension(database): Extension<DatabaseRecord>,
        Path((server, _database)): Path<(String, uuid::Uuid)>,
        headers: HeaderMap,
        shared::Payload(mut data): shared::Payload<Payload>,
    ) -> ApiResponseResult {
        permissions.has_server_permission("databases-everywhere.import")?;
        if let Some(mode) = data.mode.as_deref()
            && !matches!(mode, "merge" | "wipe")
        {
            return Err(ApiResponse::error("import mode must be merge or wipe"));
        }
        let source_type = data
            .source
            .get("type")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| DisplayError::new("import source.type is required"))?
            .to_owned();
        if !matches!(source_type.as_str(), "artifact" | "remote" | "upload") {
            return Err(ApiResponse::error(
                "import source type must be artifact, remote, or upload",
            ));
        }
        if source_type == "artifact" {
            let artifact = data
                .source
                .get("artifact_id")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| DisplayError::new("artifact_id is required"))?;
            validate_id("artifact", artifact)?;
        }
        if source_type == "remote" {
            validate_remote_secret_limits(&data.source)?;
        }
        let (client, system, node) = mutation_client_with_system(&state, &database).await?;
        if source_type == "remote" {
            validate_remote_import_policy(&system, &node.configuration, &data.source)?;
        }
        if source_type == "upload" {
            if headers
                .get("x-calagopus-csrf")
                .and_then(|value| value.to_str().ok())
                != Some("dbev-upload-v1")
            {
                return Err(ApiResponse::error("missing or invalid upload CSRF header")
                    .with_status(axum::http::StatusCode::FORBIDDEN));
            }
            let system = client.get::<serde_json::Value>("/api/system").await?;
            let capabilities = crate::dbev::DbevCapabilities::from_system(&system);
            if !capabilities.temporary_dump_uploads {
                return Err(DisplayError::new(
                    "temporary uploads require DatabasesEverywhere API 0.11 or newer",
                )
                .with_status(axum::http::StatusCode::NOT_FOUND)
                .into());
            }
            data.source = validate_upload_source(
                database.protocol,
                &data.source,
                capabilities.mongodb_source_discovery,
            )?;
            if !matches!(data.mode.as_deref(), Some("merge" | "wipe")) {
                return Err(ApiResponse::error(
                    "upload-backed imports require an explicit merge or wipe mode",
                ));
            }
            if let Some(selection) = data.selection.as_ref() {
                if selection.mode != "full"
                    || selection
                        .include
                        .as_ref()
                        .is_some_and(|values| !values.is_empty())
                    || selection
                        .exclude
                        .as_ref()
                        .is_some_and(|values| !values.is_empty())
                    || selection
                        .fields
                        .as_ref()
                        .is_some_and(|values| !values.is_empty())
                {
                    return Err(ApiResponse::error("temporary uploads are full-import-only"));
                }
            }
        }
        if let Some(selection) = data.selection.as_ref() {
            validate_selection(database.protocol, &source_type, selection)?;
        }
        let result = client
            .post_accepted::<serde_json::Value, _>(
                &format!(
                    "/api/instances/{}/import",
                    urlencoding::encode(&database.instance_id())
                ),
                &data,
            )
            .await?;
        activity_logger
            .log(
                "server:databases-everywhere.import",
                serde_json::json!({
                    "uuid": database.uuid,
                    "source_type": source_type,
                    "mode": data.mode,
                    "selective": data.selection.as_ref().is_some_and(|selection| selection.mode == "selective"),
                    "job_id": result.get("job_id"),
                }),
            )
            .await;
        Ok(accepted_job_response(result, &server, database.uuid))
    }

    fn validate_upload_source(
        protocol: crate::domain::DatabaseProtocol,
        source: &serde_json::Value,
        mongodb_discovery_supported: bool,
    ) -> Result<serde_json::Value, anyhow::Error> {
        let object = source
            .as_object()
            .ok_or_else(|| DisplayError::new("upload import source must be an object"))?;
        if object
            .keys()
            .any(|key| !matches!(key.as_str(), "type" | "upload_id" | "source_database"))
        {
            return Err(
                DisplayError::new("upload import source contains an unsupported option").into(),
            );
        }
        let upload_id = object
            .get("upload_id")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| DisplayError::new("upload_id is required"))?;
        validate_id("upload", upload_id)?;
        let source_database = object
            .get("source_database")
            .and_then(serde_json::Value::as_str);

        if protocol == crate::domain::DatabaseProtocol::Mongodb {
            let source_database = source_database
                .map(str::trim)
                .filter(|value| !value.is_empty());
            if let Some(source_database) = source_database {
                validate_mongodb_source_database(source_database)?;
                Ok(serde_json::json!({
                    "type": "upload",
                    "upload_id": upload_id,
                    "source_database": source_database,
                }))
            } else if mongodb_discovery_supported {
                Ok(serde_json::json!({ "type": "upload", "upload_id": upload_id }))
            } else {
                Err(
                    DisplayError::new("MongoDB uploads on API 0.11 require source_database")
                        .with_status(axum::http::StatusCode::CONFLICT)
                        .into(),
                )
            }
        } else {
            if source_database.is_some() {
                return Err(DisplayError::new(
                    "source_database is accepted only for MongoDB temporary uploads",
                )
                .into());
            }
            Ok(serde_json::json!({ "type": "upload", "upload_id": upload_id }))
        }
    }

    fn validate_mongodb_source_database(value: &str) -> Result<(), anyhow::Error> {
        if value.as_bytes().is_empty()
            || value.as_bytes().len() > 63
            || value
                .chars()
                .any(|character| matches!(character, '\0' | '/' | '\\' | '.' | ' ' | '"' | '$'))
        {
            return Err(DisplayError::new(
                "MongoDB source database must be 1–63 UTF-8 bytes and cannot contain NUL, ASCII spaces, periods, slashes, double quotes, or dollar signs",
            )
            .into());
        }
        Ok(())
    }

    fn validate_remote_secret_limits(source: &serde_json::Value) -> Result<(), anyhow::Error> {
        let object = source
            .as_object()
            .ok_or_else(|| DisplayError::new("remote import source must be an object"))?;
        for (key, label) in [
            ("password", "remote password"),
            ("api_key", "Qdrant API key"),
        ] {
            if let Some(value) = object.get(key) {
                let value = value
                    .as_str()
                    .ok_or_else(|| DisplayError::new(format!("{label} must be a string")))?;
                if value.as_bytes().len() > 4_096 {
                    return Err(DisplayError::new(format!(
                        "{label} must not exceed 4096 UTF-8 bytes"
                    ))
                    .into());
                }
            }
        }
        Ok(())
    }

    fn validate_remote_import_policy(
        system: &serde_json::Value,
        configuration: &serde_json::Value,
        source: &serde_json::Value,
    ) -> Result<(), anyhow::Error> {
        if system
            .get("remote_import_enabled")
            .and_then(serde_json::Value::as_bool)
            != Some(true)
        {
            return Err(DisplayError::new(
                "Remote database imports are disabled on this DBEV node. Enable security.remote_import.enabled, restart DBEV, and refresh the database before trying again.",
            )
            .with_status(axum::http::StatusCode::CONFLICT)
            .into());
        }
        let tls = source
            .get("tls")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true);
        let allow_plaintext = configuration
            .pointer("/security/remote_import/allow_plaintext")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        if !tls && !allow_plaintext {
            return Err(DisplayError::new(
                "Plaintext remote imports are disabled on this DBEV node. Use TLS or enable security.remote_import.allow_plaintext and restart DBEV.",
            )
            .with_status(axum::http::StatusCode::CONFLICT)
            .into());
        }
        Ok(())
    }

    fn validate_selection(
        protocol: crate::domain::DatabaseProtocol,
        source_type: &str,
        selection: &Selection,
    ) -> Result<(), anyhow::Error> {
        if !matches!(selection.mode.as_str(), "full" | "selective") {
            return Err(DisplayError::new("selection mode must be full or selective").into());
        }
        if selection.mode == "full" {
            return Ok(());
        }
        if matches!(
            protocol,
            crate::domain::DatabaseProtocol::Redis | crate::domain::DatabaseProtocol::Valkey
        ) || (protocol == crate::domain::DatabaseProtocol::Qdrant && source_type == "artifact")
        {
            return Err(DisplayError::new(
                "selective import is not supported for this protocol and source type",
            )
            .into());
        }
        let include = selection.include.as_deref().unwrap_or_default();
        if include.is_empty() || include.len() > 500 {
            return Err(DisplayError::new("select between 1 and 500 objects").into());
        }
        if protocol == crate::domain::DatabaseProtocol::Mongodb
            && source_type == "artifact"
            && include.len() != 1
        {
            return Err(DisplayError::new(
                "MongoDB selective artifact imports require exactly one collection",
            )
            .into());
        }
        for name in include
            .iter()
            .chain(selection.exclude.iter().flatten())
            .chain(selection.fields.iter().flat_map(|fields| fields.keys()))
            .chain(
                selection
                    .fields
                    .iter()
                    .flat_map(|fields| fields.values().flatten()),
            )
        {
            if name.trim().is_empty() || name.len() > 256 || name.chars().any(char::is_control) {
                return Err(
                    DisplayError::new("invalid selective import object or field name").into(),
                );
            }
        }
        if selection.fields.is_some() && protocol != crate::domain::DatabaseProtocol::Clickhouse {
            return Err(DisplayError::new(
                "field-level selection is supported only for ClickHouse",
            )
            .into());
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn mongodb_upload_sources_are_strict_and_forward_only_supported_fields() {
            let source = validate_upload_source(
                crate::domain::DatabaseProtocol::Mongodb,
                &serde_json::json!({
                    "type": "upload",
                    "upload_id": "upl_example",
                    "source_database": "legacy_tenant"
                }),
                false,
            )
            .unwrap();
            assert_eq!(source["source_database"], "legacy_tenant");

            for invalid in ["", "has space", "has.period", "has/slash", "has$money"] {
                assert!(
                    validate_mongodb_source_database(invalid).is_err(),
                    "{invalid}"
                );
            }
            assert!(
                validate_upload_source(
                    crate::domain::DatabaseProtocol::Postgres,
                    &serde_json::json!({
                        "type": "upload",
                        "upload_id": "upl_example",
                        "source_database": "legacy"
                    }),
                    true,
                )
                .is_err()
            );

            let missing = validate_upload_source(
                crate::domain::DatabaseProtocol::Mongodb,
                &serde_json::json!({
                    "type": "upload",
                    "upload_id": "upl_example"
                }),
                false,
            )
            .unwrap_err();
            assert_eq!(
                shared::response::extract_readable_error(&missing).map(|(_, status)| status),
                Some(axum::http::StatusCode::CONFLICT)
            );
        }

        #[test]
        fn api_v012_allows_daemon_inference_and_trims_manual_mongodb_sources() {
            assert_eq!(
                validate_upload_source(
                    crate::domain::DatabaseProtocol::Mongodb,
                    &serde_json::json!({ "type": "upload", "upload_id": "upl_example" }),
                    true,
                )
                .unwrap(),
                serde_json::json!({ "type": "upload", "upload_id": "upl_example" })
            );
            let source = validate_upload_source(
                crate::domain::DatabaseProtocol::Mongodb,
                &serde_json::json!({
                    "type": "upload",
                    "upload_id": "upl_example",
                    "source_database": "  tenant's_data  "
                }),
                true,
            )
            .unwrap();
            assert_eq!(source["source_database"], "tenant's_data");
        }

        #[test]
        fn remote_secrets_are_limited_by_utf8_bytes() {
            assert!(
                validate_remote_secret_limits(&serde_json::json!({
                    "type": "remote",
                    "password": "a".repeat(4096)
                }))
                .is_ok()
            );
            assert!(
                validate_remote_secret_limits(&serde_json::json!({
                    "type": "remote",
                    "api_key": "é".repeat(2049)
                }))
                .is_err()
            );
        }
    }
}

mod list {
    use super::*;

    #[derive(Deserialize, ToSchema)]
    pub struct Params {
        status: Option<String>,
        limit: Option<u16>,
    }

    #[utoipa::path(get, path = "/jobs", params(
        ("status" = Option<String>, Query),
        ("limit" = Option<u16>, Query),
    ), responses((status = OK, body = inline(Response))))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
        Extension(database): Extension<DatabaseRecord>,
        Query(params): Query<Params>,
    ) -> ApiResponseResult {
        permissions.has_server_permission("databases-everywhere.transfers")?;
        if let Some(status) = params.status.as_deref()
            && !matches!(status, "queued" | "running" | "succeeded" | "failed")
        {
            return Err(ApiResponse::error("invalid job status"));
        }
        let mut query = vec![format!(
            "limit={}",
            params.limit.unwrap_or(50).clamp(1, 200)
        )];
        if let Some(status) = params.status {
            query.push(format!("status={}", urlencoding::encode(&status)));
        }
        let client = client(&state, &database).await?;
        let result = client
            .get::<serde_json::Value>(&format!(
                "/api/instances/{}/import-export/jobs?{}",
                urlencoding::encode(&database.instance_id()),
                query.join("&"),
            ))
            .await?;
        ApiResponse::new_serialized(Response { result }).ok()
    }
}

mod detail {
    use super::*;

    #[utoipa::path(get, path = "/", responses(
        (status = OK, body = inline(Response)),
        (status = NOT_FOUND, body = ApiError),
    ), params(
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
            "job" = String,
            description = "Job ID",
            example = "01JDBEVEXAMPLEJOB00000000",
        ),
    ))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
        Extension(database): Extension<DatabaseRecord>,
        Path((_server, _database, job)): Path<(String, uuid::Uuid, String)>,
    ) -> ApiResponseResult {
        permissions.has_server_permission("databases-everywhere.transfers")?;
        validate_id("job", &job)?;
        let client = client(&state, &database).await?;
        let result = client
            .get::<serde_json::Value>(&format!(
                "/api/instances/{}/import-export/jobs/{}",
                urlencoding::encode(&database.instance_id()),
                urlencoding::encode(&job),
            ))
            .await?;
        ApiResponse::new_serialized(Response { result }).ok()
    }
}

mod retry {
    use super::*;

    #[utoipa::path(post, path = "/retry", responses(
        (status = ACCEPTED, body = inline(Response)),
        (status = BAD_REQUEST, body = ApiError),
    ), params(
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
            "job" = String,
            description = "Job ID",
            example = "01JDBEVEXAMPLEJOB00000000",
        ),
    ))]
    pub async fn route(
        state: GetState,
        permissions: GetPermissionManager,
        activity_logger: GetServerActivityLogger,
        Extension(database): Extension<DatabaseRecord>,
        Path((_server, _database, job)): Path<(String, uuid::Uuid, String)>,
    ) -> ApiResponseResult {
        permissions.has_server_permission("databases-everywhere.import")?;
        validate_id("job", &job)?;
        let client = mutation_client(&state, &database).await?;
        let result = client
            .post_accepted::<serde_json::Value, _>(
                &format!(
                    "/api/instances/{}/recovery/jobs/{}/retry",
                    urlencoding::encode(&database.instance_id()),
                    urlencoding::encode(&job),
                ),
                &serde_json::json!({}),
            )
            .await?;
        activity_logger
            .log(
                "server:databases-everywhere.transfer-retry",
                serde_json::json!({ "uuid": database.uuid, "job_id": job }),
            )
            .await;
        Ok(ApiResponse::new_serialized(Response { result })
            .with_status(axum::http::StatusCode::ACCEPTED))
    }
}

pub fn router(state: &State) -> OpenApiRouter<State> {
    OpenApiRouter::new()
        .routes(routes!(export::route))
        .routes(routes!(import::route))
        .routes(routes!(list::route))
        .nest(
            "/jobs/{job}",
            OpenApiRouter::new()
                .routes(routes!(detail::route))
                .routes(routes!(retry::route))
                .with_state(state.clone()),
        )
        .with_state(state.clone())
}
