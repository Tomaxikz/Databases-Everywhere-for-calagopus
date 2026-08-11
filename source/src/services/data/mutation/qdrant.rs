use super::{mutation_output, required_object};
use crate::{
    persistence::DatabaseRecord,
    services::data::{DataMutationInput, DataMutationOperation, QueryOutput, qdrant},
};
use shared::{State, response::DisplayError};
use std::time::Instant;

pub async fn mutate(
    state: &State,
    database: &DatabaseRecord,
    input: &DataMutationInput,
) -> Result<QueryOutput, anyhow::Error> {
    super::super::http_databases::validate_name(&input.object)?;
    let started = Instant::now();
    let client = qdrant::client(state, database).await?;

    match input.operation {
        DataMutationOperation::Insert => {
            let value = input
                .value
                .as_ref()
                .ok_or_else(|| DisplayError::new("a new Qdrant point is required"))?;
            qdrant::upsert_point(&client, &input.object, qdrant::point_from_json(value)?).await?;
        }
        DataMutationOperation::Update => {
            let original = required_object("original Qdrant point", input.original.as_ref())?;
            let value = required_object("updated Qdrant point", input.value.as_ref())?;
            let original_id = original
                .get("id")
                .ok_or_else(|| DisplayError::new("Qdrant visual updates require a point id"))?;
            if value.get("id").is_some_and(|id| id != original_id) {
                return Err(DisplayError::new(
                    "Qdrant point IDs cannot be changed; create a new point instead",
                )
                .into());
            }

            if value.contains_key("vector") {
                let mut replacement = value.clone();
                replacement.insert("id".to_owned(), original_id.clone());
                qdrant::upsert_point(
                    &client,
                    &input.object,
                    qdrant::point_from_json(&serde_json::Value::Object(replacement))?,
                )
                .await?;
            } else {
                let payload = value.get("payload").cloned().unwrap_or_else(|| {
                    let mut payload = value.clone();
                    payload.remove("id");
                    serde_json::Value::Object(payload)
                });
                qdrant::overwrite_point_payload(
                    &client,
                    &input.object,
                    qdrant::point_id_from_json(original_id)?,
                    qdrant::payload_from_json(&payload)?,
                )
                .await?;
            }
        }
        DataMutationOperation::Delete => {
            let original = required_object("original Qdrant point", input.original.as_ref())?;
            let id = original
                .get("id")
                .ok_or_else(|| DisplayError::new("Qdrant visual deletes require a point id"))?;
            qdrant::delete_point(&client, &input.object, qdrant::point_id_from_json(id)?).await?;
        }
    }

    Ok(mutation_output(started, Some(1)))
}
