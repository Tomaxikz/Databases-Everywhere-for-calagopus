use super::{mutation_output, required_object};
use crate::{
    persistence::DatabaseRecord,
    services::data::{DataMutationInput, DataMutationOperation, QueryOutput},
};
use rustis::resp::CommandBuilder;
use shared::{State, response::DisplayError};
use std::time::Instant;

pub async fn mutate(
    state: &State,
    database: &DatabaseRecord,
    input: &DataMutationInput,
) -> Result<QueryOutput, anyhow::Error> {
    validate_key(&input.object)?;
    let started = Instant::now();
    let client = super::super::key_value::client(state, database).await?;

    if matches!(input.operation, DataMutationOperation::Delete) {
        let affected: i64 = client
            .send(CommandBuilder::new(b"DEL").arg(&input.object), None)
            .await?;
        if affected != 1 {
            return Err(DisplayError::new(
                "the Redis key no longer exists; refresh the visual editor and try again",
            )
            .with_status(axum::http::StatusCode::CONFLICT)
            .into());
        }
        return Ok(mutation_output(started, Some(1)));
    }

    let value = required_object("Redis visual value", input.value.as_ref())?;
    let kind = value
        .get("type")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| DisplayError::new("Redis visual value requires a type"))?;
    let payload = value
        .get("value")
        .ok_or_else(|| DisplayError::new("Redis visual value requires a value"))?;
    let temporary = format!("__c7s_editor:{}:{}", database.uuid, uuid::Uuid::new_v4());
    let command = build_command(kind, &temporary, payload)?;
    let preserved_ttl: i64 = client
        .send(CommandBuilder::new(b"PTTL").arg(&input.object), None)
        .await?;
    let requested_ttl = value.get("ttl_ms").and_then(serde_json::Value::as_i64);
    let ttl = requested_ttl.unwrap_or(preserved_ttl);

    let result = async {
        let _: rustis::resp::Value = client.send(command, None).await?;
        if ttl > 0 {
            let _: i64 = client
                .send(
                    CommandBuilder::new(b"PEXPIRE").arg(&temporary).arg(ttl),
                    None,
                )
                .await?;
        }
        let _: String = client
            .send(
                CommandBuilder::new(b"RENAME")
                    .arg(&temporary)
                    .arg(&input.object),
                None,
            )
            .await?;
        Ok::<_, anyhow::Error>(())
    }
    .await;
    if let Err(error) = result {
        let _ = client
            .send::<i64>(CommandBuilder::new(b"DEL").arg(&temporary), None)
            .await;
        return Err(error);
    }
    Ok(mutation_output(started, Some(1)))
}

fn build_command(
    kind: &str,
    key: &str,
    value: &serde_json::Value,
) -> Result<CommandBuilder, anyhow::Error> {
    match kind {
        "string" => Ok(CommandBuilder::new(b"SET").arg(key).arg(scalar(value)?)),
        "hash" => {
            let values = value
                .as_object()
                .ok_or_else(|| DisplayError::new("Redis hash values must be a JSON object"))?;
            if values.is_empty() || values.len() > 10_000 {
                return Err(DisplayError::new("Redis hashes must contain between 1 and 10000 fields").into());
            }
            let mut command = CommandBuilder::new(b"HSET").arg(key);
            for (field, value) in values {
                validate_part("hash field", field)?;
                command = command.arg(field).arg(scalar(value)?);
            }
            Ok(command)
        }
        "list" | "set" => {
            let values = value
                .as_array()
                .ok_or_else(|| DisplayError::new(format!("Redis {kind} values must be a JSON array")))?;
            if values.is_empty() || values.len() > 10_000 {
                return Err(DisplayError::new(format!(
                    "Redis {kind} values must contain between 1 and 10000 items"
                ))
                .into());
            }
            let mut command = CommandBuilder::new(if kind == "list" { b"RPUSH" } else { b"SADD" }).arg(key);
            for value in values {
                command = command.arg(scalar(value)?);
            }
            Ok(command)
        }
        "zset" => {
            let values = value
                .as_object()
                .ok_or_else(|| DisplayError::new("Redis sorted-set values must map members to scores"))?;
            if values.is_empty() || values.len() > 10_000 {
                return Err(DisplayError::new(
                    "Redis sorted sets must contain between 1 and 10000 members",
                )
                .into());
            }
            let mut command = CommandBuilder::new(b"ZADD").arg(key);
            for (member, score) in values {
                validate_part("sorted-set member", member)?;
                let score = score
                    .as_f64()
                    .filter(|score| score.is_finite())
                    .ok_or_else(|| DisplayError::new("Redis sorted-set scores must be finite numbers"))?;
                command = command.arg(score).arg(member);
            }
            Ok(command)
        }
        _ => Err(DisplayError::new(
            "the visual editor supports Redis strings, hashes, lists, sets, and sorted sets; use the console for this key type",
        )
        .into()),
    }
}

fn scalar(value: &serde_json::Value) -> Result<String, anyhow::Error> {
    let value = match value {
        serde_json::Value::String(value) => value.clone(),
        serde_json::Value::Number(_) | serde_json::Value::Bool(_) => value.to_string(),
        serde_json::Value::Null => String::new(),
        _ => {
            return Err(DisplayError::new(
                "Redis values must be strings, numbers, booleans, or null",
            )
            .into());
        }
    };
    if value.len() > 1_048_576 {
        return Err(DisplayError::new("Redis visual values cannot exceed 1 MiB each").into());
    }
    Ok(value)
}

fn validate_key(key: &str) -> Result<(), anyhow::Error> {
    if key.is_empty() || key.len() > 4096 || key.chars().any(char::is_control) {
        return Err(DisplayError::new("invalid Redis key").into());
    }
    Ok(())
}

fn validate_part(label: &str, value: &str) -> Result<(), anyhow::Error> {
    if value.is_empty() || value.len() > 4096 || value.chars().any(char::is_control) {
        return Err(DisplayError::new(format!("invalid Redis {label}")).into());
    }
    Ok(())
}
