use crate::domain::DatabaseProtocol;
use axum::extract::{Path, Query};
use serde::{Deserialize, Serialize};
use shared::{
    ApiError, GetState, State,
    models::user::GetPermissionManager,
    response::{ApiResponse, ApiResponseResult, DisplayError},
};
use std::{str::FromStr, time::Duration};
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};

const MAX_REGISTRY_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Deserialize, ToSchema)]
struct Params {
    page: Option<u32>,
    per_page: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct DockerHubResponse {
    count: u64,
    next: Option<String>,
    previous: Option<String>,
    results: Vec<DockerHubTag>,
}

#[derive(Debug, Deserialize)]
struct DockerHubTag {
    name: String,
    last_updated: Option<String>,
    full_size: Option<u64>,
    #[serde(default)]
    images: Vec<DockerHubImage>,
}

#[derive(Debug, Deserialize)]
struct DockerHubImage {
    digest: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
struct RegistryImage {
    tag: String,
    reference: String,
    digest_reference: Option<String>,
    last_updated: Option<String>,
    size_bytes: Option<u64>,
}

#[derive(Debug, Serialize, ToSchema)]
struct Response {
    protocol: DatabaseProtocol,
    repository: String,
    page: u32,
    per_page: u32,
    total: u64,
    has_next: bool,
    has_previous: bool,
    images: Vec<RegistryImage>,
}

#[utoipa::path(get, path = "/{protocol}", params(
    ("protocol" = String, Path),
    ("page" = Option<u32>, Query),
    ("per_page" = Option<u32>, Query),
), responses(
    (status = OK, body = inline(Response)),
    (status = BAD_REQUEST, body = ApiError),
    (status = BAD_GATEWAY, body = ApiError),
))]
async fn get(
    state: GetState,
    permissions: GetPermissionManager,
    Path(protocol): Path<String>,
    Query(params): Query<Params>,
) -> ApiResponseResult {
    permissions.has_admin_permission("databases-everywhere-nodes.read")?;
    let protocol = DatabaseProtocol::from_str(&protocol)
        .map_err(|_| DisplayError::new("unsupported database image registry"))?;
    let (namespace, repository, reference_repository) = repository(protocol);
    let page = params.page.unwrap_or(1).clamp(1, 10_000);
    let per_page = params.per_page.unwrap_or(50).clamp(1, 100);
    let url =
        format!("https://hub.docker.com/v2/namespaces/{namespace}/repositories/{repository}/tags");
    let response = state
        .client
        .get(url)
        .query(&[("page", page), ("page_size", per_page)])
        .timeout(Duration::from_secs(12))
        .send()
        .await
        .map_err(|error| registry_error(format!("Docker Hub could not be reached: {error}")))?;
    if !response.status().is_success() {
        return Err(registry_error(format!(
            "Docker Hub returned HTTP {} for this repository",
            response.status()
        ))
        .into());
    }
    let bytes = response.bytes().await.map_err(|error| {
        registry_error(format!("Docker Hub response could not be read: {error}"))
    })?;
    if bytes.len() > MAX_REGISTRY_RESPONSE_BYTES {
        return Err(registry_error("Docker Hub returned an unexpectedly large response").into());
    }
    let body: DockerHubResponse = serde_json::from_slice(&bytes)
        .map_err(|error| registry_error(format!("Docker Hub returned invalid JSON: {error}")))?;
    let images = body
        .results
        .into_iter()
        .filter(|tag| !tag.name.eq_ignore_ascii_case("latest"))
        .filter(|tag| protocol != DatabaseProtocol::Mysql || !mysql_nine_tag(&tag.name))
        .map(|tag| {
            let digest = tag
                .images
                .iter()
                .filter_map(|image| image.digest.as_deref())
                .find(|digest| digest.starts_with("sha256:"));
            RegistryImage {
                reference: format!("{reference_repository}:{}", tag.name),
                digest_reference: digest.map(|digest| format!("{reference_repository}@{digest}")),
                tag: tag.name,
                last_updated: tag.last_updated,
                size_bytes: tag.full_size,
            }
        })
        .collect();

    ApiResponse::new_serialized(Response {
        protocol,
        repository: reference_repository.to_owned(),
        page,
        per_page,
        total: body.count,
        has_next: body.next.is_some(),
        has_previous: body.previous.is_some(),
        images,
    })
    .ok()
}

fn repository(protocol: DatabaseProtocol) -> (&'static str, &'static str, &'static str) {
    match protocol {
        DatabaseProtocol::Postgres => ("library", "postgres", "postgres"),
        DatabaseProtocol::Mysql => ("library", "mysql", "mysql"),
        DatabaseProtocol::Mariadb => ("library", "mariadb", "mariadb"),
        DatabaseProtocol::Redis => ("library", "redis", "redis"),
        DatabaseProtocol::Valkey => ("valkey", "valkey", "valkey/valkey"),
        DatabaseProtocol::Mongodb => ("library", "mongo", "mongo"),
        DatabaseProtocol::Clickhouse => (
            "clickhouse",
            "clickhouse-server",
            "clickhouse/clickhouse-server",
        ),
        DatabaseProtocol::Qdrant => ("qdrant", "qdrant", "qdrant/qdrant"),
    }
}

fn mysql_nine_tag(tag: &str) -> bool {
    tag == "9" || tag.starts_with("9.") || tag.starts_with("9-")
}

fn registry_error(message: impl Into<String>) -> anyhow::Error {
    DisplayError::new(message.into())
        .with_status(axum::http::StatusCode::BAD_GATEWAY)
        .into()
}

pub fn router(state: &State) -> OpenApiRouter<State> {
    OpenApiRouter::new()
        .routes(routes!(get))
        .with_state(state.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_every_protocol_to_a_fixed_repository() {
        for protocol in DatabaseProtocol::ALL {
            let (namespace, repository, reference) = repository(protocol);
            assert!(!namespace.is_empty());
            assert!(!repository.is_empty());
            assert!(!reference.is_empty());
        }
    }

    #[test]
    fn filters_unsupported_mysql_nine_tags() {
        assert!(mysql_nine_tag("9"));
        assert!(mysql_nine_tag("9.4"));
        assert!(!mysql_nine_tag("8.4"));
    }
}
