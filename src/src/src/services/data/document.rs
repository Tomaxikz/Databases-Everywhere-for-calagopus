use super::{DataObject, QueryOutput};
use crate::persistence::DatabaseRecord;
use futures_util::TryStreamExt;
use mongodb::bson::{Document, doc};
use shared::State;
use std::{collections::BTreeSet, time::Instant};

pub async fn overview(
    state: &State,
    database: &DatabaseRecord,
) -> Result<Vec<DataObject>, anyhow::Error> {
    let client = client(state, database).await?;
    let names = client
        .database(&database.database_name)
        .list_collection_names()
        .await
        .map_err(mongodb_gateway_error)?;
    Ok(names
        .into_iter()
        .map(|name| DataObject {
            name,
            namespace: Some(database.database_name.clone()),
            kind: "collection".to_owned(),
            metadata: serde_json::json!({}),
        })
        .collect())
}

pub async fn browse(
    state: &State,
    database: &DatabaseRecord,
    collection: &str,
    offset: u64,
    limit: u32,
) -> Result<QueryOutput, anyhow::Error> {
    validate_collection(collection)?;
    let started = Instant::now();
    let client = client(state, database).await?;
    let mut cursor = client
        .database(&database.database_name)
        .collection::<Document>(collection)
        .find(doc! {})
        .skip(offset)
        .limit(i64::from(limit.saturating_add(1)))
        .await?;
    let mut rows = Vec::new();
    let mut columns = BTreeSet::new();
    while let Some(document) = cursor.try_next().await? {
        columns.extend(document.keys().cloned());
        rows.push(serde_json::to_value(document)?);
    }
    let truncated = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    Ok(QueryOutput {
        columns: columns.into_iter().collect(),
        rows,
        affected_rows: None,
        elapsed_ms: started.elapsed().as_millis(),
        truncated,
    })
}

pub async fn execute(
    state: &State,
    database: &DatabaseRecord,
    command: &str,
) -> Result<QueryOutput, anyhow::Error> {
    let command = command.trim();
    if command.is_empty() || command.len() > 1_048_576 {
        return Err(shared::response::DisplayError::new(
            "MongoDB console input must be a JSON command between 1 byte and 1 MiB",
        )
        .into());
    }
    let command: Document = serde_json::from_str(command).map_err(|error| {
        shared::response::DisplayError::new(format!(
            "MongoDB console input must be a JSON object: {error}"
        ))
    })?;
    if command.is_empty() {
        return Err(shared::response::DisplayError::new("MongoDB command cannot be empty").into());
    }
    let started = Instant::now();
    let client = client(state, database).await?;
    let response = client
        .database(&database.database_name)
        .run_command(command)
        .await?;
    let value = serde_json::to_value(response)?;
    let columns = value
        .as_object()
        .map(|object| object.keys().cloned().collect())
        .unwrap_or_default();
    Ok(QueryOutput {
        columns,
        rows: vec![value],
        affected_rows: None,
        elapsed_ms: started.elapsed().as_millis(),
        truncated: false,
    })
}

pub(super) async fn client(
    state: &State,
    database: &DatabaseRecord,
) -> Result<mongodb::Client, anyhow::Error> {
    let password = database.decrypted_password(state).await?;
    let host = if database.public_host.contains(':') && !database.public_host.starts_with('[') {
        format!("[{}]", database.public_host)
    } else {
        database.public_host.clone()
    };
    let uri = format!(
        "mongodb://{}:{}@{host}:{}/{}?authSource={}&authMechanism=SCRAM-SHA-256&directConnection=true&tls={}",
        urlencoding::encode(&database.username),
        urlencoding::encode(&password),
        database.public_port,
        urlencoding::encode(&database.database_name),
        urlencoding::encode(&database.database_name),
        database.tls,
    );
    let mut options = mongodb::options::ClientOptions::parse(uri).await?;
    // Use one direct SCRAM route through the DBEV gateway.
    options.connect_timeout = Some(std::time::Duration::from_secs(5));
    options.server_selection_timeout = Some(std::time::Duration::from_secs(5));
    Ok(mongodb::Client::with_options(options)?)
}

fn mongodb_gateway_error(error: mongodb::error::Error) -> anyhow::Error {
    tracing::warn!(?error, "MongoDB data-editor gateway connection failed");

    let message = match error.kind.as_ref() {
        mongodb::error::ErrorKind::ServerSelection { message, .. }
            if message.contains("invalid server response") =>
        {
            "The MongoDB database host returned an incomplete protocol handshake. The DatabasesEverywhere daemon's MongoDB gateway must be updated before the data editor can connect."
        }
        mongodb::error::ErrorKind::ServerSelection { .. } => {
            "The Panel could not connect to this MongoDB database host. Verify that the DatabasesEverywhere MongoDB gateway is running and reachable."
        }
        mongodb::error::ErrorKind::Authentication { .. } => {
            "The MongoDB database host rejected the stored credentials. Reconcile the database or reset its password, then try again."
        }
        mongodb::error::ErrorKind::Command(command)
            if command.code == 18
                && command
                    .message
                    .contains("conflicting authentication routes") =>
        {
            "The MongoDB database gateway rejected conflicting authentication routing information. Restart the rebuilt Panel so it uses explicit SCRAM-SHA-256 routing, then try again."
        }
        mongodb::error::ErrorKind::Command(command) if command.code == 18 => {
            "The MongoDB database host rejected the stored credentials. Reconcile the database or reset its password, then try again."
        }
        _ => return error.into(),
    };

    shared::response::DisplayError::new(message)
        .with_status(axum::http::StatusCode::BAD_GATEWAY)
        .into()
}

pub(super) fn validate_collection(collection: &str) -> Result<(), anyhow::Error> {
    if collection.is_empty()
        || collection.len() > 255
        || collection.chars().any(|character| character.is_control())
        || collection.contains('$')
    {
        return Err(shared::response::DisplayError::new("invalid MongoDB collection name").into());
    }
    Ok(())
}
