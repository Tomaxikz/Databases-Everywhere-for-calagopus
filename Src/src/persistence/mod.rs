macro_rules! safe_query {
    (($($argument:tt)*)) => {
        sqlx::query(sqlx::AssertSqlSafe(format!($($argument)*)))
    };
}

macro_rules! safe_query_scalar {
    (($($argument:tt)*)) => {
        sqlx::query_scalar(sqlx::AssertSqlSafe(format!($($argument)*)))
    };
}

mod database;
mod host_assignment;
mod node;
mod node_configuration;
mod operation;

pub use database::{DatabaseRecord, DatabaseRecordApi};
pub use host_assignment::{AssignedHost, HostAssignment, PanelNodeHostAvailability};
pub use node::{GeneratedNodeCredentials, NodeRecord, NodeRecordApi};
pub use node_configuration::{NodeConfigurationSecretsPatch, default_daemon_configuration};
pub use operation::{DeleteInstanceOperation, queue_instance_deletion};

pub const DATABASES_TABLE: &str = "com_tomaxikz_databaseseverywhere_databases";
pub const LOCATION_HOSTS_TABLE: &str = "com_tomaxikz_databaseseverywhere_location_hosts";
pub const NODES_TABLE: &str = "com_tomaxikz_databaseseverywhere_nodes";
pub const PANEL_NODE_HOSTS_TABLE: &str = "com_tomaxikz_databaseseverywhere_panel_node_hosts";
pub const OPERATIONS_TABLE: &str = "com_tomaxikz_databaseseverywhere_operations";
