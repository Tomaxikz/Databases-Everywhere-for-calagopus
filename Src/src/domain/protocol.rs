use garde::Validate;
use serde::{Deserialize, Serialize};
use std::{fmt::Display, str::FromStr};
use utoipa::ToSchema;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum DatabaseProtocol {
    Postgres,
    Mysql,
    Mariadb,
    Redis,
    Valkey,
    Mongodb,
    Clickhouse,
    Qdrant,
}

impl DatabaseProtocol {
    pub const ALL: [Self; 8] = [
        Self::Postgres,
        Self::Mysql,
        Self::Mariadb,
        Self::Redis,
        Self::Valkey,
        Self::Mongodb,
        Self::Clickhouse,
        Self::Qdrant,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Postgres => "postgres",
            Self::Mysql => "mysql",
            Self::Mariadb => "mariadb",
            Self::Redis => "redis",
            Self::Valkey => "valkey",
            Self::Mongodb => "mongodb",
            Self::Clickhouse => "clickhouse",
            Self::Qdrant => "qdrant",
        }
    }

    pub const fn label(self) -> &'static str {
        match self {
            Self::Postgres => "PostgreSQL",
            Self::Mysql => "MySQL",
            Self::Mariadb => "MariaDB",
            Self::Redis => "Redis",
            Self::Valkey => "Valkey",
            Self::Mongodb => "MongoDB",
            Self::Clickhouse => "ClickHouse",
            Self::Qdrant => "Qdrant",
        }
    }

    pub const fn default_gateway_port(self) -> u16 {
        match self {
            Self::Postgres => 20020,
            Self::Mysql => 3308,
            Self::Mariadb => 20021,
            Self::Redis => 20022,
            Self::Valkey => 20027,
            Self::Mongodb => 20023,
            Self::Clickhouse => 20024,
            Self::Qdrant => 20025,
        }
    }

    pub const fn minimum_memory_mib(self) -> i64 {
        match self {
            Self::Mongodb | Self::Clickhouse | Self::Qdrant => 1024,
            _ => 1,
        }
    }

    pub const fn minimum_disk_mib(self) -> i64 {
        match self {
            Self::Mongodb | Self::Clickhouse => 1024,
            Self::Qdrant => 2048,
            _ => 1,
        }
    }

    pub const fn supports_selective_export(self) -> bool {
        !matches!(self, Self::Redis | Self::Valkey | Self::Qdrant)
    }

    pub fn enabled_by_system(self, system: &serde_json::Value) -> bool {
        system
            .get(format!("{}_enabled", self.as_str()))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
    }
}

impl Display for DatabaseProtocol {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for DatabaseProtocol {
    type Err = anyhow::Error;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.to_ascii_lowercase().as_str() {
            "postgres" | "postgresql" => Ok(Self::Postgres),
            "mysql" => Ok(Self::Mysql),
            "mariadb" => Ok(Self::Mariadb),
            "redis" => Ok(Self::Redis),
            "valkey" => Ok(Self::Valkey),
            "mongodb" | "mongo" => Ok(Self::Mongodb),
            "clickhouse" => Ok(Self::Clickhouse),
            "qdrant" => Ok(Self::Qdrant),
            _ => Err(anyhow::anyhow!("unsupported DatabasesEverywhere protocol")),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema, Validate)]
pub struct ResourceLimits {
    #[garde(range(min = 0.01, max = 1024.0))]
    #[schema(minimum = 0.01, maximum = 1024)]
    pub cpu_cores: f64,
    #[garde(range(min = 1, max = 1048576))]
    #[schema(minimum = 1, maximum = 1048576)]
    pub memory_mib: i64,
    #[garde(range(min = 1))]
    #[schema(minimum = 1)]
    pub disk_mib: i64,
}

impl ResourceLimits {
    pub fn with_protocol_floors(mut self, protocol: DatabaseProtocol) -> Self {
        self.memory_mib = self.memory_mib.max(protocol.minimum_memory_mib());
        self.disk_mib = self.disk_mib.max(protocol.minimum_disk_mib());
        self
    }
}
