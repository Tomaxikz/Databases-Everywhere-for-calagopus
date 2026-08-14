use crate::{
    dbev::DbevClient,
    persistence::{DatabaseRecord, NodeRecord},
};
use axum::body::Body;
use serde::Deserialize;
use shared::{State, response::ApiResponse};
use utoipa_axum::router::OpenApiRouter;

mod artifacts;
mod backups;
mod jobs;
mod uploads;

#[derive(Debug, Deserialize)]
struct DownloadTicket {
    url: String,
    #[serde(default)]
    single_use: Option<bool>,
}

pub fn router(state: &State) -> OpenApiRouter<State> {
    OpenApiRouter::new()
        .merge(jobs::router(state))
        .nest("/artifacts", artifacts::router(state))
        .nest("/backups", backups::router(state))
        .nest("/uploads", uploads::router(state))
        .with_state(state.clone())
}

pub(super) async fn client(
    state: &State,
    database: &DatabaseRecord,
) -> Result<DbevClient, anyhow::Error> {
    let node = NodeRecord::by_uuid(state, database.dbev_node_uuid)
        .await?
        .ok_or_else(|| anyhow::anyhow!("DatabasesEverywhere node no longer exists"))?;
    DbevClient::for_node(state, &node).await
}

pub(super) async fn mutation_client(
    state: &State,
    database: &DatabaseRecord,
) -> Result<DbevClient, anyhow::Error> {
    mutation_client_with_system(state, database)
        .await
        .map(|(client, _, _)| client)
}

pub(super) async fn mutation_client_with_system(
    state: &State,
    database: &DatabaseRecord,
) -> Result<(DbevClient, serde_json::Value, NodeRecord), anyhow::Error> {
    let node = NodeRecord::by_uuid(state, database.dbev_node_uuid)
        .await?
        .ok_or_else(|| anyhow::anyhow!("DatabasesEverywhere node no longer exists"))?;
    let (client, system) = DbevClient::for_mutation_with_system(state, &node).await?;
    Ok((client, system, node))
}

pub(super) fn validate_id(label: &str, value: &str) -> Result<(), anyhow::Error> {
    if value.is_empty()
        || value.len() > 255
        || value.contains("..")
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'-'))
    {
        return Err(
            shared::response::DisplayError::new(format!("invalid {label} identifier")).into(),
        );
    }
    Ok(())
}

pub(super) async fn proxy_download(
    state: &State,
    database: &DatabaseRecord,
    kind: &str,
    id: &str,
) -> Result<ApiResponse, anyhow::Error> {
    validate_id(kind, id)?;
    let client = mutation_client(state, database).await?;
    let instance_id = database.instance_id();
    let path = format!(
        "/api/instances/{}/{kind}/{}/download",
        urlencoding::encode(&instance_id),
        urlencoding::encode(id),
    );
    let ticket = client
        .post::<DownloadTicket, _>(
            &path,
            &serde_json::json!({ "expires_in_seconds": 120, "single_use": true }),
        )
        .await?;
    if ticket.single_use == Some(false) {
        return Err(anyhow::anyhow!(
            "DatabasesEverywhere returned a reusable ticket for a forced single-use download"
        ));
    }
    let signed_path = ticket.url;
    let expected_prefix = format!(
        "/api/instances/{}/{kind}/{}/download?token=",
        urlencoding::encode(&instance_id),
        urlencoding::encode(id),
    );
    if !signed_path.starts_with(&expected_prefix) {
        return Err(anyhow::anyhow!(
            "DatabasesEverywhere returned an invalid signed download URL"
        ));
    }
    let response = client.download_signed(&signed_path).await?;
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let content_disposition = response
        .headers()
        .get(reqwest::header::CONTENT_DISPOSITION)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let mut response = ApiResponse::new(Body::from_stream(response.bytes_stream()));
    if let Some(content_type) = content_type {
        response = response.with_header("content-type", content_type);
    }
    if let Some(content_disposition) = content_disposition {
        response = response.with_header("content-disposition", content_disposition);
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::DownloadTicket;

    #[test]
    fn download_ticket_parses_forced_single_use_and_legacy_responses() {
        let current: DownloadTicket = serde_json::from_value(serde_json::json!({
            "url": "/api/instances/example/artifacts/file/download?token=one-use",
            "single_use": true
        }))
        .unwrap();
        assert_eq!(current.single_use, Some(true));

        let legacy: DownloadTicket = serde_json::from_value(serde_json::json!({
            "url": "/api/instances/example/artifacts/file/download?token=legacy"
        }))
        .unwrap();
        assert_eq!(legacy.single_use, None);
    }
}
