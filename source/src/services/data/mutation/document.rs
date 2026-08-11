use super::{mutation_output, required_object};
use crate::{
    persistence::DatabaseRecord,
    services::data::{DataMutationInput, DataMutationOperation, QueryOutput},
};
use mongodb::bson::{Bson, Document, doc};
use shared::{State, response::DisplayError};
use std::time::Instant;

pub async fn mutate(
    state: &State,
    database: &DatabaseRecord,
    input: &DataMutationInput,
) -> Result<QueryOutput, anyhow::Error> {
    super::super::document::validate_collection(&input.object)?;
    let started = Instant::now();
    let client = super::super::document::client(state, database).await?;
    let collection = client
        .database(&database.database_name)
        .collection::<Document>(&input.object);

    let affected = match input.operation {
        DataMutationOperation::Insert => {
            required_object("inserted document", input.value.as_ref())?;
            let document = document("inserted document", input.value.as_ref())?;
            collection.insert_one(document).await?;
            1
        }
        DataMutationOperation::Update => {
            required_object("updated document", input.value.as_ref())?;
            let original = document("original document", input.original.as_ref())?;
            let identity = identity(&original)?;
            let mut replacement = document("updated document", input.value.as_ref())?;
            replacement.insert("_id", identity.clone());
            let result = collection
                .replace_one(doc! { "_id": identity }, replacement)
                .await?;
            if result.matched_count != 1 {
                return Err(stale_document_error());
            }
            result.modified_count.max(1)
        }
        DataMutationOperation::Delete => {
            let original = document("original document", input.original.as_ref())?;
            let result = collection
                .delete_one(doc! { "_id": identity(&original)? })
                .await?;
            if result.deleted_count != 1 {
                return Err(stale_document_error());
            }
            result.deleted_count
        }
    };
    Ok(mutation_output(started, Some(affected)))
}

fn document(label: &str, value: Option<&serde_json::Value>) -> Result<Document, anyhow::Error> {
    serde_json::from_value(
        value
            .cloned()
            .ok_or_else(|| DisplayError::new(format!("{label} is required")))?,
    )
    .map_err(|error| {
        DisplayError::new(format!(
            "{label} is not valid MongoDB Extended JSON: {error}"
        ))
        .into()
    })
}

fn identity(document: &Document) -> Result<Bson, anyhow::Error> {
    document.get("_id").cloned().ok_or_else(|| {
        DisplayError::new("MongoDB visual updates and deletes require an _id field").into()
    })
}

fn stale_document_error() -> anyhow::Error {
    DisplayError::new("the document no longer exists; refresh the visual editor and try again")
        .with_status(axum::http::StatusCode::CONFLICT)
        .into()
}
