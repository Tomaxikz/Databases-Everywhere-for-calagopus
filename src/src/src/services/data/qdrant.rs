use super::{DataObject, QueryOutput};
use crate::persistence::DatabaseRecord;
use qdrant_client::{
    Payload, Qdrant,
    qdrant::{
        DeletePointsBuilder, GetPointsBuilder, PointId, PointStruct, PointsIdsList,
        ScrollPointsBuilder, SetPayloadPointsBuilder, UpsertPointsBuilder, Vector, Vectors,
        point_id::PointIdOptions, vector_output, vectors_output,
    },
};
use serde::Deserialize;
use shared::{State, response::DisplayError};
use std::{collections::HashMap, time::Instant};

const MAX_VISUAL_SCROLL: u64 = 5_000;

pub async fn overview(
    state: &State,
    database: &DatabaseRecord,
) -> Result<Vec<DataObject>, anyhow::Error> {
    let response = client(state, database)
        .await?
        .list_collections()
        .await
        .map_err(|error| request_error("listing Qdrant collections", error))?;
    Ok(response
        .collections
        .into_iter()
        .map(|collection| {
            let name = collection.name;
            DataObject {
                metadata: serde_json::json!({ "name": name.clone() }),
                name,
                namespace: None,
                kind: "collection".to_owned(),
            }
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
    if offset.saturating_add(u64::from(limit)) > MAX_VISUAL_SCROLL {
        return Err(DisplayError::new(
            "Qdrant visual browsing is limited to the first 5,000 points; use the console with point IDs for deeper access",
        )
        .into());
    }
    let started = Instant::now();
    let response = client(state, database)
        .await?
        .scroll(
            ScrollPointsBuilder::new(collection)
                .limit(u32::try_from(offset + u64::from(limit))?)
                .with_payload(true)
                .with_vectors(true),
        )
        .await
        .map_err(|error| request_error("scrolling Qdrant points", error))?;
    let has_more = response.next_page_offset.is_some();
    let rows = response
        .result
        .into_iter()
        .skip(usize::try_from(offset)?)
        .take(limit as usize)
        .map(point_to_json)
        .collect();
    Ok(QueryOutput {
        columns: vec!["id".to_owned(), "payload".to_owned(), "vector".to_owned()],
        rows,
        affected_rows: None,
        elapsed_ms: started.elapsed().as_millis(),
        truncated: has_more,
    })
}

pub async fn execute(
    state: &State,
    database: &DatabaseRecord,
    command: &str,
    max_rows: u32,
) -> Result<QueryOutput, anyhow::Error> {
    let command: ConsoleCommand = serde_json::from_str(command).map_err(|error| {
        DisplayError::new(format!(
            "Qdrant console input must be a supported JSON command: {error}"
        ))
    })?;
    let started = Instant::now();
    let client = client(state, database).await?;

    match command {
        ConsoleCommand::ListCollections => {
            let response = client
                .list_collections()
                .await
                .map_err(|error| request_error("listing Qdrant collections", error))?;
            let mut rows = response
                .collections
                .into_iter()
                .map(|collection| serde_json::json!({ "name": collection.name }))
                .collect::<Vec<_>>();
            let truncated = rows.len() > max_rows as usize;
            rows.truncate(max_rows as usize);
            Ok(query_output(
                started,
                vec!["name".to_owned()],
                rows,
                None,
                truncated,
            ))
        }
        ConsoleCommand::Scroll {
            collection,
            limit,
            with_vectors,
        } => {
            validate_collection(&collection)?;
            let limit = limit.unwrap_or(max_rows).clamp(1, max_rows);
            let response = client
                .scroll(
                    ScrollPointsBuilder::new(collection)
                        .limit(limit)
                        .with_payload(true)
                        .with_vectors(with_vectors),
                )
                .await
                .map_err(|error| request_error("scrolling Qdrant points", error))?;
            let truncated = response.next_page_offset.is_some();
            let rows = response.result.into_iter().map(point_to_json).collect();
            Ok(query_output(
                started,
                vec!["id".to_owned(), "payload".to_owned(), "vector".to_owned()],
                rows,
                None,
                truncated,
            ))
        }
        ConsoleCommand::Get {
            collection,
            ids,
            with_vectors,
        } => {
            validate_collection(&collection)?;
            let ids = point_ids(&ids, max_rows)?;
            let response = client
                .get_points(
                    GetPointsBuilder::new(collection, ids)
                        .with_payload(true)
                        .with_vectors(with_vectors),
                )
                .await
                .map_err(|error| request_error("retrieving Qdrant points", error))?;
            let rows = response.result.into_iter().map(point_to_json).collect();
            Ok(query_output(
                started,
                vec!["id".to_owned(), "payload".to_owned(), "vector".to_owned()],
                rows,
                None,
                false,
            ))
        }
        ConsoleCommand::Upsert { collection, points } => {
            validate_collection(&collection)?;
            ensure_item_count("Qdrant points", points.len(), max_rows)?;
            let count = points.len() as u64;
            let points = points
                .iter()
                .map(point_from_json)
                .collect::<Result<Vec<_>, _>>()?;
            client
                .upsert_points(UpsertPointsBuilder::new(collection, points).wait(true))
                .await
                .map_err(|error| request_error("upserting Qdrant points", error))?;
            Ok(query_output(
                started,
                Vec::new(),
                Vec::new(),
                Some(count),
                false,
            ))
        }
        ConsoleCommand::Delete { collection, ids } => {
            validate_collection(&collection)?;
            let ids = point_ids(&ids, max_rows)?;
            let count = ids.len() as u64;
            client
                .delete_points(
                    DeletePointsBuilder::new(collection)
                        .points(PointsIdsList { ids })
                        .wait(true),
                )
                .await
                .map_err(|error| request_error("deleting Qdrant points", error))?;
            Ok(query_output(
                started,
                Vec::new(),
                Vec::new(),
                Some(count),
                false,
            ))
        }
        ConsoleCommand::OverwritePayload {
            collection,
            ids,
            payload,
        } => {
            validate_collection(&collection)?;
            let ids = point_ids(&ids, max_rows)?;
            let count = ids.len() as u64;
            let payload = payload_from_json(&payload)?;
            client
                .overwrite_payload(
                    SetPayloadPointsBuilder::new(collection, HashMap::from(payload))
                        .points_selector(PointsIdsList { ids })
                        .wait(true),
                )
                .await
                .map_err(|error| request_error("overwriting Qdrant payloads", error))?;
            Ok(query_output(
                started,
                Vec::new(),
                Vec::new(),
                Some(count),
                false,
            ))
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
enum ConsoleCommand {
    ListCollections,
    Scroll {
        collection: String,
        limit: Option<u32>,
        #[serde(default)]
        with_vectors: bool,
    },
    Get {
        collection: String,
        ids: Vec<serde_json::Value>,
        #[serde(default)]
        with_vectors: bool,
    },
    Upsert {
        collection: String,
        points: Vec<serde_json::Value>,
    },
    Delete {
        collection: String,
        ids: Vec<serde_json::Value>,
    },
    OverwritePayload {
        collection: String,
        ids: Vec<serde_json::Value>,
        payload: serde_json::Value,
    },
}

pub(super) async fn client(
    state: &State,
    database: &DatabaseRecord,
) -> Result<Qdrant, anyhow::Error> {
    let password = database.decrypted_password(state).await?;
    let scheme = if database.tls { "https" } else { "http" };
    let endpoint = format!(
        "{scheme}://{}:{}",
        bracket_host(&database.public_host),
        database.public_port,
    );
    Qdrant::from_url(&endpoint)
        .api_key(password)
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(300))
        .skip_compatibility_check()
        .build()
        .map_err(|error| request_error("configuring the Qdrant gRPC client", error))
}

pub(super) async fn upsert_point(
    client: &Qdrant,
    collection: &str,
    point: PointStruct,
) -> Result<(), anyhow::Error> {
    client
        .upsert_points(UpsertPointsBuilder::new(collection, vec![point]).wait(true))
        .await
        .map_err(|error| request_error("upserting a Qdrant point", error))?;
    Ok(())
}

pub(super) async fn overwrite_point_payload(
    client: &Qdrant,
    collection: &str,
    id: PointId,
    payload: Payload,
) -> Result<(), anyhow::Error> {
    client
        .overwrite_payload(
            SetPayloadPointsBuilder::new(collection, HashMap::from(payload))
                .points_selector(PointsIdsList { ids: vec![id] })
                .wait(true),
        )
        .await
        .map_err(|error| request_error("overwriting a Qdrant point payload", error))?;
    Ok(())
}

pub(super) async fn delete_point(
    client: &Qdrant,
    collection: &str,
    id: PointId,
) -> Result<(), anyhow::Error> {
    client
        .delete_points(
            DeletePointsBuilder::new(collection)
                .points(PointsIdsList { ids: vec![id] })
                .wait(true),
        )
        .await
        .map_err(|error| request_error("deleting a Qdrant point", error))?;
    Ok(())
}

pub(super) fn point_from_json(value: &serde_json::Value) -> Result<PointStruct, anyhow::Error> {
    let point = value
        .as_object()
        .ok_or_else(|| DisplayError::new("a Qdrant point must be a JSON object"))?;
    let id_value = point
        .get("id")
        .ok_or_else(|| DisplayError::new("a Qdrant point requires an id"))?;
    let id = point_id_from_json(id_value)?;
    let vector_value = point
        .get("vector")
        .ok_or_else(|| DisplayError::new("a Qdrant point requires a vector"))?;
    let vectors = vectors_from_json(vector_value)?;
    let payload = match point.get("payload") {
        Some(payload) => payload_from_json(payload)?,
        None => Payload::new(),
    };
    Ok(PointStruct::new(id, vectors, payload))
}

pub(super) fn point_id_from_json(value: &serde_json::Value) -> Result<PointId, anyhow::Error> {
    match value {
        serde_json::Value::Number(number) => number.as_u64().map(PointId::from).ok_or_else(|| {
            DisplayError::new("Qdrant numeric point IDs must be unsigned integers").into()
        }),
        serde_json::Value::String(value) => uuid::Uuid::parse_str(value)
            .map(|value| PointId::from(value.to_string()))
            .map_err(|_| DisplayError::new("Qdrant string point IDs must be valid UUIDs").into()),
        _ => Err(
            DisplayError::new("Qdrant point IDs must be unsigned integers or UUID strings").into(),
        ),
    }
}

pub(super) fn payload_from_json(value: &serde_json::Value) -> Result<Payload, anyhow::Error> {
    Payload::try_from(value.clone()).map_err(|error| {
        DisplayError::new(format!("Qdrant payload must be a JSON object: {error}")).into()
    })
}

fn vectors_from_json(value: &serde_json::Value) -> Result<Vectors, DisplayError<'static>> {
    match value {
        serde_json::Value::Array(values) => Ok(vector_from_array(values)?.into()),
        serde_json::Value::Object(values)
            if values.contains_key("indices") && values.contains_key("values") =>
        {
            Ok(sparse_vector(values)?.into())
        }
        serde_json::Value::Object(values) => {
            if values.is_empty() {
                return Err(DisplayError::new("Qdrant named vectors cannot be empty"));
            }
            let vectors = values
                .iter()
                .map(|(name, value)| {
                    if name.is_empty() {
                        return Err(DisplayError::new("Qdrant vector names cannot be empty"));
                    }
                    let vector = match value {
                        serde_json::Value::Array(values) => vector_from_array(values)?,
                        serde_json::Value::Object(values) => sparse_vector(values)?,
                        _ => {
                            return Err(DisplayError::new(
                                "Qdrant named vectors must be dense, sparse, or multi-vector arrays",
                            ));
                        }
                    };
                    Ok((name.clone(), vector))
                })
                .collect::<Result<HashMap<_, _>, DisplayError<'static>>>()?;
            Ok(vectors.into())
        }
        _ => Err(DisplayError::new(
            "Qdrant vectors must be a dense array, multi-vector array, sparse object, or named-vector object",
        )),
    }
}

fn vector_from_array(values: &[serde_json::Value]) -> Result<Vector, DisplayError<'static>> {
    if values.is_empty() {
        return Err(DisplayError::new("Qdrant vectors cannot be empty"));
    }
    if values.iter().all(serde_json::Value::is_array) {
        let vectors = values
            .iter()
            .map(|value| float_vector(value.as_array().unwrap()))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Vector::from(vectors))
    } else {
        Ok(Vector::from(float_vector(values)?))
    }
}

fn sparse_vector(
    value: &serde_json::Map<String, serde_json::Value>,
) -> Result<Vector, DisplayError<'static>> {
    let indices = value
        .get("indices")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| DisplayError::new("Qdrant sparse vectors require an indices array"))?
        .iter()
        .map(|value| {
            value
                .as_u64()
                .and_then(|value| u32::try_from(value).ok())
                .ok_or_else(|| {
                    DisplayError::new(
                        "Qdrant sparse-vector indices must be unsigned 32-bit integers",
                    )
                })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let values = value
        .get("values")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| DisplayError::new("Qdrant sparse vectors require a values array"))?;
    let values = float_vector(values)?;
    if indices.is_empty() || indices.len() != values.len() {
        return Err(DisplayError::new(
            "Qdrant sparse-vector indices and values must be non-empty and have the same length",
        ));
    }
    Ok(Vector::from(
        indices.into_iter().zip(values).collect::<Vec<_>>(),
    ))
}

fn float_vector(values: &[serde_json::Value]) -> Result<Vec<f32>, DisplayError<'static>> {
    if values.is_empty() {
        return Err(DisplayError::new("Qdrant vectors cannot be empty"));
    }
    values
        .iter()
        .map(|value| {
            let value = value
                .as_f64()
                .ok_or_else(|| DisplayError::new("Qdrant vector values must be numbers"))?;
            let converted = value as f32;
            if !value.is_finite() || !converted.is_finite() {
                return Err(DisplayError::new("Qdrant vector values must be finite"));
            }
            Ok(converted)
        })
        .collect()
}

fn point_to_json(point: qdrant_client::qdrant::RetrievedPoint) -> serde_json::Value {
    let payload = point
        .payload
        .into_iter()
        .map(|(key, value)| (key, serde_json::Value::from(value)))
        .collect::<serde_json::Map<_, _>>();
    let mut row = serde_json::Map::from_iter([
        (
            "id".to_owned(),
            point
                .id
                .map(point_id_to_json)
                .unwrap_or(serde_json::Value::Null),
        ),
        ("payload".to_owned(), serde_json::Value::Object(payload)),
    ]);
    if let Some(vectors) = point.vectors {
        row.insert("vector".to_owned(), vectors_to_json(vectors));
    }
    serde_json::Value::Object(row)
}

fn point_id_to_json(id: PointId) -> serde_json::Value {
    match id.point_id_options {
        Some(PointIdOptions::Num(value)) => serde_json::Value::from(value),
        Some(PointIdOptions::Uuid(value)) => serde_json::Value::String(value),
        None => serde_json::Value::Null,
    }
}

fn vectors_to_json(vectors: qdrant_client::qdrant::VectorsOutput) -> serde_json::Value {
    match vectors.vectors_options {
        Some(vectors_output::VectorsOptions::Vector(vector)) => {
            vector_to_json(vector.into_vector())
        }
        Some(vectors_output::VectorsOptions::Vectors(vectors)) => serde_json::Value::Object(
            vectors
                .vectors
                .into_iter()
                .map(|(name, vector)| (name, vector_to_json(vector.into_vector())))
                .collect(),
        ),
        None => serde_json::Value::Null,
    }
}

fn vector_to_json(vector: vector_output::Vector) -> serde_json::Value {
    match vector {
        vector_output::Vector::Dense(vector) => serde_json::json!(vector.data),
        vector_output::Vector::Sparse(vector) => {
            serde_json::json!({ "indices": vector.indices, "values": vector.values })
        }
        vector_output::Vector::MultiDense(vector) => serde_json::json!(
            vector
                .vectors
                .into_iter()
                .map(|vector| vector.data)
                .collect::<Vec<_>>()
        ),
    }
}

fn point_ids(values: &[serde_json::Value], max_rows: u32) -> Result<Vec<PointId>, anyhow::Error> {
    ensure_item_count("Qdrant point IDs", values.len(), max_rows)?;
    values.iter().map(point_id_from_json).collect()
}

fn ensure_item_count(label: &str, count: usize, max_rows: u32) -> Result<(), anyhow::Error> {
    if count == 0 || count > max_rows as usize {
        return Err(DisplayError::new(format!(
            "{label} must contain between 1 and {max_rows} items"
        ))
        .into());
    }
    Ok(())
}

fn query_output(
    started: Instant,
    columns: Vec<String>,
    rows: Vec<serde_json::Value>,
    affected_rows: Option<u64>,
    truncated: bool,
) -> QueryOutput {
    QueryOutput {
        columns,
        rows,
        affected_rows,
        elapsed_ms: started.elapsed().as_millis(),
        truncated,
    }
}

fn validate_collection(collection: &str) -> Result<(), anyhow::Error> {
    super::http_databases::validate_name(collection)
}

fn request_error(context: &str, error: impl std::fmt::Display) -> anyhow::Error {
    DisplayError::new(format!("error {context}: {error}"))
        .with_status(axum::http::StatusCode::BAD_GATEWAY)
        .into()
}

fn bracket_host(host: &str) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use qdrant_client::qdrant::{vector, vectors::VectorsOptions};

    #[test]
    fn parses_dense_point_with_payload() {
        let point = point_from_json(&serde_json::json!({
            "id": 42,
            "vector": [0.25, 0.5, 0.75],
            "payload": { "kind": "example" }
        }))
        .expect("valid dense point");

        assert_eq!(point.id.map(point_id_to_json), Some(serde_json::json!(42)));
        assert!(point.payload.contains_key("kind"));
        assert!(matches!(
            point.vectors.and_then(|vectors| vectors.vectors_options),
            Some(VectorsOptions::Vector(Vector {
                vector: Some(vector::Vector::Dense(_)),
                ..
            }))
        ));
    }

    #[test]
    fn parses_named_dense_and_sparse_vectors() {
        let vectors = vectors_from_json(&serde_json::json!({
            "dense": [1.0, 2.0],
            "sparse": { "indices": [2, 9], "values": [0.4, 0.8] }
        }))
        .expect("valid named vectors");

        let Some(VectorsOptions::Vectors(vectors)) = vectors.vectors_options else {
            panic!("expected named vectors");
        };
        assert!(matches!(
            vectors.vectors["dense"].vector,
            Some(vector::Vector::Dense(_))
        ));
        assert!(matches!(
            vectors.vectors["sparse"].vector,
            Some(vector::Vector::Sparse(_))
        ));
    }

    #[test]
    fn rejects_invalid_ids_and_payloads() {
        assert!(point_id_from_json(&serde_json::json!(-1)).is_err());
        assert!(point_id_from_json(&serde_json::json!("not-a-uuid")).is_err());
        assert!(
            point_id_from_json(&serde_json::json!("019fe17b-a0c9-7731-b110-9b077c43535c")).is_ok()
        );
        assert!(payload_from_json(&serde_json::json!(["not", "an", "object"])).is_err());
    }
}
