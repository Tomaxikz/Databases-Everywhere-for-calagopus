use crate::{
    dbev::{DbevCapabilities, DbevClient},
    domain::DatabaseProtocol,
    persistence::{DatabaseRecord, queue_instance_deletion},
    services::{scheduler::select_node, total_database_usage},
};
use rand::distr::SampleString;
use regex::Regex;
use serde::{Deserialize, Serialize};
use shared::{
    State,
    models::server::Server,
    response::{DisplayError, extract_readable_error},
};
use std::sync::LazyLock;
use utoipa::ToSchema;

static DATABASE_IDENTIFIER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z][A-Za-z0-9_-]{0,62}$").unwrap());

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct CreateDatabaseInput {
    pub protocol: DatabaseProtocol,
    pub display_name: String,
    pub database_name: Option<String>,
    pub username: Option<String>,
    pub image: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct DeleteDatabaseOutcome {
    pub deferred: bool,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ResetPasswordOutcome {
    pub restarted: bool,
}

pub async fn create_database(
    state: &State,
    server: &Server,
    input: CreateDatabaseInput,
) -> Result<DatabaseRecord, anyhow::Error> {
    ensure_extension_enabled(state).await?;
    validate_create_input(&input)?;

    let databases_lock = state
        .cache
        .lock(
            format!("servers::{}::databases", server.uuid),
            Some(30),
            Some(5),
        )
        .await?;
    let used = total_database_usage(state, server.uuid).await?;
    if used >= i64::from(server.database_limit) {
        return Err(DisplayError::new("maximum number of databases reached")
            .with_status(axum::http::StatusCode::EXPECTATION_FAILED)
            .into());
    }

    let scheduled = select_node(state, server, input.protocol, input.image.as_deref()).await?;
    let uuid = uuid::Uuid::new_v4();
    let compact_uuid = uuid.simple().to_string();
    let database_name = input
        .database_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("c7s_{}", &compact_uuid[..20]));
    let username = input
        .username
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("u_{}", &compact_uuid[..20]));
    validate_identifier("database name", &database_name)?;
    validate_identifier("username", &username)?;
    let password = rand::distr::Alphanumeric.sample_string(&mut rand::rng(), 40);
    let instance_id = uuid.to_string();
    let public_port = i32::from(scheduled.node.gateway_port(input.protocol));
    let tls = scheduled.node.protocol_tls(input.protocol);

    let record = DatabaseRecord::create(
        state,
        uuid,
        server.uuid,
        scheduled.node.uuid,
        input.protocol,
        input.display_name.trim(),
        &database_name,
        &username,
        &password,
        &scheduled.node.public_host,
        public_port,
        tls,
        "creating",
        input.image.as_deref(),
        scheduled.limits,
        serde_json::json!({
            "api_version": scheduled.system.get("api_version"),
            "daemon_version": scheduled.system.get("version"),
            "node_uuid": scheduled.node.daemon_uuid.clone(),
        }),
    )
    .await?;

    let mut payload = serde_json::json!({
        "instance_id": instance_id,
        "protocol": input.protocol,
        "database": database_name,
        "username": username,
        "password": password,
        "public_host": scheduled.node.public_host.clone(),
        "public_port": public_port,
        "project_id": server.uuid.to_string(),
        "limits": scheduled.limits,
    });
    if let Some(image) = input.image.as_deref() {
        payload["image"] = serde_json::Value::String(image.to_owned());
    }

    let client = DbevClient::for_mutation(state, &scheduled.node).await?;
    let accepted = client
        .post_accepted::<serde_json::Value, _>("/api/instances", &payload)
        .await;
    let accepted = match accepted {
        Ok(accepted) => accepted,
        Err(error) => {
            if let Err(cleanup_error) = record.delete_local(state).await {
                tracing::error!(database = %record.uuid, error = ?cleanup_error, "failed to roll back local DatabasesEverywhere record");
            }
            return Err(error);
        }
    };

    let expected_status_url = format!("/api/instances/{instance_id}/status");
    if accepted
        .get("instance_id")
        .and_then(serde_json::Value::as_str)
        != Some(&instance_id)
        || accepted.get("status").and_then(serde_json::Value::as_str) != Some("creating")
        || accepted
            .get("status_url")
            .and_then(serde_json::Value::as_str)
            != Some(expected_status_url.as_str())
    {
        queue_instance_deletion(
            state,
            scheduled.node.uuid,
            &instance_id,
            "invalid asynchronous creation response",
        )
        .await?;
        record.delete_local(state).await?;
        return Err(DisplayError::new(
            "DatabasesEverywhere returned an invalid asynchronous instance creation response",
        )
        .with_status(axum::http::StatusCode::BAD_GATEWAY)
        .into());
    }

    record.update_remote_state(state, &accepted).await?;
    drop(databases_lock);
    DatabaseRecord::by_server_uuid(state, server.uuid, uuid)
        .await?
        .ok_or_else(|| anyhow::anyhow!("created database record disappeared"))
}

async fn ensure_extension_enabled(state: &State) -> Result<(), anyhow::Error> {
    if !extension_provisioning_enabled(state).await? {
        return Err(
            DisplayError::new("the DatabasesEverywhere extension is disabled")
                .with_status(axum::http::StatusCode::SERVICE_UNAVAILABLE)
                .into(),
        );
    }
    Ok(())
}

pub async fn extension_provisioning_enabled(state: &State) -> Result<bool, anyhow::Error> {
    let settings = state.settings.get().await?;
    let extension = settings.get_extension_settings::<crate::settings::ExtensionSettingsData>(
        "com.tomaxikz.databaseseverywhere",
    )?;
    Ok(extension.enabled)
}

pub async fn delete_database(
    state: &State,
    database: &DatabaseRecord,
    reason: &str,
) -> Result<DeleteDatabaseOutcome, anyhow::Error> {
    let reason = reason.trim();
    if reason.is_empty() {
        return Err(DisplayError::new("a deletion reason is required").into());
    }
    let node = crate::persistence::NodeRecord::by_uuid(state, database.dbev_node_uuid)
        .await?
        .ok_or_else(|| anyhow::anyhow!("DatabasesEverywhere node no longer exists"))?;
    let client = DbevClient::for_mutation(state, &node).await?;
    let path = format!(
        "/api/instances/{}?confirm=true&reason={}",
        urlencoding::encode(&database.instance_id()),
        urlencoding::encode(reason),
    );

    match client.delete_allow_not_found(&path).await {
        Ok(Some(response)) => {
            if response.get("deleted").and_then(serde_json::Value::as_bool) != Some(true)
                || response.get("purged").and_then(serde_json::Value::as_bool) != Some(true)
            {
                return Err(DisplayError::new(
                    "DatabasesEverywhere did not confirm permanent deletion and purge",
                )
                .with_status(axum::http::StatusCode::BAD_GATEWAY)
                .into());
            }
            database.delete_local(state).await?;
            Ok(DeleteDatabaseOutcome { deferred: false })
        }
        Ok(None) => {
            database.delete_local(state).await?;
            Ok(DeleteDatabaseOutcome { deferred: false })
        }
        // Never replay a delete after an ambiguous response.
        Err(error) => Err(error),
    }
}

pub async fn set_database_power(
    state: &State,
    database: &DatabaseRecord,
    action: &str,
) -> Result<serde_json::Value, anyhow::Error> {
    if !matches!(action, "start" | "stop" | "restart" | "kill") {
        return Err(DisplayError::new("unsupported DatabasesEverywhere power action").into());
    }
    if database.status == "quarantined" {
        return Err(DisplayError::new(
            "this database is quarantined; inspect or reconcile it before using normal power actions",
        )
        .with_status(axum::http::StatusCode::CONFLICT)
        .into());
    }
    let (node, client) = client_for_database(state, database).await?;
    let response = client
        .post::<serde_json::Value, _>(
            &format!(
                "/api/instances/{}/power",
                urlencoding::encode(&database.instance_id())
            ),
            &serde_json::json!({ "action": action }),
        )
        .await?;
    database.update_remote_state(state, &response).await?;
    drop(node);
    Ok(response)
}

pub async fn set_database_image(
    state: &State,
    database: &DatabaseRecord,
    image: &str,
    major_upgrade: bool,
    legacy_password: Option<&str>,
) -> Result<serde_json::Value, anyhow::Error> {
    validate_image(image)?;
    if database.status == "quarantined" {
        return Err(DisplayError::new(
            "this database is quarantined; inspect or reconcile it before replacing its image",
        )
        .with_status(axum::http::StatusCode::CONFLICT)
        .into());
    }
    if major_upgrade
        && matches!(
            database.protocol,
            DatabaseProtocol::Redis | DatabaseProtocol::Valkey | DatabaseProtocol::Qdrant
        )
    {
        return Err(DisplayError::new(
            "major upgrades are not supported for Redis, Valkey, or Qdrant",
        )
        .into());
    }
    let (node, client) = client_for_database(state, database).await?;
    let system = client.get::<serde_json::Value>("/api/system").await?;
    let capabilities = DbevCapabilities::from_system(&system);
    node.store_health(state, Some(&system), None, None).await?;

    let explicitly_supplied = legacy_password.filter(|password| !password.is_empty());
    let password = if capabilities.stored_tenant_credentials {
        explicitly_supplied.map(str::to_owned)
    } else {
        Some(match explicitly_supplied {
            Some(password) => password.to_owned(),
            None => database.decrypted_password(state).await?,
        })
    };
    if let Some(password) = password.as_deref() {
        validate_password(password)?;
    }
    let payload = image_update_payload(image, major_upgrade, password.as_deref());
    let response = client
        .patch::<serde_json::Value, _>(
            &format!(
                "/api/instances/{}/image",
                urlencoding::encode(&database.instance_id())
            ),
            &payload,
        )
        .await;
    let response = match response {
        Ok(response) => response,
        Err(error) => {
            if extract_readable_error(&error)
                .is_some_and(|(_, status)| status == axum::http::StatusCode::INTERNAL_SERVER_ERROR)
                && let Ok(refreshed) = client
                    .get::<serde_json::Value>(&format!(
                        "/api/instances/{}",
                        urlencoding::encode(&database.instance_id())
                    ))
                    .await
                && let Err(refresh_error) = database.update_remote_state(state, &refreshed).await
            {
                tracing::warn!(database = %database.uuid, error = ?refresh_error, "failed to refresh database state after an internal image update failure");
            }
            return Err(error);
        }
    };
    database.update_remote_state(state, &response).await?;
    Ok(response)
}

pub async fn reconcile_database(
    state: &State,
    database: &DatabaseRecord,
) -> Result<serde_json::Value, anyhow::Error> {
    let (_node, client) = client_for_database(state, database).await?;
    let path = format!(
        "/api/instances/{}/reconcile",
        urlencoding::encode(&database.instance_id())
    );
    let response = client
        .post::<serde_json::Value, _>(&path, &serde_json::json!({}))
        .await?;
    database.update_remote_state(state, &response).await?;
    Ok(response)
}

pub async fn reset_database_password(
    state: &State,
    database: &DatabaseRecord,
    password: &str,
) -> Result<ResetPasswordOutcome, anyhow::Error> {
    validate_password(password)?;
    let (_node, client) = client_for_database(state, database).await?;
    let instance_path = format!(
        "/api/instances/{}",
        urlencoding::encode(&database.instance_id())
    );
    let current = client.get::<serde_json::Value>(&instance_path).await?;
    database.update_remote_state(state, &current).await?;
    if current.get("status").and_then(serde_json::Value::as_str) != Some("running") {
        return Err(DisplayError::new(
            "the database must be running before its credential can be reset",
        )
        .with_status(axum::http::StatusCode::CONFLICT)
        .into());
    }

    let path = format!("{instance_path}/password");
    let response = client
        .patch::<serde_json::Value, _>(&path, &serde_json::json!({ "password": password }))
        .await;
    let response = match response {
        Ok(response) => response,
        Err(error) => {
            if let Ok(refreshed) = client.get::<serde_json::Value>(&instance_path).await
                && let Err(refresh_error) = database.update_remote_state(state, &refreshed).await
            {
                tracing::warn!(database = %database.uuid, error = ?refresh_error, "failed to refresh database state after a rejected credential reset");
            }
            return Err(error);
        }
    };
    if contains_plaintext_credential(&response) {
        return Err(anyhow::Error::new(
            DisplayError::new("DatabasesEverywhere returned an unsafe password reset response")
                .with_status(axum::http::StatusCode::BAD_GATEWAY),
        ));
    }

    let (instance, restarted) = parse_password_reset_response(&response)?;
    database.update_remote_state(state, instance).await?;
    database.update_password(state, password).await?;
    Ok(ResetPasswordOutcome { restarted })
}

fn image_update_payload(
    image: &str,
    major_upgrade: bool,
    password: Option<&str>,
) -> serde_json::Value {
    let mut payload = serde_json::json!({
        "image": image,
        "major_upgrade": major_upgrade,
    });
    if let Some(password) = password {
        payload["password"] = serde_json::Value::String(password.to_owned());
    }
    payload
}

fn parse_password_reset_response(
    response: &serde_json::Value,
) -> Result<(&serde_json::Value, bool), anyhow::Error> {
    let restarted = response
        .get("restarted")
        .and_then(serde_json::Value::as_bool)
        .ok_or_else(invalid_password_reset_response)?;
    let instance = response
        .get("instance")
        .filter(|instance| instance.is_object())
        .ok_or_else(invalid_password_reset_response)?;
    Ok((instance, restarted))
}

fn invalid_password_reset_response() -> anyhow::Error {
    anyhow::Error::new(
        DisplayError::new("DatabasesEverywhere returned an invalid password reset response")
            .with_status(axum::http::StatusCode::BAD_GATEWAY),
    )
}

async fn client_for_database(
    state: &State,
    database: &DatabaseRecord,
) -> Result<(crate::persistence::NodeRecord, DbevClient), anyhow::Error> {
    let node = crate::persistence::NodeRecord::by_uuid(state, database.dbev_node_uuid)
        .await?
        .ok_or_else(|| anyhow::anyhow!("DatabasesEverywhere node no longer exists"))?;
    let client = DbevClient::for_mutation(state, &node).await?;
    Ok((node, client))
}

fn validate_create_input(input: &CreateDatabaseInput) -> Result<(), anyhow::Error> {
    let display_name = input.display_name.trim();
    if display_name.is_empty() || display_name.chars().count() > 191 {
        return Err(
            DisplayError::new("database display name must contain 1 to 191 characters").into(),
        );
    }
    if let Some(database_name) = input.database_name.as_deref().map(str::trim)
        && !database_name.is_empty()
    {
        validate_identifier("database name", database_name)?;
    }
    if let Some(username) = input.username.as_deref().map(str::trim)
        && !username.is_empty()
    {
        validate_identifier("username", username)?;
    }
    if let Some(image) = input.image.as_deref() {
        validate_image(image)?;
    }
    Ok(())
}

fn validate_identifier(label: &str, value: &str) -> Result<(), anyhow::Error> {
    if !DATABASE_IDENTIFIER.is_match(value) {
        return Err(DisplayError::new(format!(
            "{label} must start with an ASCII letter and contain at most 63 letters, digits, underscores, or dashes"
        ))
        .into());
    }
    const RESERVED: &[&str] = &[
        "postgres",
        "mysql",
        "admin",
        "root",
        "default",
        "dbe_admin",
        "dbe_health",
    ];
    if RESERVED
        .iter()
        .any(|reserved| value.eq_ignore_ascii_case(reserved))
    {
        return Err(DisplayError::new(format!("{label} is reserved")).into());
    }
    Ok(())
}

fn validate_image(image: &str) -> Result<(), anyhow::Error> {
    let image = image.trim();
    if image.is_empty() || image.len() > 255 || image.chars().any(char::is_whitespace) {
        return Err(DisplayError::new("enter a valid pinned container image reference").into());
    }
    let last_segment = image.rsplit('/').next().unwrap_or(image);
    let pinned = image.contains("@sha256:")
        || last_segment
            .rsplit_once(':')
            .is_some_and(|(_, tag)| !tag.is_empty() && tag != "latest");
    if !pinned {
        return Err(DisplayError::new(
            "container images must use a non-latest tag or sha256 digest",
        )
        .into());
    }
    Ok(())
}

fn validate_password(password: &str) -> Result<(), anyhow::Error> {
    let characters = password.chars().count();
    if !(1..=4096).contains(&characters) {
        return Err(
            DisplayError::new("password must contain between 1 and 4096 characters").into(),
        );
    }
    if password
        .chars()
        .any(|character| matches!(character, '\0' | '\r' | '\n'))
    {
        return Err(DisplayError::new(
            "password cannot contain NUL, carriage return, or line feed characters",
        )
        .into());
    }
    Ok(())
}

fn contains_plaintext_credential(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Object(object) => object.iter().any(|(key, value)| {
            matches!(key.to_ascii_lowercase().as_str(), "password" | "api_key")
                || contains_plaintext_credential(value)
        }),
        serde_json::Value::Array(values) => values.iter().any(contains_plaintext_credential),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        contains_plaintext_credential, image_update_payload, parse_password_reset_response,
        validate_password,
    };

    #[test]
    fn validates_password_contract_without_normalizing_the_secret() {
        assert!(validate_password(" a valid password ").is_ok());
        assert!(validate_password("").is_err());
        assert!(validate_password("line\nbreak").is_err());
        assert!(validate_password(&"x".repeat(4097)).is_err());
    }

    #[test]
    fn rejects_passwords_in_daemon_response_models() {
        assert!(contains_plaintext_credential(&serde_json::json!({
            "instance": { "password": "must-not-be-returned" },
            "restarted": true
        })));
        assert!(!contains_plaintext_credential(&serde_json::json!({
            "instance": { "status": "running" },
            "restarted": true
        })));
    }

    #[test]
    fn accepts_live_and_recreated_password_rotation_responses() {
        for restarted in [false, true] {
            let response = serde_json::json!({
                "instance": { "instance_id": "example", "status": "running" },
                "restarted": restarted
            });
            let (instance, actual) = parse_password_reset_response(&response).unwrap();
            assert_eq!(actual, restarted);
            assert_eq!(
                instance.get("status").and_then(serde_json::Value::as_str),
                Some("running")
            );
        }
    }

    #[test]
    fn modern_image_update_omits_password_and_legacy_update_keeps_it() {
        let modern = image_update_payload("postgres:17.5", false, None);
        assert_eq!(
            modern.get("image").and_then(serde_json::Value::as_str),
            Some("postgres:17.5")
        );
        assert!(!modern.as_object().unwrap().contains_key("password"));

        let legacy = image_update_payload("postgres:17.5", false, Some("legacy-secret"));
        assert_eq!(
            legacy.get("password").and_then(serde_json::Value::as_str),
            Some("legacy-secret")
        );
    }
}
