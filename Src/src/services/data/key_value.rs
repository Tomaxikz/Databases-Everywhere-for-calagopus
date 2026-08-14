use super::{DataObject, QueryOutput};
use crate::persistence::DatabaseRecord;
use base64::Engine;
use rustis::{
    client::Client,
    commands::{GenericCommands, ScanOptions},
    resp::{CommandBuilder, Value},
};
use shared::State;
use std::time::Instant;

pub async fn overview(
    state: &State,
    database: &DatabaseRecord,
) -> Result<Vec<DataObject>, anyhow::Error> {
    let client = client(state, database).await?;
    let mut cursor = 0_u64;
    let mut keys = Vec::new();
    loop {
        let (next, batch): (u64, Vec<String>) = client
            .scan(cursor, ScanOptions::default().count(500))
            .await?;
        keys.extend(batch);
        cursor = next;
        if cursor == 0 || keys.len() >= 5000 {
            break;
        }
    }
    keys.sort();
    keys.truncate(5000);
    Ok(keys
        .into_iter()
        .map(|name| DataObject {
            name,
            namespace: None,
            kind: "key".to_owned(),
            metadata: serde_json::json!({}),
        })
        .collect())
}

pub async fn browse(
    state: &State,
    database: &DatabaseRecord,
    key: &str,
) -> Result<QueryOutput, anyhow::Error> {
    if key.is_empty() || key.len() > 4096 || key.chars().any(char::is_control) {
        return Err(shared::response::DisplayError::new("invalid Redis key").into());
    }
    let started = Instant::now();
    let client = client(state, database).await?;
    let key_type: String = client
        .send(CommandBuilder::new(b"TYPE").arg(key), None)
        .await?;
    let command = match key_type.as_str() {
        "string" => CommandBuilder::new(b"GET").arg(key),
        "hash" => CommandBuilder::new(b"HGETALL").arg(key),
        "list" => CommandBuilder::new(b"LRANGE").arg(key).arg(0).arg(499),
        "set" => CommandBuilder::new(b"SMEMBERS").arg(key),
        "zset" => CommandBuilder::new(b"ZRANGE")
            .arg(key)
            .arg(0)
            .arg(499)
            .arg("WITHSCORES"),
        "stream" => CommandBuilder::new(b"XRANGE")
            .arg(key)
            .arg("-")
            .arg("+")
            .arg("COUNT")
            .arg(500),
        "none" => {
            return Err(
                shared::response::DisplayError::new("Redis key was not found")
                    .with_status(axum::http::StatusCode::NOT_FOUND)
                    .into(),
            );
        }
        _ => CommandBuilder::new(b"DUMP").arg(key),
    };
    let response: Value = client.send(command, None).await?;
    Ok(QueryOutput {
        columns: vec!["type".to_owned(), "value".to_owned()],
        rows: vec![serde_json::json!({
            "type": key_type,
            "value": redis_value(response),
        })],
        affected_rows: None,
        elapsed_ms: started.elapsed().as_millis(),
        truncated: false,
    })
}

pub async fn execute(
    state: &State,
    database: &DatabaseRecord,
    command: &str,
) -> Result<QueryOutput, anyhow::Error> {
    let arguments = tokenize(command)?;
    let Some((name, arguments)) = arguments.split_first() else {
        return Err(shared::response::DisplayError::new("Redis command cannot be empty").into());
    };
    let name = name.to_ascii_uppercase();
    assert_safe_command(&name)?;
    let started = Instant::now();
    let client = client(state, database).await?;
    let mut command = CommandBuilder::new(name.as_bytes());
    for argument in arguments {
        command = command.arg(argument);
    }
    let response: Value = client.send(command, Some(false)).await?;
    Ok(QueryOutput {
        columns: vec!["result".to_owned()],
        rows: vec![serde_json::json!({ "result": redis_value(response) })],
        affected_rows: None,
        elapsed_ms: started.elapsed().as_millis(),
        truncated: false,
    })
}

pub(super) async fn client(
    state: &State,
    database: &DatabaseRecord,
) -> Result<Client, anyhow::Error> {
    let password = database.decrypted_password(state).await?;
    let scheme = if database.tls { "rediss" } else { "redis" };
    let host = if database.public_host.contains(':') && !database.public_host.starts_with('[') {
        format!("[{}]", database.public_host)
    } else {
        database.public_host.clone()
    };
    let uri = format!(
        "{scheme}://{}:{}@{host}:{}/0",
        urlencoding::encode(&database.username),
        urlencoding::encode(&password),
        database.public_port,
    );
    Ok(Client::connect(uri).await?)
}

fn assert_safe_command(command: &str) -> Result<(), anyhow::Error> {
    const DENIED: &[&str] = &[
        "ACL",
        "AUTH",
        "BGREWRITEAOF",
        "BGSAVE",
        "CLIENT",
        "CLUSTER",
        "COMMAND",
        "CONFIG",
        "DEBUG",
        "EVAL",
        "EVALSHA",
        "FCALL",
        "FCALL_RO",
        "FUNCTION",
        "HELLO",
        "LATENCY",
        "MEMORY",
        "MIGRATE",
        "MODULE",
        "MONITOR",
        "PSYNC",
        "REPLICAOF",
        "RESTORE-ASKING",
        "SAVE",
        "SCRIPT",
        "SELECT",
        "SHUTDOWN",
        "SLAVEOF",
        "SYNC",
    ];
    if DENIED.contains(&command) {
        return Err(shared::response::DisplayError::new(
            "that Redis administrative command is not available in the database console",
        )
        .into());
    }
    Ok(())
}

fn tokenize(input: &str) -> Result<Vec<String>, anyhow::Error> {
    if input.len() > 1_048_576 {
        return Err(shared::response::DisplayError::new("Redis command is too large").into());
    }
    let mut arguments = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut escaped = false;
    for character in input.trim().chars() {
        if escaped {
            current.push(character);
            escaped = false;
            continue;
        }
        if character == '\\' {
            escaped = true;
            continue;
        }
        if let Some(delimiter) = quote {
            if character == delimiter {
                quote = None;
            } else {
                current.push(character);
            }
            continue;
        }
        if matches!(character, '\'' | '"') {
            quote = Some(character);
        } else if character.is_whitespace() {
            if !current.is_empty() {
                arguments.push(std::mem::take(&mut current));
            }
        } else {
            current.push(character);
        }
    }
    if escaped || quote.is_some() {
        return Err(shared::response::DisplayError::new(
            "Redis command contains an unterminated quote or escape",
        )
        .into());
    }
    if !current.is_empty() {
        arguments.push(current);
    }
    Ok(arguments)
}

fn redis_value(value: Value) -> serde_json::Value {
    match value {
        Value::SimpleString(value) => serde_json::Value::String(value),
        Value::Integer(value) => serde_json::Value::from(value),
        Value::Double(value) => serde_json::Value::from(value),
        Value::BulkString(value) => match String::from_utf8(value) {
            Ok(value) => serde_json::Value::String(value),
            Err(error) => serde_json::json!({
                "encoding": "base64",
                "data": base64::engine::general_purpose::STANDARD.encode(error.into_bytes()),
            }),
        },
        Value::Boolean(value) => serde_json::Value::Bool(value),
        Value::Array(values) | Value::Set(values) | Value::Push(values) => {
            serde_json::Value::Array(values.into_iter().map(redis_value).collect())
        }
        Value::Map(values) => serde_json::Value::Array(
            values
                .into_iter()
                .map(|(key, value)| serde_json::json!([redis_value(key), redis_value(value)]))
                .collect(),
        ),
        Value::Error(error) => serde_json::json!({ "error": error.to_string() }),
        Value::Null => serde_json::Value::Null,
    }
}
