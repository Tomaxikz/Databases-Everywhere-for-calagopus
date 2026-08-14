use std::net::IpAddr;

use serde::{Deserialize, Serialize};
use shared::response::DisplayError;
use utoipa::ToSchema;

const PROTOCOLS: [&str; 8] = [
    "postgres",
    "mysql",
    "mariadb",
    "redis",
    "valkey",
    "mongodb",
    "clickhouse",
    "qdrant",
];

#[derive(Debug, Clone, Default, Deserialize, ToSchema)]
pub struct NodeConfigurationSecretsPatch {
    pub s3_access_key_id: Option<String>,
    pub s3_secret_access_key: Option<String>,
    pub s3_session_token: Option<String>,
    pub kopia_repository_password: Option<String>,
    #[serde(default)]
    pub clear_s3_credentials: bool,
    #[serde(default)]
    pub clear_kopia_repository_password: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NodeConfigurationSecrets {
    pub s3_access_key_id: String,
    pub s3_secret_access_key: String,
    pub s3_session_token: String,
    pub kopia_repository_password: String,
}

impl NodeConfigurationSecrets {
    pub fn is_empty(&self) -> bool {
        self.s3_access_key_id.is_empty()
            && self.s3_secret_access_key.is_empty()
            && self.s3_session_token.is_empty()
            && self.kopia_repository_password.is_empty()
    }

    pub fn overlay_non_empty(&mut self, other: Self) {
        for (target, value) in [
            (&mut self.s3_access_key_id, other.s3_access_key_id),
            (&mut self.s3_secret_access_key, other.s3_secret_access_key),
            (&mut self.s3_session_token, other.s3_session_token),
            (
                &mut self.kopia_repository_password,
                other.kopia_repository_password,
            ),
        ] {
            if !value.trim().is_empty() {
                *target = value;
            }
        }
    }

    pub fn apply_patch(&mut self, patch: Option<NodeConfigurationSecretsPatch>) {
        let Some(patch) = patch else { return };
        if patch.clear_s3_credentials {
            self.s3_access_key_id.clear();
            self.s3_secret_access_key.clear();
            self.s3_session_token.clear();
        }
        if patch.clear_kopia_repository_password {
            self.kopia_repository_password.clear();
        }
        for (target, value) in [
            (&mut self.s3_access_key_id, patch.s3_access_key_id),
            (&mut self.s3_secret_access_key, patch.s3_secret_access_key),
            (&mut self.s3_session_token, patch.s3_session_token),
            (
                &mut self.kopia_repository_password,
                patch.kopia_repository_password,
            ),
        ] {
            if let Some(value) = value.filter(|value| !value.trim().is_empty()) {
                *target = value;
            }
        }
    }
}

pub fn normalize_daemon_configuration(
    mut configuration: serde_json::Value,
) -> Result<(serde_json::Value, NodeConfigurationSecrets), anyhow::Error> {
    if !configuration.is_object() {
        return Err(DisplayError::new("node configuration must be a JSON object").into());
    }

    for protected in ["remote", "uuid", "token_id", "token", "jwt_signing_key"] {
        configuration.as_object_mut().unwrap().remove(protected);
    }
    // Preserve absent v0.5.2 keys when editing an older stored configuration.
    let existing_artifacts = configuration
        .get("artifacts")
        .and_then(serde_json::Value::as_object);
    let preserve_missing_stream_exports_only =
        existing_artifacts.is_some_and(|artifacts| !artifacts.contains_key("stream_exports_only"));
    let preserve_missing_max_artifacts_per_instance = existing_artifacts
        .is_some_and(|artifacts| !artifacts.contains_key("max_artifacts_per_instance"));
    let embedded_secrets = take_embedded_secrets(&mut configuration);
    let mut normalized = default_daemon_configuration();
    merge_configuration(&mut normalized, &configuration);
    if let Some(artifacts) = normalized
        .get_mut("artifacts")
        .and_then(serde_json::Value::as_object_mut)
    {
        if preserve_missing_stream_exports_only {
            artifacts.remove("stream_exports_only");
        }
        if preserve_missing_max_artifacts_per_instance {
            artifacts.remove("max_artifacts_per_instance");
        }
    }
    normalize_legacy_disk_mode(&mut normalized);
    normalize_legacy_logs_path(&mut normalized);
    validate_daemon_configuration(&normalized)?;
    Ok((normalized, embedded_secrets))
}

fn normalize_legacy_disk_mode(configuration: &mut serde_json::Value) {
    if configuration
        .pointer("/disk/mode")
        .and_then(serde_json::Value::as_str)
        == Some("none")
        && let Some(mode) = configuration.pointer_mut("/disk/mode")
    {
        *mode = serde_json::Value::String("soft_scanner".to_owned());
    }
}

fn normalize_legacy_logs_path(configuration: &mut serde_json::Value) {
    if configuration
        .pointer("/paths/logs")
        .and_then(serde_json::Value::as_str)
        == Some("/var/log/dbev")
        && let Some(logs) = configuration.pointer_mut("/paths/logs")
    {
        *logs = serde_json::Value::String("/var/lib/dbev/logs".to_owned());
    }
}

pub fn public_daemon_configuration(configuration: &serde_json::Value) -> serde_json::Value {
    let mut public = configuration.clone();
    take_embedded_secrets(&mut public);
    for protected in ["remote", "uuid", "token_id", "token", "jwt_signing_key"] {
        if let Some(object) = public.as_object_mut() {
            object.remove(protected);
        }
    }
    public
}

pub fn apply_configuration_secrets(
    configuration: &mut serde_json::Value,
    secrets: &NodeConfigurationSecrets,
) {
    set_nested_string(
        configuration,
        &["backups", "storage", "s3", "access_key_id"],
        &secrets.s3_access_key_id,
    );
    set_nested_string(
        configuration,
        &["backups", "storage", "s3", "secret_access_key"],
        &secrets.s3_secret_access_key,
    );
    set_nested_string(
        configuration,
        &["backups", "storage", "s3", "session_token"],
        &secrets.s3_session_token,
    );
    set_nested_string(
        configuration,
        &["backups", "storage", "kopia", "repository_password"],
        &secrets.kopia_repository_password,
    );
}

fn take_embedded_secrets(configuration: &mut serde_json::Value) -> NodeConfigurationSecrets {
    NodeConfigurationSecrets {
        s3_access_key_id: take_nested_string(
            configuration,
            &["backups", "storage", "s3", "access_key_id"],
        ),
        s3_secret_access_key: take_nested_string(
            configuration,
            &["backups", "storage", "s3", "secret_access_key"],
        ),
        s3_session_token: take_nested_string(
            configuration,
            &["backups", "storage", "s3", "session_token"],
        ),
        kopia_repository_password: take_nested_string(
            configuration,
            &["backups", "storage", "kopia", "repository_password"],
        ),
    }
}

pub(super) fn embedded_configuration_secrets(
    configuration: &serde_json::Value,
) -> NodeConfigurationSecrets {
    let mut configuration = configuration.clone();
    take_embedded_secrets(&mut configuration)
}

fn take_nested_string(value: &mut serde_json::Value, path: &[&str]) -> String {
    let Some((leaf, parents)) = path.split_last() else {
        return String::new();
    };
    let mut current = value;
    for parent in parents {
        let Some(next) = current.get_mut(*parent) else {
            return String::new();
        };
        current = next;
    }
    let Some(slot) = current.get_mut(*leaf) else {
        return String::new();
    };
    let secret = slot.as_str().unwrap_or_default().to_owned();
    *slot = serde_json::Value::String(String::new());
    secret
}

fn set_nested_string(value: &mut serde_json::Value, path: &[&str], replacement: &str) {
    let Some((leaf, parents)) = path.split_last() else {
        return;
    };
    let mut current = value;
    for parent in parents {
        let Some(next) = current.get_mut(*parent) else {
            return;
        };
        current = next;
    }
    if let Some(object) = current.as_object_mut() {
        object.insert(
            (*leaf).to_owned(),
            serde_json::Value::String(replacement.to_owned()),
        );
    }
}

fn merge_configuration(target: &mut serde_json::Value, source: &serde_json::Value) {
    match (target, source) {
        (serde_json::Value::Object(target), serde_json::Value::Object(source)) => {
            for (key, value) in source {
                if let Some(existing) = target.get_mut(key) {
                    merge_configuration(existing, value);
                } else {
                    target.insert(key.clone(), value.clone());
                }
            }
        }
        (target, source) => *target = source.clone(),
    }
}

fn validate_daemon_configuration(configuration: &serde_json::Value) -> Result<(), anyhow::Error> {
    required_string(configuration, "/api/host", "daemon API host")?;
    bounded_integer(configuration, "/api/port", "daemon API port", 1, 65_535)?;
    let api_ssl_enabled = required_bool(configuration, "/api/ssl/enabled", "API TLS")?;
    if api_ssl_enabled {
        absolute_path(configuration, "/api/ssl/cert", "API TLS certificate")?;
        absolute_path(configuration, "/api/ssl/key", "API TLS private key")?;
    }
    let require_client_certificate = required_bool(
        configuration,
        "/api/ssl/require_client_cert",
        "client certificate requirement",
    )?;
    if require_client_certificate && !api_ssl_enabled {
        return Err(
            DisplayError::new("client-certificate enforcement requires native API TLS").into(),
        );
    }
    if require_client_certificate {
        absolute_path(configuration, "/api/ssl/client_ca", "client certificate CA")?;
    }
    let trusted_hosts = configuration
        .pointer("/api/trusted_hosts")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| DisplayError::new("trusted API hosts must be an array"))?;
    if trusted_hosts.len() > 100
        || trusted_hosts.iter().any(|host| {
            host.as_str()
                .is_none_or(|host| host.trim().is_empty() || host.chars().any(char::is_whitespace))
        })
    {
        return Err(DisplayError::new("trusted API hosts contain an invalid hostname").into());
    }
    let trusted_origins = configuration
        .pointer("/api/trusted_origins")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| DisplayError::new("trusted API origins must be an array"))?;
    if trusted_origins.len() > 100
        || trusted_origins.iter().any(|origin| {
            origin
                .as_str()
                .is_none_or(|origin| !valid_http_origin(origin))
        })
    {
        return Err(DisplayError::new(
            "trusted API origins must be complete HTTP(S) origins without paths, queries, fragments, or credentials",
        )
        .into());
    }

    let mut enabled_gateway_binds = std::collections::HashSet::new();
    let mut protocol_tls_enabled = false;
    for protocol in PROTOCOLS {
        let section = configuration
            .get(protocol)
            .and_then(serde_json::Value::as_object)
            .ok_or_else(|| DisplayError::new(format!("missing {protocol} configuration")))?;
        let enabled = section
            .get("enabled")
            .and_then(serde_json::Value::as_bool)
            .ok_or_else(|| DisplayError::new(format!("invalid {protocol} enabled setting")))?;
        let tls = section
            .get("tls")
            .and_then(serde_json::Value::as_bool)
            .ok_or_else(|| DisplayError::new(format!("invalid {protocol} TLS setting")))?;
        protocol_tls_enabled |= enabled && tls;
        let bind = section
            .get("bind")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| DisplayError::new(format!("invalid {protocol} gateway bind")))?;
        let (bind_identity, native_port) = validate_bind(protocol, bind)?;
        if enabled && !enabled_gateway_binds.insert(bind_identity) {
            return Err(DisplayError::new(format!(
                "enabled {protocol} gateway duplicates another bind address and port"
            ))
            .into());
        }
        if protocol == "clickhouse" {
            let (http_bind_identity, http_port) = validate_bind(
                "ClickHouse HTTP",
                section
                    .get("http_bind")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| DisplayError::new("invalid ClickHouse HTTP gateway bind"))?,
            )?;
            if native_port == http_port {
                return Err(DisplayError::new(
                    "ClickHouse native and HTTP gateway ports must be different",
                )
                .into());
            }
            if enabled && !enabled_gateway_binds.insert(http_bind_identity) {
                return Err(DisplayError::new(
                    "enabled ClickHouse HTTP gateway duplicates another bind address and port",
                )
                .into());
            }
        }
    }
    if protocol_tls_enabled {
        absolute_path(configuration, "/tls/cert", "database TLS certificate")?;
        absolute_path(configuration, "/tls/key", "database TLS private key")?;
    }

    let daemon_engine = configuration
        .pointer("/daemon/engine")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    if !matches!(daemon_engine, "docker" | "podman") {
        return Err(DisplayError::new("daemon engine must be docker or podman").into());
    }

    let storage_driver = configuration
        .pointer("/backups/storage/driver")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    if !matches!(storage_driver, "local" | "s3" | "kopia") {
        return Err(DisplayError::new("backup storage driver must be local, s3, or kopia").into());
    }
    let backups_enabled = required_bool(configuration, "/backups/enabled", "automated backups")?;
    bounded_integer(
        configuration,
        "/backups/interval_minutes",
        "backup interval",
        1,
        525_600,
    )?;
    bounded_integer(
        configuration,
        "/backups/retention_keep_latest_per_instance",
        "backup retention count",
        1,
        100_000,
    )?;
    bounded_integer(
        configuration,
        "/backups/retention_max_age_days",
        "backup retention age",
        0,
        36_500,
    )?;
    if backups_enabled && storage_driver == "s3" {
        required_string(configuration, "/backups/storage/s3/bucket", "S3 bucket")?;
        let endpoint = configuration
            .pointer("/backups/storage/s3/endpoint")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .trim();
        if !endpoint.is_empty() {
            let endpoint = url::Url::parse(endpoint)
                .map_err(|_| DisplayError::new("S3 endpoint must be a valid HTTP(S) URL"))?;
            if !matches!(endpoint.scheme(), "http" | "https") {
                return Err(DisplayError::new("S3 endpoint must use HTTP or HTTPS").into());
            }
            let allow_http = required_bool(
                configuration,
                "/backups/storage/s3/allow_http",
                "S3 HTTP opt-in",
            )?;
            if endpoint.scheme() == "http" && !allow_http {
                return Err(DisplayError::new(
                    "plaintext S3 endpoints require the allow HTTP option",
                )
                .into());
            }
        }
    }
    if backups_enabled && storage_driver == "kopia" {
        absolute_path(
            configuration,
            "/backups/storage/kopia/executable",
            "Kopia executable",
        )?;
        optional_absolute_path(
            configuration,
            "/backups/storage/kopia/config_file",
            "Kopia configuration",
        )?;
    }

    validate_artifact_configuration(configuration)?;

    for protocol in PROTOCOLS {
        let image = configuration
            .pointer(&format!("/images/{protocol}"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        validate_image(protocol, image)?;
        let allowed = configuration
            .pointer(&format!("/images/allowed/{protocol}"))
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| DisplayError::new(format!("missing allowed {protocol} images")))?;
        if allowed.is_empty() || allowed.len() > 100 {
            return Err(DisplayError::new(format!(
                "{protocol} must have between 1 and 100 allowed images"
            ))
            .into());
        }
        let mut default_is_allowed = false;
        for image in allowed {
            let image = image
                .as_str()
                .ok_or_else(|| DisplayError::new(format!("invalid allowed {protocol} image")))?;
            validate_image(protocol, image)?;
            default_is_allowed |= image
                == configuration
                    .pointer(&format!("/images/{protocol}"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default();
            if protocol == "mysql" && is_mysql_nine_image(image) {
                return Err(DisplayError::new(
                    "MySQL 9.x is not supported; use the MySQL 8.4 LTS image",
                )
                .into());
            }
        }
        if !default_is_allowed {
            return Err(DisplayError::new(format!(
                "the default {protocol} image must also appear in its allowed image list"
            ))
            .into());
        }
        if protocol == "mysql" && is_mysql_nine_image(image) {
            return Err(DisplayError::new(
                "MySQL 9.x is not supported; use the MySQL 8.4 LTS image",
            )
            .into());
        }
    }

    for (pointer, label) in [
        ("/paths/data", "data"),
        ("/paths/metadata", "metadata"),
        ("/paths/volumes", "volumes"),
        ("/paths/backups", "backups"),
        ("/paths/sockets", "sockets"),
        ("/paths/locks", "locks"),
        ("/paths/logs", "logs"),
        ("/paths/artifacts", "artifacts"),
        ("/paths/exports", "exports"),
        ("/paths/imports", "imports"),
        ("/paths/fuse", "FUSE"),
        ("/paths/tmp", "temporary"),
    ] {
        absolute_path(configuration, pointer, &format!("{label} path"))?;
    }
    for (pointer, label, minimum, maximum) in [
        (
            "/security/api_body_limit_bytes",
            "API body limit",
            1,
            u64::MAX,
        ),
        (
            "/security/api_rate_limit_per_minute",
            "API rate limit",
            1,
            u64::MAX,
        ),
        (
            "/security/db_connection_limit_per_minute",
            "database connection rate limit",
            1,
            u64::MAX,
        ),
        ("/security/pids_limit", "PID limit", 1, u64::MAX),
    ] {
        bounded_integer(configuration, pointer, label, minimum, maximum)?;
    }
    let self_upgrade_enabled = required_bool(
        configuration,
        "/security/self_upgrade_enabled",
        "API self-upgrade setting",
    )?;
    if self_upgrade_enabled {
        return Err(DisplayError::new(
            "DBEV API self-upgrade is unsupported; leave it disabled and deploy upgrades through a signed package or immutable container image",
        )
        .into());
    }
    for protocol in PROTOCOLS {
        nullable_positive_integer(
            configuration,
            &format!("/security/pids_limits/{protocol}"),
            &format!("{protocol} PID override"),
        )?;
    }
    validate_remote_import_security(configuration)?;
    nullable_positive_integer(
        configuration,
        "/allocation/max_memory_mib",
        "maximum memory",
    )?;
    nullable_positive_integer(configuration, "/allocation/max_disk_mib", "maximum disk")?;
    required_bool(
        configuration,
        "/allocation/prevent_cpu_overallocation",
        "CPU overallocation prevention",
    )?;
    required_bool(
        configuration,
        "/allocation/prevent_memory_overallocation",
        "memory overallocation prevention",
    )?;
    required_bool(
        configuration,
        "/allocation/prevent_disk_overallocation",
        "disk overallocation prevention",
    )?;
    bounded_integer(
        configuration,
        "/allocation/reserved_memory_mib",
        "reserved memory",
        0,
        1_048_576,
    )?;
    bounded_integer(
        configuration,
        "/allocation/reserved_disk_mib",
        "reserved disk",
        0,
        u64::MAX,
    )?;

    let fuse_binary =
        required_string(configuration, "/disk/fuse_quota_binary", "FuseQuota binary")?;
    if fuse_binary != "embedded" && !fuse_binary.starts_with('/') {
        return Err(
            DisplayError::new("FuseQuota binary must be 'embedded' or an absolute path").into(),
        );
    }
    let fuse_digest = configuration
        .pointer("/disk/fuse_quota_binary_sha256")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| DisplayError::new("invalid FuseQuota SHA-256"))?;
    if !fuse_digest.is_empty()
        && (fuse_digest.len() != 64
            || !fuse_digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')))
    {
        return Err(DisplayError::new(
            "FuseQuota SHA-256 must be empty or 64 lowercase hexadecimal characters",
        )
        .into());
    }
    bounded_integer(
        configuration,
        "/disk/fuse_quota_rescan_interval_seconds",
        "FuseQuota rescan interval",
        1,
        86_400,
    )?;
    bounded_integer(
        configuration,
        "/disk/project_id_base",
        "project quota ID base",
        1,
        2_147_000_000,
    )?;
    let disk_mode = required_string(configuration, "/disk/mode", "disk quota mode")?;
    if !matches!(
        disk_mode,
        "auto" | "project_quota" | "fuse_quota" | "soft_scanner"
    ) {
        return Err(DisplayError::new(
            "disk quota mode must be auto, project_quota, fuse_quota, or soft_scanner",
        )
        .into());
    }
    for (pointer, label, minimum, maximum) in [
        (
            "/disk/soft_scanner/scan_interval_seconds",
            "soft scanner interval",
            1,
            3_600,
        ),
        (
            "/disk/soft_scanner/full_scan_interval_seconds",
            "soft scanner full-scan interval",
            1,
            3_600,
        ),
        (
            "/disk/soft_scanner/inotify_debounce_milliseconds",
            "soft scanner filesystem-event debounce",
            1,
            60_000,
        ),
        (
            "/disk/soft_scanner/max_dirty_paths_per_instance",
            "soft scanner dirty-path limit",
            1,
            65_536,
        ),
        (
            "/disk/soft_scanner/max_concurrent_scans",
            "soft scanner concurrency",
            1,
            64,
        ),
        (
            "/disk/soft_scanner/max_entries_per_scan",
            "soft scanner entry limit",
            1,
            10_000_000,
        ),
        (
            "/disk/soft_scanner/scan_timeout_seconds",
            "soft scanner timeout",
            1,
            3_600,
        ),
        (
            "/disk/soft_scanner/max_consecutive_scan_failures",
            "soft scanner failure limit",
            1,
            10,
        ),
        (
            "/disk/soft_scanner/safety_reserve_mib",
            "soft scanner safety reserve",
            0,
            u64::MAX,
        ),
        (
            "/disk/soft_scanner/recovery_percent",
            "soft scanner recovery percentage",
            1,
            99,
        ),
        (
            "/disk/soft_scanner/shutdown_grace_seconds",
            "soft scanner shutdown grace period",
            1,
            300,
        ),
    ] {
        bounded_integer(configuration, pointer, label, minimum, maximum)?;
    }
    required_bool(
        configuration,
        "/disk/soft_scanner/use_inotify",
        "soft scanner filesystem-event acceleration",
    )?;

    Ok(())
}

fn required_string<'a>(
    configuration: &'a serde_json::Value,
    pointer: &str,
    label: &str,
) -> Result<&'a str, anyhow::Error> {
    configuration
        .pointer(pointer)
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| DisplayError::new(format!("{label} is required")).into())
}

fn optional_bool(
    configuration: &serde_json::Value,
    pointer: &str,
    label: &str,
) -> Result<(), anyhow::Error> {
    if configuration
        .pointer(pointer)
        .is_some_and(|value| !value.is_boolean())
    {
        return Err(DisplayError::new(format!("{label} must be true or false")).into());
    }
    Ok(())
}

fn optional_bounded_integer(
    configuration: &serde_json::Value,
    pointer: &str,
    label: &str,
    minimum: u64,
    maximum: u64,
) -> Result<(), anyhow::Error> {
    let Some(value) = configuration.pointer(pointer) else {
        return Ok(());
    };
    let value = value.as_u64().ok_or_else(|| {
        DisplayError::new(format!(
            "{label} must be an integer from {minimum} through {maximum}"
        ))
    })?;
    if !(minimum..=maximum).contains(&value) {
        return Err(
            DisplayError::new(format!("{label} must be from {minimum} through {maximum}")).into(),
        );
    }
    Ok(())
}

fn valid_http_origin(value: &str) -> bool {
    let Ok(url) = url::Url::parse(value.trim()) else {
        return false;
    };
    matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(url.path(), "" | "/")
        && url.query().is_none()
        && url.fragment().is_none()
        && url.port_or_known_default().is_some()
}

fn required_bool(
    configuration: &serde_json::Value,
    pointer: &str,
    label: &str,
) -> Result<bool, anyhow::Error> {
    configuration
        .pointer(pointer)
        .and_then(serde_json::Value::as_bool)
        .ok_or_else(|| DisplayError::new(format!("{label} must be true or false")).into())
}

fn bounded_integer(
    configuration: &serde_json::Value,
    pointer: &str,
    label: &str,
    minimum: u64,
    maximum: u64,
) -> Result<u64, anyhow::Error> {
    configuration
        .pointer(pointer)
        .and_then(serde_json::Value::as_u64)
        .filter(|value| *value >= minimum && *value <= maximum)
        .ok_or_else(|| {
            DisplayError::new(format!(
                "{label} must be an integer between {minimum} and {maximum}"
            ))
            .into()
        })
}

fn nullable_positive_integer(
    configuration: &serde_json::Value,
    pointer: &str,
    label: &str,
) -> Result<(), anyhow::Error> {
    let value = configuration
        .pointer(pointer)
        .ok_or_else(|| DisplayError::new(format!("{label} is required")))?;
    if value.is_null() || value.as_u64().is_some_and(|value| value > 0) {
        Ok(())
    } else {
        Err(DisplayError::new(format!("{label} must be null or a positive integer")).into())
    }
}

fn validate_artifact_configuration(configuration: &serde_json::Value) -> Result<(), anyhow::Error> {
    optional_bool(
        configuration,
        "/artifacts/stream_exports_only",
        "one-use export policy",
    )?;
    optional_bounded_integer(
        configuration,
        "/artifacts/max_artifacts_per_instance",
        "maximum artifacts per database",
        1,
        10_000,
    )?;
    bounded_integer(
        configuration,
        "/artifacts/retention_keep_latest",
        "artifact retention count",
        1,
        u64::MAX,
    )?;
    let max_upload_bytes = bounded_integer(
        configuration,
        "/artifacts/import_upload_max_bytes",
        "maximum temporary upload size",
        1,
        8 * 1024 * 1024 * 1024,
    )?;
    let max_total_bytes = bounded_integer(
        configuration,
        "/artifacts/import_upload_max_total_bytes",
        "total temporary upload capacity",
        1,
        i64::MAX as u64,
    )?;
    if max_total_bytes < max_upload_bytes {
        return Err(DisplayError::new(
            "total temporary upload capacity must be at least the per-upload size limit",
        )
        .into());
    }
    for (pointer, label, minimum, maximum) in [
        (
            "/artifacts/import_upload_max_per_instance",
            "temporary uploads per database",
            1,
            64,
        ),
        (
            "/artifacts/import_upload_max_concurrent",
            "concurrent temporary uploads",
            1,
            32,
        ),
        (
            "/artifacts/import_upload_ttl_hours",
            "temporary upload lifetime",
            1,
            168,
        ),
    ] {
        bounded_integer(configuration, pointer, label, minimum, maximum)?;
    }
    let total_timeout = bounded_integer(
        configuration,
        "/artifacts/import_upload_timeout_seconds",
        "temporary upload total timeout",
        60,
        86_400,
    )?;
    let idle_timeout = bounded_integer(
        configuration,
        "/artifacts/import_upload_idle_timeout_seconds",
        "temporary upload idle timeout",
        5,
        300,
    )?;
    if idle_timeout > total_timeout {
        return Err(DisplayError::new(
            "temporary upload idle timeout cannot exceed the total upload timeout",
        )
        .into());
    }
    validate_import_export_scheduler(configuration)
}

fn validate_remote_import_security(configuration: &serde_json::Value) -> Result<(), anyhow::Error> {
    required_bool(
        configuration,
        "/security/remote_import/enabled",
        "remote database imports",
    )?;
    required_bool(
        configuration,
        "/security/remote_import/allow_plaintext",
        "plaintext remote database imports",
    )?;
    let allowed_hosts = configuration
        .pointer("/security/remote_import/allowed_private_hosts")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| DisplayError::new("remote import private hosts must be an array"))?;
    for host in allowed_hosts {
        let host = host.as_str().unwrap_or_default();
        if !valid_remote_import_host(host) {
            return Err(DisplayError::new(format!(
                "remote import private-host allow-list contains an invalid hostname or IP address: {host}"
            ))
            .into());
        }
    }
    let connect_timeout = bounded_integer(
        configuration,
        "/security/remote_import/connect_timeout_seconds",
        "remote import connect timeout",
        1,
        300,
    )?;
    let operation_timeout = bounded_integer(
        configuration,
        "/security/remote_import/operation_timeout_seconds",
        "remote import operation timeout",
        1,
        86_400,
    )?;
    bounded_integer(
        configuration,
        "/security/remote_import/max_concurrent_jobs",
        "concurrent remote import jobs",
        1,
        64,
    )?;
    bounded_integer(
        configuration,
        "/security/remote_import/max_staged_bytes",
        "remote import staging limit",
        1,
        8 * 1024 * 1024 * 1024,
    )?;
    if operation_timeout < connect_timeout {
        return Err(DisplayError::new(
            "remote import operation timeout cannot be shorter than the connect timeout",
        )
        .into());
    }
    Ok(())
}

fn valid_remote_import_host(value: &str) -> bool {
    let value = value.trim();
    if value.is_empty() {
        return false;
    }
    if value.parse::<IpAddr>().is_ok()
        || value
            .strip_prefix('[')
            .and_then(|value| value.strip_suffix(']'))
            .is_some_and(|value| value.parse::<std::net::Ipv6Addr>().is_ok())
    {
        return true;
    }

    let host = value.strip_suffix('.').unwrap_or(value);
    if host.is_empty()
        || host.len() > 253
        || !host.is_ascii()
        || host.bytes().any(|byte| byte.is_ascii_control())
        || host
            .bytes()
            .any(|byte| matches!(byte, b'/' | b'\\' | b':' | b'@' | b'#' | b'?' | b'[' | b']'))
    {
        return false;
    }
    let labels = host.split('.').collect::<Vec<_>>();
    if labels.iter().any(|label| {
        label.is_empty()
            || label.len() > 63
            || label.starts_with('-')
            || label.ends_with('-')
            || !label
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    }) {
        return false;
    }
    !labels.iter().all(|label| {
        label.bytes().all(|byte| byte.is_ascii_digit())
            || label
                .strip_prefix("0x")
                .or_else(|| label.strip_prefix("0X"))
                .is_some_and(|digits| {
                    !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
    })
}

fn validate_import_export_scheduler(
    configuration: &serde_json::Value,
) -> Result<(), anyhow::Error> {
    let prefix = "/artifacts/import_export_scheduler";
    required_bool(
        configuration,
        &format!("{prefix}/dynamic_limiter_enabled"),
        "dynamic import/export scheduler",
    )?;
    let max_queued_jobs = bounded_integer(
        configuration,
        &format!("{prefix}/max_queued_jobs"),
        "scheduler maximum queued jobs",
        64,
        8_192,
    )?;
    let max_queued_jobs_per_instance = bounded_integer(
        configuration,
        &format!("{prefix}/max_queued_jobs_per_instance"),
        "scheduler maximum queued jobs per instance",
        1,
        256,
    )?;
    let manual_max_active_jobs = bounded_integer(
        configuration,
        &format!("{prefix}/manual_max_active_jobs"),
        "scheduler manual active-job limit",
        1,
        1_024,
    )?;
    let dynamic_max_active_jobs = bounded_integer(
        configuration,
        &format!("{prefix}/dynamic_max_active_jobs"),
        "scheduler dynamic active-job limit",
        1,
        1_024,
    )?;
    if max_queued_jobs_per_instance > max_queued_jobs
        || manual_max_active_jobs > max_queued_jobs
        || dynamic_max_active_jobs > max_queued_jobs
    {
        return Err(DisplayError::new(
            "scheduler per-instance and active-job limits cannot exceed max_queued_jobs",
        )
        .into());
    }
    zero_or_bounded_integer(
        configuration,
        &format!("{prefix}/dynamic_memory_budget_mib"),
        "scheduler dynamic memory budget",
        128,
        16_777_216,
    )?;
    zero_or_bounded_integer(
        configuration,
        &format!("{prefix}/dynamic_io_budget_mib"),
        "scheduler dynamic I/O budget",
        256,
        67_108_864,
    )?;
    bounded_integer(
        configuration,
        &format!("{prefix}/dynamic_cpu_units"),
        "scheduler dynamic CPU units",
        0,
        65_536,
    )?;
    bounded_integer(
        configuration,
        &format!("{prefix}/starvation_timeout_seconds"),
        "scheduler starvation timeout",
        1,
        3_600,
    )?;
    bounded_integer(
        configuration,
        &format!("{prefix}/max_bypass"),
        "scheduler maximum bypass count",
        0,
        1_024,
    )?;
    Ok(())
}

fn zero_or_bounded_integer(
    configuration: &serde_json::Value,
    pointer: &str,
    label: &str,
    minimum_non_zero: u64,
    maximum: u64,
) -> Result<u64, anyhow::Error> {
    configuration
        .pointer(pointer)
        .and_then(serde_json::Value::as_u64)
        .filter(|value| *value == 0 || (*value >= minimum_non_zero && *value <= maximum))
        .ok_or_else(|| {
            DisplayError::new(format!(
                "{label} must be 0 or an integer between {minimum_non_zero} and {maximum}"
            ))
            .into()
        })
}

fn absolute_path(
    configuration: &serde_json::Value,
    pointer: &str,
    label: &str,
) -> Result<(), anyhow::Error> {
    let path = required_string(configuration, pointer, label)?;
    if path.starts_with('/') {
        Ok(())
    } else {
        Err(DisplayError::new(format!("{label} must be an absolute path")).into())
    }
}

fn optional_absolute_path(
    configuration: &serde_json::Value,
    pointer: &str,
    label: &str,
) -> Result<(), anyhow::Error> {
    let path = configuration
        .pointer(pointer)
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| DisplayError::new(format!("invalid {label}")))?;
    if path.is_empty() || path.starts_with('/') {
        Ok(())
    } else {
        Err(DisplayError::new(format!("{label} must be empty or an absolute path")).into())
    }
}

fn validate_bind(label: &str, bind: &str) -> Result<(String, u16), anyhow::Error> {
    let (host, port) = bind
        .rsplit_once(':')
        .ok_or_else(|| DisplayError::new(format!("invalid {label} gateway bind")))?;
    let host = host.trim();
    let port = port
        .parse::<u16>()
        .ok()
        .filter(|port| *port > 0)
        .ok_or_else(|| DisplayError::new(format!("invalid {label} gateway bind")))?;
    if host.is_empty() || host.chars().any(char::is_whitespace) {
        return Err(DisplayError::new(format!("invalid {label} gateway bind")).into());
    }
    Ok((format!("{}:{port}", host.to_lowercase()), port))
}

fn validate_image(protocol: &str, image: &str) -> Result<(), anyhow::Error> {
    let tail = image.rsplit('/').next().unwrap_or_default();
    let versioned = image.contains("@sha256:")
        || tail
            .rsplit_once(':')
            .is_some_and(|(_, tag)| !tag.is_empty() && !tag.eq_ignore_ascii_case("latest"));
    if image.trim().is_empty() || image.chars().any(char::is_whitespace) || !versioned {
        return Err(DisplayError::new(format!(
            "{protocol} image must use an immutable digest or a non-latest tag"
        ))
        .into());
    }
    Ok(())
}

fn is_mysql_nine_image(image: &str) -> bool {
    let without_digest = image.split('@').next().unwrap_or(image);
    let tail = without_digest.rsplit('/').next().unwrap_or_default();
    let tag = tail
        .rsplit_once(':')
        .map(|(_, tag)| tag)
        .unwrap_or_default();
    tag == "9" || tag.starts_with("9.") || tag.starts_with("9-")
}

pub fn default_daemon_configuration() -> serde_json::Value {
    serde_json::json!({
        "debug": false,
        "tls": { "cert": "", "key": "" },
        "postgres": { "enabled": true, "bind": "0.0.0.0:20020", "tls": false },
        "mysql": { "enabled": true, "bind": "0.0.0.0:3308", "tls": false },
        "mariadb": { "enabled": true, "bind": "0.0.0.0:20021", "tls": false },
        "redis": { "enabled": true, "bind": "0.0.0.0:20022", "tls": false },
        "valkey": { "enabled": true, "bind": "0.0.0.0:20027", "tls": false },
        "mongodb": { "enabled": true, "bind": "0.0.0.0:20023", "tls": false },
        "clickhouse": { "enabled": true, "bind": "0.0.0.0:20024", "http_bind": "0.0.0.0:20026", "tls": false },
        "qdrant": { "enabled": true, "bind": "0.0.0.0:20025", "tls": false },
        "api": {
            "host": "127.0.0.1",
            "port": 8090,
            "trusted_hosts": [],
            "trusted_origins": [],
            "ssl": { "enabled": false, "cert": "", "key": "", "require_client_cert": false, "client_ca": "" }
        },
        "security": {
            "api_body_limit_bytes": 1048576,
            "api_rate_limit_per_minute": 600,
            "db_connection_limit_per_minute": 240,
            "self_upgrade_enabled": false,
            "pids_limit": 512,
            "pids_limits": {
                "postgres": null,
                "mysql": null,
                "mariadb": null,
                "redis": null,
                "valkey": null,
                "mongodb": null,
                "clickhouse": 4096,
                "qdrant": null
            },
            "remote_import": {
                "enabled": true,
                "allow_plaintext": false,
                "allowed_private_hosts": [],
                "max_concurrent_jobs": 4,
                "connect_timeout_seconds": 15,
                "operation_timeout_seconds": 900,
                "max_staged_bytes": 8589934592_u64
            }
        },
        "artifacts": {
            "stream_exports_only": false,
            "max_artifacts_per_instance": 20,
            "retention_keep_latest": 20,
            "retention_max_age_days": 30,
            "import_upload_max_bytes": 8589934592_u64,
            "import_upload_max_total_bytes": 34359738368_u64,
            "import_upload_max_per_instance": 4,
            "import_upload_max_concurrent": 2,
            "import_upload_ttl_hours": 24,
            "import_upload_timeout_seconds": 3600,
            "import_upload_idle_timeout_seconds": 30,
            "import_export_scheduler": {
                "dynamic_limiter_enabled": true,
                "max_queued_jobs": 1024,
                "max_queued_jobs_per_instance": 32,
                "manual_max_active_jobs": 16,
                "dynamic_max_active_jobs": 256,
                "dynamic_memory_budget_mib": 0,
                "dynamic_io_budget_mib": 0,
                "dynamic_cpu_units": 0,
                "starvation_timeout_seconds": 30,
                "max_bypass": 8
            }
        },
        "allocation": {
            "prevent_cpu_overallocation": true,
            "prevent_memory_overallocation": true,
            "prevent_disk_overallocation": true,
            "max_memory_mib": null,
            "max_disk_mib": null,
            "reserved_memory_mib": 512,
            "reserved_disk_mib": 2048
        },
        "backups": {
            "enabled": false,
            "interval_minutes": 1440,
            "run_on_startup": false,
            "retention_keep_latest_per_instance": 7,
            "retention_max_age_days": 30,
            "storage": {
                "driver": "local",
                "s3": {
                    "bucket": "", "region": "us-east-1", "endpoint": "", "prefix": "dbev",
                    "access_key_id": "", "secret_access_key": "", "session_token": "",
                    "path_style": false, "allow_http": false,
                    "request_timeout_seconds": 900, "max_retries": 3
                },
                "kopia": {
                    "executable": "/usr/local/bin/kopia", "config_file": "",
                    "repository_password": "", "operation_timeout_seconds": 3600
                }
            },
            "browsing": {
                "enabled": true,
                "max_objects": 256,
                "max_preview_objects": 32,
                "preview_rows_per_object": 10,
                "max_row_bytes": 4096,
                "max_catalog_bytes": 1048576
            }
        },
        "disk": {
            "mode": "auto",
            "fuse_quota_binary": "embedded",
            "fuse_quota_binary_sha256": "",
            "fuse_quota_rescan_interval_seconds": 150,
            "project_id_base": 200000,
            "soft_scanner": {
                "scan_interval_seconds": 15,
                "use_inotify": true,
                "full_scan_interval_seconds": 90,
                "inotify_debounce_milliseconds": 500,
                "max_dirty_paths_per_instance": 512,
                "max_concurrent_scans": 2,
                "max_entries_per_scan": 1000000,
                "scan_timeout_seconds": 30,
                "max_consecutive_scan_failures": 3,
                "safety_reserve_mib": 64,
                "recovery_percent": 85,
                "shutdown_grace_seconds": 30
            }
        },
        "daemon": {
            "engine": "docker",
            "socket_path": "",
            "container_read_only_rootfs": false,
            "container_userns_mode": "",
            "container_seccomp_profile": "",
            "container_apparmor_profile": "",
            "container_security_opts": []
        },
        "images": {
            "postgres": "postgres:18.4",
            "mysql": "mysql:8.4",
            "redis": "redis:8.8.0",
            "valkey": "valkey/valkey:9.1.1",
            "mariadb": "mariadb:12.3.2",
            "mongodb": "mongo:8.3.4",
            "clickhouse": "clickhouse/clickhouse-server:26.4.4.38",
            "qdrant": "qdrant/qdrant:v1.18.2",
            "allowed": {
                "postgres": ["postgres:18.4"],
                "mysql": ["mysql:8.4"],
                "redis": ["redis:8.8.0"],
                "valkey": ["valkey/valkey:9.1.1"],
                "mariadb": ["mariadb:12.3.2"],
                "mongodb": ["mongo:8.3.4", "mongo:7.0.37"],
                "clickhouse": ["clickhouse/clickhouse-server:26.4.4.38"],
                "qdrant": ["qdrant/qdrant:v1.18.2"]
            }
        },
        "paths": {
            "data": "/var/lib/dbev",
            "metadata": "/var/lib/dbev/metadata",
            "volumes": "/var/lib/dbev/volumes",
            "backups": "/var/lib/dbev/backups",
            "sockets": "/run/dbev/sockets",
            "locks": "/run/dbev/locks",
            "logs": "/var/lib/dbev/logs",
            "artifacts": "/var/lib/dbev/artifacts",
            "exports": "/var/lib/dbev/artifacts/exports",
            "imports": "/var/lib/dbev/artifacts/imports",
            "fuse": "/var/lib/dbev/fuse",
            "tmp": "/var/lib/dbev/tmp"
        }
    })
}

#[cfg(test)]
mod tests {
    use super::{
        NodeConfigurationSecrets, NodeConfigurationSecretsPatch, default_daemon_configuration,
        normalize_daemon_configuration,
    };

    #[test]
    fn defaults_are_valid_and_complete() {
        let (configuration, secrets) =
            normalize_daemon_configuration(serde_json::json!({})).unwrap();
        assert!(secrets.is_empty());
        assert_eq!(
            configuration.pointer("/paths/volumes").unwrap(),
            "/var/lib/dbev/volumes"
        );
        assert_eq!(
            configuration.pointer("/backups/storage/driver").unwrap(),
            "local"
        );
        for guard in [
            "prevent_cpu_overallocation",
            "prevent_memory_overallocation",
            "prevent_disk_overallocation",
        ] {
            assert_eq!(
                configuration.pointer(&format!("/allocation/{guard}")),
                Some(&serde_json::Value::Bool(true))
            );
        }
        let yaml = serde_norway::to_string(&configuration).unwrap();
        assert!(yaml.contains("prevent_cpu_overallocation: true"));
        assert!(yaml.contains("prevent_memory_overallocation: true"));
        assert!(yaml.contains("prevent_disk_overallocation: true"));
        assert!(yaml.contains("trusted_origins: []"));
        assert!(yaml.contains("mode: auto"));
        assert!(yaml.contains("scan_interval_seconds: 15"));
        assert!(yaml.contains("dynamic_limiter_enabled: true"));
        assert!(yaml.contains("max_queued_jobs: 1024"));
        assert!(yaml.contains("stream_exports_only: false"));
        assert!(yaml.contains("max_artifacts_per_instance: 20"));
        assert!(yaml.contains("self_upgrade_enabled: false"));
        assert!(yaml.contains("allow_plaintext: false"));
        assert!(yaml.contains("max_staged_bytes: 8589934592"));
        assert!(yaml.contains("import_upload_max_bytes: 8589934592"));
        assert!(yaml.contains("import_upload_max_total_bytes: 34359738368"));
        assert!(yaml.contains("use_inotify: true"));
        assert!(yaml.contains("full_scan_interval_seconds: 90"));
        assert!(yaml.contains("inotify_debounce_milliseconds: 500"));
        assert!(yaml.contains("max_dirty_paths_per_instance: 512"));
        assert!(yaml.contains("logs: /var/lib/dbev/logs"));
    }

    #[test]
    fn validates_artifact_policy_boundaries() {
        for value in [1_u64, 20, 10_000] {
            let mut input = default_daemon_configuration();
            input["artifacts"]["max_artifacts_per_instance"] = serde_json::json!(value);
            normalize_daemon_configuration(input)
                .unwrap_or_else(|error| panic!("max_artifacts_per_instance={value}: {error}"));
        }

        for value in [0_u64, 10_001] {
            let mut input = default_daemon_configuration();
            input["artifacts"]["max_artifacts_per_instance"] = serde_json::json!(value);
            assert!(
                normalize_daemon_configuration(input).is_err(),
                "max_artifacts_per_instance={value} should be rejected"
            );
        }

        let mut invalid_boolean = default_daemon_configuration();
        invalid_boolean["artifacts"]["stream_exports_only"] = serde_json::json!("false");
        assert!(normalize_daemon_configuration(invalid_boolean).is_err());
    }

    #[test]
    fn older_artifact_configuration_keeps_v052_keys_absent() {
        let input = serde_json::json!({
            "artifacts": {
                "retention_keep_latest": 5,
                "retention_max_age_days": 10
            }
        });
        let (configuration, _) = normalize_daemon_configuration(input).unwrap();
        assert!(
            configuration
                .pointer("/artifacts/stream_exports_only")
                .is_none()
        );
        assert!(
            configuration
                .pointer("/artifacts/max_artifacts_per_instance")
                .is_none()
        );
        assert_eq!(
            configuration.pointer("/artifacts/retention_keep_latest"),
            Some(&serde_json::json!(5))
        );
    }

    #[test]
    fn embedded_backup_secrets_are_removed() {
        let mut input = default_daemon_configuration();
        input["backups"]["storage"]["s3"]["secret_access_key"] = serde_json::json!("secret");
        let (configuration, secrets) = normalize_daemon_configuration(input).unwrap();
        assert_eq!(secrets.s3_secret_access_key, "secret");
        assert_eq!(
            configuration
                .pointer("/backups/storage/s3/secret_access_key")
                .unwrap(),
            ""
        );
    }

    #[test]
    fn secret_patches_preserve_existing_values_until_explicitly_changed_or_cleared() {
        let original = NodeConfigurationSecrets {
            s3_access_key_id: "existing-access".to_owned(),
            s3_secret_access_key: "existing-secret".to_owned(),
            s3_session_token: "existing-session".to_owned(),
            kopia_repository_password: "existing-kopia".to_owned(),
        };

        let mut unchanged = original.clone();
        unchanged.apply_patch(None);
        assert_eq!(unchanged.s3_access_key_id, "existing-access");
        assert_eq!(unchanged.s3_secret_access_key, "existing-secret");
        assert_eq!(unchanged.kopia_repository_password, "existing-kopia");

        let mut replaced = original.clone();
        replaced.apply_patch(Some(NodeConfigurationSecretsPatch {
            s3_access_key_id: Some("replacement-access".to_owned()),
            s3_secret_access_key: Some(String::new()),
            ..Default::default()
        }));
        assert_eq!(replaced.s3_access_key_id, "replacement-access");
        assert_eq!(replaced.s3_secret_access_key, "existing-secret");
        assert_eq!(replaced.kopia_repository_password, "existing-kopia");

        let mut cleared = original;
        cleared.apply_patch(Some(NodeConfigurationSecretsPatch {
            clear_s3_credentials: true,
            clear_kopia_repository_password: true,
            ..Default::default()
        }));
        assert!(cleared.is_empty());
    }

    #[test]
    fn accepts_plaintext_public_api_listener() {
        let mut input = default_daemon_configuration();
        input["api"]["host"] = serde_json::json!("0.0.0.0");
        let (configuration, _) = normalize_daemon_configuration(input).unwrap();
        assert_eq!(configuration.pointer("/api/host").unwrap(), "0.0.0.0");
        assert_eq!(
            configuration.pointer("/api/ssl/enabled").unwrap(),
            &serde_json::Value::Bool(false)
        );
    }

    #[test]
    fn rejects_mysql_nine_images() {
        let mut input = default_daemon_configuration();
        input["images"]["mysql"] = serde_json::json!("mysql:9.0");
        input["images"]["allowed"]["mysql"] = serde_json::json!(["mysql:9.0"]);
        let error = normalize_daemon_configuration(input).unwrap_err();
        assert!(error.to_string().contains("MySQL 9.x"));
    }

    #[test]
    fn preserves_unknown_official_configuration_keys() {
        let input = serde_json::json!({ "future_official_feature": { "enabled": true } });
        let (configuration, _) = normalize_daemon_configuration(input).unwrap();
        assert_eq!(
            configuration.pointer("/future_official_feature/enabled"),
            Some(&serde_json::Value::Bool(true))
        );
    }

    #[test]
    fn legacy_none_disk_mode_is_normalized_to_active_soft_enforcement() {
        let input = serde_json::json!({ "disk": { "mode": "none" } });
        let (configuration, _) = normalize_daemon_configuration(input).unwrap();
        assert_eq!(
            configuration.pointer("/disk/mode"),
            Some(&serde_json::Value::String("soft_scanner".to_owned()))
        );
    }

    #[test]
    fn legacy_log_path_is_migrated_to_the_current_safe_runtime_root() {
        let input = serde_json::json!({ "paths": { "logs": "/var/log/dbev" } });
        let (configuration, _) = normalize_daemon_configuration(input).unwrap();
        assert_eq!(
            configuration.pointer("/paths/logs"),
            Some(&serde_json::json!("/var/lib/dbev/logs"))
        );
    }

    #[test]
    fn validates_remote_import_upload_and_pid_configuration() {
        let mut input = default_daemon_configuration();
        input["security"]["remote_import"]["allowed_private_hosts"] =
            serde_json::json!(["db.internal.example", "10.20.30.40", "[fd00::1234]"]);
        input["security"]["pids_limits"]["postgres"] = serde_json::json!(1024);
        normalize_daemon_configuration(input).unwrap();

        for invalid_host in ["https://db.internal", "db.internal/path", "127.1"] {
            let mut input = default_daemon_configuration();
            input["security"]["remote_import"]["allowed_private_hosts"] =
                serde_json::json!([invalid_host]);
            assert!(
                normalize_daemon_configuration(input).is_err(),
                "{invalid_host}"
            );
        }

        let mut input = default_daemon_configuration();
        input["artifacts"]["import_upload_max_total_bytes"] = serde_json::json!(1);
        assert!(normalize_daemon_configuration(input).is_err());

        let mut input = default_daemon_configuration();
        input["security"]["pids_limits"]["postgres"] = serde_json::json!(0);
        assert!(normalize_daemon_configuration(input).is_err());
    }

    #[test]
    fn validates_trusted_browser_origins_independently_from_hosts() {
        for valid in [
            "https://panel.example.com",
            "https://panel.example.com:8443",
            "http://127.0.0.1:8000",
        ] {
            let input = serde_json::json!({ "api": { "trusted_origins": [valid] } });
            normalize_daemon_configuration(input).unwrap();
        }

        for invalid in [
            "panel.example.com",
            "ftp://panel.example.com",
            "https://panel.example.com/path",
            "https://user@panel.example.com",
            "https://panel.example.com?query=1",
        ] {
            let input = serde_json::json!({ "api": { "trusted_origins": [invalid] } });
            assert!(normalize_daemon_configuration(input).is_err());
        }
    }

    #[test]
    fn validates_every_scheduler_configuration_boundary() {
        let valid = [
            ("max_queued_jobs", 64_u64),
            ("max_queued_jobs", 8_192),
            ("max_queued_jobs_per_instance", 1),
            ("max_queued_jobs_per_instance", 256),
            ("manual_max_active_jobs", 1),
            ("manual_max_active_jobs", 1_024),
            ("dynamic_max_active_jobs", 1),
            ("dynamic_max_active_jobs", 1_024),
            ("dynamic_memory_budget_mib", 0),
            ("dynamic_memory_budget_mib", 128),
            ("dynamic_memory_budget_mib", 16_777_216),
            ("dynamic_io_budget_mib", 0),
            ("dynamic_io_budget_mib", 256),
            ("dynamic_io_budget_mib", 67_108_864),
            ("dynamic_cpu_units", 0),
            ("dynamic_cpu_units", 65_536),
            ("starvation_timeout_seconds", 1),
            ("starvation_timeout_seconds", 3_600),
            ("max_bypass", 0),
            ("max_bypass", 1_024),
        ];
        for (field, value) in valid {
            let mut input = default_daemon_configuration();
            input["artifacts"]["import_export_scheduler"][field] = serde_json::json!(value);
            if matches!(field, "manual_max_active_jobs" | "dynamic_max_active_jobs") {
                input["artifacts"]["import_export_scheduler"]["max_queued_jobs"] =
                    serde_json::json!(8_192);
            }
            if field == "max_queued_jobs" && value == 64 {
                input["artifacts"]["import_export_scheduler"]["max_queued_jobs_per_instance"] =
                    serde_json::json!(32);
                input["artifacts"]["import_export_scheduler"]["manual_max_active_jobs"] =
                    serde_json::json!(16);
                input["artifacts"]["import_export_scheduler"]["dynamic_max_active_jobs"] =
                    serde_json::json!(64);
            }
            normalize_daemon_configuration(input)
                .unwrap_or_else(|error| panic!("{field}={value}: {error}"));
        }

        for (field, value) in [
            ("max_queued_jobs", 63_u64),
            ("max_queued_jobs", 8_193),
            ("max_queued_jobs_per_instance", 0),
            ("max_queued_jobs_per_instance", 257),
            ("manual_max_active_jobs", 0),
            ("manual_max_active_jobs", 1_025),
            ("dynamic_max_active_jobs", 0),
            ("dynamic_max_active_jobs", 1_025),
            ("dynamic_memory_budget_mib", 127),
            ("dynamic_memory_budget_mib", 16_777_217),
            ("dynamic_io_budget_mib", 255),
            ("dynamic_io_budget_mib", 67_108_865),
            ("dynamic_cpu_units", 65_537),
            ("starvation_timeout_seconds", 0),
            ("starvation_timeout_seconds", 3_601),
            ("max_bypass", 1_025),
        ] {
            let mut input = default_daemon_configuration();
            input["artifacts"]["import_export_scheduler"][field] = serde_json::json!(value);
            assert!(
                normalize_daemon_configuration(input).is_err(),
                "{field}={value} should be rejected"
            );
        }
    }

    #[test]
    fn scheduler_limits_cannot_exceed_the_durable_queue() {
        for field in [
            "max_queued_jobs_per_instance",
            "manual_max_active_jobs",
            "dynamic_max_active_jobs",
        ] {
            let mut input = default_daemon_configuration();
            input["artifacts"]["import_export_scheduler"]["max_queued_jobs"] =
                serde_json::json!(64);
            input["artifacts"]["import_export_scheduler"][field] = serde_json::json!(65);
            assert!(normalize_daemon_configuration(input).is_err(), "{field}");
        }
    }
}
