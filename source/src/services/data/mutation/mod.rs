pub mod document;
pub mod http_databases;
pub mod key_value;
pub mod qdrant;
pub mod relational;

use super::QueryOutput;
use std::time::Instant;

pub(super) fn mutation_output(started: Instant, affected_rows: Option<u64>) -> QueryOutput {
    QueryOutput {
        columns: Vec::new(),
        rows: Vec::new(),
        affected_rows,
        elapsed_ms: started.elapsed().as_millis(),
        truncated: false,
    }
}

pub(super) fn required_object<'a>(
    label: &str,
    value: Option<&'a serde_json::Value>,
) -> Result<&'a serde_json::Map<String, serde_json::Value>, anyhow::Error> {
    let object = value
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| {
            shared::response::DisplayError::new(format!("{label} must be a JSON object"))
        })?;
    if object.is_empty() || object.len() > 256 {
        return Err(shared::response::DisplayError::new(format!(
            "{label} must contain between 1 and 256 fields"
        ))
        .into());
    }
    Ok(object)
}
