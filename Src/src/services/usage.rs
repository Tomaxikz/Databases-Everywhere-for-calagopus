use crate::persistence::DatabaseRecord;
use shared::{
    State,
    models::{server_database::ServerDatabase, server_database_instance::ServerDatabaseInstance},
};

/// Counts databases across every provider sharing the core server limit.
pub async fn total_database_usage(
    state: &State,
    server_uuid: uuid::Uuid,
) -> Result<i64, anyhow::Error> {
    let classic = ServerDatabase::count_by_server_uuid(&state.database, server_uuid).await?;
    let official_agent =
        ServerDatabaseInstance::count_by_server_uuid(&state.database, server_uuid).await?;
    let databases_everywhere = DatabaseRecord::count_all_for_server(state, server_uuid).await?;

    Ok(classic
        .saturating_add(official_agent)
        .saturating_add(databases_everywhere))
}
