use crate::persistence::NodeRecord;
use axum::http::StatusCode;
use reqwest::{Method, RequestBuilder, Response};
use serde::{Serialize, de::DeserializeOwned};
use shared::{State, response::DisplayError};
use std::time::Duration;

#[derive(Debug, Clone, serde::Deserialize, utoipa::ToSchema)]
struct DbevErrorBody {
    pub error: String,
    pub code: Option<String>,
    pub error_id: Option<String>,
}

#[derive(Clone)]
pub struct DbevClient {
    client: reqwest::Client,
    base_url: String,
    token: String,
    origin: Option<String>,
}

impl DbevClient {
    pub async fn for_node(state: &State, node: &NodeRecord) -> Result<Self, anyhow::Error> {
        let settings = state.settings.get().await?;
        let extension_settings = settings
            .get_extension_settings::<crate::settings::ExtensionSettingsData>(
                "com.tomaxikz.databaseseverywhere",
            )?;
        let origin = if extension_settings.panel_url.trim().is_empty() {
            settings.app.url.trim_end_matches('/').to_owned()
        } else {
            extension_settings
                .panel_url
                .trim_end_matches('/')
                .to_owned()
        };
        Ok(Self {
            client: state.client.clone(),
            base_url: node.api_url.trim_end_matches('/').to_owned(),
            token: node.decrypted_token(state).await?,
            origin: Some(origin),
        })
    }

    pub fn resolve_url(&self, path: &str) -> Result<String, anyhow::Error> {
        if !path.starts_with('/') || path.starts_with("//") {
            return Err(anyhow::anyhow!(
                "DatabasesEverywhere returned an invalid URL"
            ));
        }
        Ok(format!("{}{path}", self.base_url))
    }

    pub fn websocket_url(&self, path: &str) -> Result<String, anyhow::Error> {
        if !path.starts_with("/ws/") || path.starts_with("//") {
            return Err(anyhow::anyhow!(
                "refusing to build an invalid DatabasesEverywhere WebSocket URL"
            ));
        }

        let mut url = url::Url::parse(&self.base_url)
            .map_err(|_| anyhow::anyhow!("DatabasesEverywhere node has an invalid API URL"))?;
        let websocket_scheme = match url.scheme() {
            "http" => "ws",
            "https" => "wss",
            _ => {
                return Err(anyhow::anyhow!(
                    "DatabasesEverywhere API URL must use HTTP or HTTPS"
                ));
            }
        };
        url.set_scheme(websocket_scheme)
            .map_err(|_| anyhow::anyhow!("failed to build DatabasesEverywhere WebSocket URL"))?;
        url.set_path(path);
        url.set_query(None);
        url.set_fragment(None);
        Ok(url.to_string())
    }

    fn request(&self, method: Method, path: &str) -> Result<RequestBuilder, anyhow::Error> {
        if !path.starts_with("/api/") {
            return Err(anyhow::anyhow!(
                "refusing to call an invalid DatabasesEverywhere API path"
            ));
        }

        let mut request = self
            .client
            .request(method, self.resolve_url(path)?)
            .bearer_auth(&self.token)
            .timeout(Duration::from_secs(900));
        if let Some(origin) = &self.origin {
            request = request.header(reqwest::header::ORIGIN, origin);
        }
        Ok(request)
    }

    async fn send<B: Serialize + ?Sized>(
        &self,
        method: Method,
        path: &str,
        body: Option<&B>,
    ) -> Result<Response, anyhow::Error> {
        let mut request = self.request(method, path)?;
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request.send().await.map_err(Self::transport_error)?;
        if response.status().is_success() {
            return Ok(response);
        }

        Err(Self::response_error(response).await)
    }

    async fn response_error(response: Response) -> anyhow::Error {
        let status = response.status();
        let body = response.json::<DbevErrorBody>().await.ok();
        let message = if status == reqwest::StatusCode::INTERNAL_SERVER_ERROR {
            let mut message = "DatabasesEverywhere could not complete the request".to_owned();
            if let Some(error_id) = body.as_ref().and_then(|body| body.error_id.as_deref()) {
                message.push_str(&format!(" (error id: {error_id})"));
            }
            message
        } else {
            body.as_ref()
                .map(|body| {
                    let mut message = body.error.clone();
                    if let Some(code) = &body.code {
                        message.push_str(&format!(" [{code}]"));
                    }
                    if let Some(error_id) = &body.error_id {
                        message.push_str(&format!(" (error id: {error_id})"));
                    }
                    message
                })
                .unwrap_or_else(|| format!("DatabasesEverywhere returned HTTP {status}"))
        };
        let status = StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        DisplayError::new(message).with_status(status).into()
    }

    fn transport_error(error: reqwest::Error) -> anyhow::Error {
        if error.is_timeout() {
            DisplayError::new("the database host request timed out")
                .with_status(StatusCode::GATEWAY_TIMEOUT)
                .into()
        } else {
            DisplayError::new("Panel could not reach the database host")
                .with_status(StatusCode::BAD_GATEWAY)
                .into()
        }
    }

    async fn decode<T: DeserializeOwned>(response: Response) -> Result<T, anyhow::Error> {
        response.json::<T>().await.map_err(|error| {
            anyhow::Error::new(
                DisplayError::new(format!(
                    "DatabasesEverywhere returned an invalid response: {error}"
                ))
                .with_status(StatusCode::BAD_GATEWAY),
            )
        })
    }

    pub async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T, anyhow::Error> {
        const ATTEMPTS: usize = 3;
        for attempt in 0..ATTEMPTS {
            let response = self.request(Method::GET, path)?.send().await;
            match response {
                Ok(response) if response.status().is_success() => {
                    return Self::decode(response).await;
                }
                Ok(response)
                    if should_retry_request(Method::GET, response.status(), attempt, ATTEMPTS) =>
                {
                    // Only safe reads are replayed during a daemon restart.
                    drop(response);
                }
                Ok(response) => return Err(Self::response_error(response).await),
                Err(_error) if attempt + 1 < ATTEMPTS => {
                    tracing::debug!(attempt, "retrying safe DatabasesEverywhere GET");
                }
                Err(error) => return Err(Self::transport_error(error)),
            }
            tokio::time::sleep(get_retry_delay(attempt)).await;
        }
        unreachable!("bounded GET retry loop always returns")
    }

    pub async fn post<T: DeserializeOwned, B: Serialize + ?Sized>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<T, anyhow::Error> {
        Self::decode(self.send(Method::POST, path, Some(body)).await?).await
    }

    pub async fn post_accepted<T: DeserializeOwned, B: Serialize + ?Sized>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<T, anyhow::Error> {
        let response = self.send(Method::POST, path, Some(body)).await?;
        if response.status() != reqwest::StatusCode::ACCEPTED {
            return Err(anyhow::Error::new(
                DisplayError::new(format!(
                    "DatabasesEverywhere returned HTTP {}; expected HTTP 202",
                    response.status()
                ))
                .with_status(StatusCode::BAD_GATEWAY),
            ));
        }
        Self::decode(response).await
    }

    /// Streams an allow-listed raw upload to DBEV without replaying or buffering it.
    pub async fn post_import_upload<T: DeserializeOwned>(
        &self,
        path: &str,
        content_length: u64,
        encoded_filename: &str,
        sha256: Option<&str>,
        body: reqwest::Body,
    ) -> Result<T, anyhow::Error> {
        let request =
            self.import_upload_request(path, content_length, encoded_filename, sha256, body)?;

        let response = request.send().await.map_err(|error| {
            if error.is_timeout() {
                anyhow::Error::new(
                    DisplayError::new("upload stalled or exceeded its deadline")
                        .with_status(StatusCode::REQUEST_TIMEOUT),
                )
            } else {
                DisplayError::new("Panel could not reach the database host")
                    .with_status(StatusCode::BAD_GATEWAY)
                    .into()
            }
        })?;
        if !response.status().is_success() {
            return Err(Self::response_error(response).await);
        }
        if response.status() != reqwest::StatusCode::CREATED {
            return Err(anyhow::Error::new(
                DisplayError::new(format!(
                    "DatabasesEverywhere returned HTTP {}; expected HTTP 201",
                    response.status()
                ))
                .with_status(StatusCode::BAD_GATEWAY),
            ));
        }
        Self::decode(response).await
    }

    fn import_upload_request(
        &self,
        path: &str,
        content_length: u64,
        encoded_filename: &str,
        sha256: Option<&str>,
        body: reqwest::Body,
    ) -> Result<RequestBuilder, anyhow::Error> {
        let mut request = self
            .request(Method::POST, path)?
            .timeout(Duration::from_secs(3_600))
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
            .header(reqwest::header::CONTENT_LENGTH, content_length)
            .header("X-DBEV-Filename", encoded_filename)
            .body(body);
        if let Some(sha256) = sha256 {
            request = request.header("X-DBEV-SHA256", sha256);
        }
        Ok(request)
    }

    pub async fn patch<T: DeserializeOwned, B: Serialize + ?Sized>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<T, anyhow::Error> {
        Self::decode(self.send(Method::PATCH, path, Some(body)).await?).await
    }

    pub async fn delete<T: DeserializeOwned>(&self, path: &str) -> Result<T, anyhow::Error> {
        Self::decode(self.send::<()>(Method::DELETE, path, None).await?).await
    }

    pub async fn delete_success(&self, path: &str) -> Result<(), anyhow::Error> {
        self.send::<()>(Method::DELETE, path, None).await?;
        Ok(())
    }

    pub async fn delete_allow_not_found(
        &self,
        path: &str,
    ) -> Result<Option<serde_json::Value>, anyhow::Error> {
        if !path.starts_with("/api/") {
            return Err(anyhow::anyhow!(
                "refusing to call an invalid DatabasesEverywhere API path"
            ));
        }
        let mut request = self
            .client
            .delete(self.resolve_url(path)?)
            .bearer_auth(&self.token)
            .timeout(Duration::from_secs(900));
        if let Some(origin) = &self.origin {
            request = request.header(reqwest::header::ORIGIN, origin);
        }
        let response = request.send().await.map_err(Self::transport_error)?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(Self::response_error(response).await);
        }
        Ok(Some(Self::decode(response).await?))
    }

    pub async fn download_signed(&self, path: &str) -> Result<Response, anyhow::Error> {
        if !path.starts_with("/api/instances/")
            || !path.contains("/download?token=")
            || path.starts_with("//")
        {
            return Err(anyhow::anyhow!(
                "DatabasesEverywhere returned an invalid signed download URL"
            ));
        }
        let mut request = self
            .client
            .get(self.resolve_url(path)?)
            .timeout(Duration::from_secs(900));
        if let Some(origin) = &self.origin {
            request = request.header(reqwest::header::ORIGIN, origin);
        }
        let response = request.send().await.map_err(Self::transport_error)?;
        if response.status().is_success() {
            Ok(response)
        } else {
            Err(Self::response_error(response).await)
        }
    }
}

fn get_retry_delay(attempt: usize) -> Duration {
    Duration::from_millis((250_u64.saturating_mul(2_u64.saturating_pow(attempt as u32))).min(2_000))
}

fn should_retry_request(
    method: Method,
    status: reqwest::StatusCode,
    attempt: usize,
    attempts: usize,
) -> bool {
    method == Method::GET
        && status == reqwest::StatusCode::SERVICE_UNAVAILABLE
        && attempt + 1 < attempts
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::Stream;
    use std::{
        pin::Pin,
        sync::{
            Arc,
            atomic::{AtomicBool, AtomicUsize, Ordering},
        },
        task::{Context, Poll},
    };

    struct PendingUploadStream {
        polled: Arc<AtomicUsize>,
        dropped: Arc<AtomicBool>,
    }

    impl Stream for PendingUploadStream {
        type Item = Result<Vec<u8>, std::io::Error>;

        fn poll_next(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
            self.polled.fetch_add(1, Ordering::SeqCst);
            Poll::Pending
        }
    }

    impl Drop for PendingUploadStream {
        fn drop(&mut self) {
            self.dropped.store(true, Ordering::SeqCst);
        }
    }

    fn client(base_url: &str) -> DbevClient {
        DbevClient {
            client: reqwest::Client::new(),
            base_url: base_url.to_owned(),
            token: "test".to_owned(),
            origin: None,
        }
    }

    #[test]
    fn builds_browser_websocket_urls_from_the_trusted_node_origin() {
        assert_eq!(
            client("http://127.0.0.1:8090")
                .websocket_url("/ws/monitoring")
                .unwrap(),
            "ws://127.0.0.1:8090/ws/monitoring"
        );
        assert_eq!(
            client("https://db.example.test:9443/api?ignored=true")
                .websocket_url("/ws/instances/example/logs")
                .unwrap(),
            "wss://db.example.test:9443/ws/instances/example/logs"
        );
    }

    #[test]
    fn rejects_non_websocket_paths() {
        assert!(
            client("https://db.example.test")
                .websocket_url("//evil.test/ws")
                .is_err()
        );
        assert!(
            client("https://db.example.test")
                .websocket_url("/api/system")
                .is_err()
        );
    }

    #[test]
    fn safe_get_retry_backoff_is_bounded() {
        assert_eq!(get_retry_delay(0), Duration::from_millis(250));
        assert_eq!(get_retry_delay(1), Duration::from_millis(500));
        assert_eq!(get_retry_delay(20), Duration::from_millis(2_000));
    }

    #[test]
    fn non_idempotent_mutations_are_never_replayed() {
        for method in [Method::POST, Method::PATCH, Method::DELETE] {
            assert!(!should_retry_request(
                method,
                reqwest::StatusCode::SERVICE_UNAVAILABLE,
                0,
                3,
            ));
        }
        assert!(should_retry_request(
            Method::GET,
            reqwest::StatusCode::SERVICE_UNAVAILABLE,
            0,
            3,
        ));
        assert!(!should_retry_request(
            Method::GET,
            reqwest::StatusCode::CONFLICT,
            0,
            3,
        ));
    }

    #[test]
    fn raw_upload_request_forwards_only_the_contract_headers_and_server_credentials() {
        let request = client("https://db.example.test:9443")
            .import_upload_request(
                "/api/instances/instance-1/import",
                4_294_967_296,
                "tenant%20dump.sql",
                Some(&"a".repeat(64)),
                reqwest::Body::from("streamed"),
            )
            .unwrap()
            .build()
            .unwrap();
        assert_eq!(
            request.url().as_str(),
            "https://db.example.test:9443/api/instances/instance-1/import"
        );
        assert_eq!(
            request.headers()[reqwest::header::CONTENT_LENGTH],
            "4294967296"
        );
        assert_eq!(
            request.headers()[reqwest::header::CONTENT_TYPE],
            "application/octet-stream"
        );
        assert_eq!(request.headers()["X-DBEV-Filename"], "tenant%20dump.sql");
        assert_eq!(
            request.headers()["X-DBEV-SHA256"].to_str().unwrap(),
            "a".repeat(64).as_str()
        );
        assert_eq!(
            request.headers()[reqwest::header::AUTHORIZATION],
            "Bearer test"
        );
        assert!(
            request
                .headers()
                .get(reqwest::header::CONTENT_ENCODING)
                .is_none()
        );
    }

    #[test]
    fn multi_gibibyte_uploads_are_not_eagerly_buffered_and_drop_the_upstream_stream() {
        let polled = Arc::new(AtomicUsize::new(0));
        let dropped = Arc::new(AtomicBool::new(false));
        let body = reqwest::Body::wrap_stream(PendingUploadStream {
            polled: Arc::clone(&polled),
            dropped: Arc::clone(&dropped),
        });
        let request = client("https://db.example.test")
            .import_upload_request(
                "/api/instances/instance-1/import",
                8 * 1024 * 1024 * 1024,
                "large.sql",
                None,
                body,
            )
            .unwrap()
            .build()
            .unwrap();

        assert_eq!(polled.load(Ordering::SeqCst), 0);
        drop(request);
        assert!(dropped.load(Ordering::SeqCst));
    }
}
