use indexmap::IndexMap;
use shared::{
    State,
    extensions::{
        Extension, ExtensionPermissionsBuilder, ExtensionRouteBuilder,
        background_tasks::BackgroundTaskBuilder, settings::ExtensionSettingsDeserializer,
    },
    permissions::PermissionGroup,
};
use std::sync::Arc;

mod dbev;
mod domain;
mod persistence;
mod routes;
mod services;
mod settings;

#[derive(Default)]
pub struct ExtensionStruct;

#[async_trait::async_trait]
impl Extension for ExtensionStruct {
    async fn initialize(&mut self, _state: State) {
        domain::register_server_integration();
        tracing::info!("DatabasesEverywhere extension initialized");
    }

    async fn initialize_router(
        &mut self,
        state: State,
        builder: ExtensionRouteBuilder,
    ) -> ExtensionRouteBuilder {
        let admin_state = state.clone();
        let client_state = state;
        builder
            .add_admin_api_router(move |router| {
                router.nest("/databases-everywhere", routes::admin::router(&admin_state))
            })
            .add_client_server_api_router(move |router| {
                router.nest(
                    "/databases-everywhere",
                    routes::client::router(&client_state),
                )
            })
    }

    async fn initialize_background_tasks(
        &mut self,
        _state: State,
        builder: BackgroundTaskBuilder,
    ) -> BackgroundTaskBuilder {
        builder
            .add_task("databases-everywhere-maintenance", |state| async move {
                services::run_maintenance_loop(state).await;
                Ok(())
            })
            .await;
        builder
    }

    async fn initialize_permissions(
        &mut self,
        _state: State,
        builder: ExtensionPermissionsBuilder,
    ) -> ExtensionPermissionsBuilder {
        builder
            .add_admin_permission_group(
                "databases-everywhere-nodes",
                PermissionGroup {
                    description: "Permissions for managing DatabasesEverywhere nodes and their daemon configuration.",
                    permissions: IndexMap::from([
                        ("read", "Allows viewing DatabasesEverywhere nodes and health."),
                        ("create", "Allows registering DatabasesEverywhere nodes."),
                        ("update", "Allows updating nodes and daemon configuration."),
                        ("assign", "Allows assigning DatabasesEverywhere hosts to panel nodes and locations."),
                        ("delete", "Allows deleting unused DatabasesEverywhere nodes."),
                        ("credentials", "Allows viewing and rotating daemon credentials."),
                        ("operations", "Allows resource, backup, and image operations on nodes."),
                    ]),
                },
            )
            .add_server_permission_group(
                "databases-everywhere",
                PermissionGroup {
                    description: "Permissions for DatabasesEverywhere databases attached to this server.",
                    permissions: IndexMap::from([
                        ("read", "Allows viewing DatabasesEverywhere databases."),
                        ("credentials", "Allows viewing database passwords and connection URIs."),
                        ("create", "Allows creating databases."),
                        ("update", "Allows changing database images and reconciling state."),
                        ("delete", "Allows permanently deleting databases."),
                        ("power", "Allows starting, stopping, restarting, and killing databases."),
                        ("logs", "Allows viewing database logs."),
                        ("data", "Allows browsing database objects and records."),
                        ("data-write", "Allows inserting, editing, and deleting records through the visual editor."),
                        ("console", "Allows executing SQL or protocol-native console commands."),
                        ("transfers", "Allows viewing import/export jobs and artifacts."),
                        ("import", "Allows importing artifacts or remote databases."),
                        ("export", "Allows creating exports and managing artifacts."),
                        ("download", "Allows downloading artifacts and backups."),
                        ("backups", "Allows viewing and browsing backups."),
                        ("backup-create", "Allows creating manual backups."),
                        ("backup-restore", "Allows destructively restoring backups."),
                        ("backup-delete", "Allows deleting backups."),
                    ]),
                },
            )
    }

    async fn settings_deserializer(&self, _state: State) -> ExtensionSettingsDeserializer {
        Arc::new(settings::ExtensionSettingsDataDeserializer)
    }
}
