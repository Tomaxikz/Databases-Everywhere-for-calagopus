use axum::http::{HeaderMap, StatusCode, header};
use serde::{Deserialize, Serialize};
use shared::response::DisplayError;
use std::collections::BTreeMap;
use utoipa::ToSchema;

pub const MAX_UPLOAD_BYTES: u64 = 8 * 1024 * 1024 * 1024;
pub const MAX_FILENAME_BYTES: usize = 180;
pub const CSRF_HEADER: &str = "x-calagopus-csrf";
pub const CSRF_VALUE: &str = "dbev-upload-v1";
pub const FILENAME_HEADER: &str = "x-calagopus-upload-filename";
pub const SHA256_HEADER: &str = "x-calagopus-upload-sha256";

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct TemporaryUpload {
    pub upload_id: String,
    pub instance_id: String,
    pub original_filename: String,
    pub protocol: String,
    pub archive_format: Option<String>,
    pub state: String,
    pub size_bytes: u64,
    pub sha256: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub expires_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schema(value_type = Option<serde_json::Value>)]
    pub catalog: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schema(value_type = Option<serde_json::Value>)]
    pub error: Option<serde_json::Value>,
    #[serde(flatten)]
    #[schema(value_type = BTreeMap<String, serde_json::Value>)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct LegacyStagedUpload {
    pub id: String,
    pub original_name: String,
    pub size_bytes: u64,
    pub modified_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct UploadListResponse {
    pub available: bool,
    /// Suppresses a rejected temporary-upload contract for the browser session.
    pub contract_mismatch: bool,
    pub reason: Option<String>,
    pub api_version: Option<String>,
    pub max_upload_bytes: u64,
    pub uploads: Vec<TemporaryUpload>,
    pub staged_uploads: Vec<LegacyStagedUpload>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct UploadResponse {
    pub upload: TemporaryUpload,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct CatalogResponse {
    pub catalog: DumpInspection,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct DumpInspection {
    pub protocol: String,
    pub sha256: String,
    pub source_size_bytes: u64,
    pub detected_archive_format: String,
    pub selection_kind: String,
    pub selective_supported: bool,
    #[serde(default)]
    pub catalog_complete: bool,
    #[serde(default)]
    pub namespaces: Vec<String>,
    pub objects: Vec<DumpObject>,
    pub unselectable_object_count: u64,
    pub selective_unavailable_reason: Option<String>,
    #[serde(flatten)]
    #[schema(value_type = BTreeMap<String, serde_json::Value>)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct DumpObject {
    pub kind: String,
    pub name: String,
    pub namespace: Option<String>,
    pub selection_key: String,
    #[serde(flatten)]
    #[schema(value_type = BTreeMap<String, serde_json::Value>)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct DeleteResponse {
    pub deleted: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub struct ValidatedUploadHeaders {
    pub content_length: u64,
    pub filename: String,
    pub encoded_filename: String,
    pub sha256: Option<String>,
}

pub fn validate_upload_headers(
    headers: &HeaderMap,
    max_upload_bytes: u64,
) -> Result<ValidatedUploadHeaders, anyhow::Error> {
    if header_text(headers, CSRF_HEADER)? != CSRF_VALUE {
        return Err(DisplayError::new("missing or invalid upload CSRF header")
            .with_status(StatusCode::FORBIDDEN)
            .into());
    }
    if header_text(headers, header::CONTENT_TYPE.as_str())? != "application/octet-stream" {
        return Err(
            DisplayError::new("upload content type must be application/octet-stream")
                .with_status(StatusCode::UNSUPPORTED_MEDIA_TYPE)
                .into(),
        );
    }
    if let Some(encoding) = optional_header_text(headers, header::CONTENT_ENCODING.as_str())?
        && !encoding.eq_ignore_ascii_case("identity")
    {
        return Err(
            DisplayError::new("compressed HTTP request bodies are not supported")
                .with_status(StatusCode::UNSUPPORTED_MEDIA_TYPE)
                .into(),
        );
    }

    let content_length = header_text(headers, header::CONTENT_LENGTH.as_str())?
        .parse::<u64>()
        .map_err(|_| DisplayError::new("an exact upload content length is required"))?;
    if content_length == 0 {
        return Err(DisplayError::new("the uploaded dump is empty").into());
    }
    if content_length > max_upload_bytes {
        return Err(DisplayError::new(format!(
            "dump exceeds the configured {max_upload_bytes}-byte upload limit"
        ))
        .with_status(StatusCode::PAYLOAD_TOO_LARGE)
        .into());
    }

    let browser_encoded_filename = header_text(headers, FILENAME_HEADER)?;
    let filename = urlencoding::decode(browser_encoded_filename)
        .map_err(|_| DisplayError::new("upload filename is not valid percent-encoded UTF-8"))?
        .into_owned();
    validate_upload_filename(&filename)?;
    let encoded_filename = urlencoding::encode(&filename).into_owned();

    let sha256 = optional_header_text(headers, SHA256_HEADER)?.map(str::to_owned);
    if let Some(sha256) = sha256.as_deref()
        && (sha256.len() != 64
            || !sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
    {
        return Err(DisplayError::new(
            "upload SHA-256 must be 64 lowercase hexadecimal characters",
        )
        .into());
    }

    Ok(ValidatedUploadHeaders {
        content_length,
        filename,
        encoded_filename,
        sha256,
    })
}

pub fn validate_upload_filename(filename: &str) -> Result<(), anyhow::Error> {
    if filename.is_empty()
        || filename.as_bytes().len() > MAX_FILENAME_BYTES
        || matches!(filename, "." | "..")
        || filename.contains('/')
        || filename.contains('\\')
        || filename.chars().any(char::is_control)
    {
        return Err(DisplayError::new("invalid flat dump filename").into());
    }
    if !has_allowed_extension(filename) {
        return Err(DisplayError::new(
            "unsupported dump type; use SQL, dump, snapshot, gzip, bzip2, tar, or zip",
        )
        .into());
    }
    Ok(())
}

pub fn has_allowed_extension(filename: &str) -> bool {
    let filename = filename.to_ascii_lowercase();
    [
        ".sql",
        ".dump",
        ".backup",
        ".archive",
        ".archive.gz",
        ".snapshot",
        ".tar.gz",
        ".tgz",
        ".tar",
        ".zip",
        ".gz",
        ".gzip",
        ".bz2",
        ".bzip2",
    ]
    .iter()
    .any(|suffix| filename.ends_with(suffix))
}

fn header_text<'a>(headers: &'a HeaderMap, name: &str) -> Result<&'a str, anyhow::Error> {
    optional_header_text(headers, name)?.ok_or_else(|| {
        DisplayError::new(format!("required upload header {name} is missing")).into()
    })
}

fn optional_header_text<'a>(
    headers: &'a HeaderMap,
    name: &str,
) -> Result<Option<&'a str>, anyhow::Error> {
    let mut values = headers.get_all(name).iter();
    let Some(first) = values.next() else {
        return Ok(None);
    };
    if values.next().is_some() {
        return Err(DisplayError::new(format!("upload header {name} must occur once")).into());
    }
    Ok(Some(first.to_str().map_err(|_| {
        DisplayError::new(format!("upload header {name} is invalid"))
    })?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn valid_headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(CSRF_HEADER, HeaderValue::from_static(CSRF_VALUE));
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/octet-stream"),
        );
        headers.insert(header::CONTENT_LENGTH, HeaderValue::from_static("12345"));
        headers.insert(
            FILENAME_HEADER,
            HeaderValue::from_static("tenant%20dump.sql"),
        );
        headers
    }

    #[test]
    fn validates_exact_stream_headers_without_reading_a_body() {
        let parsed = validate_upload_headers(&valid_headers(), MAX_UPLOAD_BYTES).unwrap();
        assert_eq!(parsed.content_length, 12_345);
        assert_eq!(parsed.filename, "tenant dump.sql");
        assert_eq!(parsed.encoded_filename, "tenant%20dump.sql");
    }

    #[test]
    fn rejects_csrf_length_encoding_and_unsafe_filename_before_streaming() {
        let mut missing_csrf = valid_headers();
        missing_csrf.remove(CSRF_HEADER);
        assert!(validate_upload_headers(&missing_csrf, MAX_UPLOAD_BYTES).is_err());

        let mut missing_length = valid_headers();
        missing_length.remove(header::CONTENT_LENGTH);
        assert!(validate_upload_headers(&missing_length, MAX_UPLOAD_BYTES).is_err());

        let mut duplicate_length = valid_headers();
        duplicate_length.append(header::CONTENT_LENGTH, HeaderValue::from_static("12345"));
        assert!(validate_upload_headers(&duplicate_length, MAX_UPLOAD_BYTES).is_err());

        for length in ["0", "unknown", "8589934593"] {
            let mut headers = valid_headers();
            headers.insert(
                header::CONTENT_LENGTH,
                HeaderValue::from_str(length).unwrap(),
            );
            assert!(
                validate_upload_headers(&headers, MAX_UPLOAD_BYTES).is_err(),
                "{length}"
            );
        }

        for filename in ["..%2Fsecret.sql", "%2Fetc%2Fpasswd.sql", "dump.exe"] {
            let mut headers = valid_headers();
            headers.insert(FILENAME_HEADER, HeaderValue::from_str(filename).unwrap());
            assert!(
                validate_upload_headers(&headers, MAX_UPLOAD_BYTES).is_err(),
                "{filename}"
            );
        }

        let mut boundary_filename = valid_headers();
        boundary_filename.insert(
            FILENAME_HEADER,
            HeaderValue::from_str(&format!("{}.sql", "a".repeat(MAX_FILENAME_BYTES - 4))).unwrap(),
        );
        assert!(validate_upload_headers(&boundary_filename, MAX_UPLOAD_BYTES).is_ok());

        let mut long_filename = valid_headers();
        long_filename.insert(
            FILENAME_HEADER,
            HeaderValue::from_str(&format!("{}.sql", "a".repeat(MAX_FILENAME_BYTES))).unwrap(),
        );
        assert!(validate_upload_headers(&long_filename, MAX_UPLOAD_BYTES).is_err());

        let mut compressed = valid_headers();
        compressed.insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
        assert!(validate_upload_headers(&compressed, MAX_UPLOAD_BYTES).is_err());

        let mut multipart = valid_headers();
        multipart.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("multipart/form-data; boundary=not-forwarded"),
        );
        assert!(validate_upload_headers(&multipart, MAX_UPLOAD_BYTES).is_err());
    }

    #[test]
    fn accepts_only_lowercase_sha256() {
        let mut headers = valid_headers();
        headers.insert(
            SHA256_HEADER,
            HeaderValue::from_str(&"a".repeat(64)).unwrap(),
        );
        assert!(validate_upload_headers(&headers, MAX_UPLOAD_BYTES).is_ok());
        headers.insert(
            SHA256_HEADER,
            HeaderValue::from_str(&"A".repeat(64)).unwrap(),
        );
        assert!(validate_upload_headers(&headers, MAX_UPLOAD_BYTES).is_err());
    }
}
