use serde::{Deserialize, Serialize};
use shared::extensions::settings::{
    ExtensionSettings, SettingsDeserializeExt, SettingsDeserializer, SettingsSerializeExt,
    SettingsSerializer,
};
use utoipa::ToSchema;

pub const MIN_NODE_HEALTH_INTERVAL_SECONDS: u64 = 60;
pub const MAX_NODE_HEALTH_INTERVAL_SECONDS: u64 = 3600;
pub const DEFAULT_NODE_HEALTH_INTERVAL_SECONDS: u64 = 300;

pub fn normalize_node_health_interval(seconds: u64) -> u64 {
    // Upgrade the noisy pre-WebSocket polling default.
    if seconds <= 15 {
        DEFAULT_NODE_HEALTH_INTERVAL_SECONDS
    } else {
        seconds.clamp(
            MIN_NODE_HEALTH_INTERVAL_SECONDS,
            MAX_NODE_HEALTH_INTERVAL_SECONDS,
        )
    }
}

#[derive(Debug, Clone, ToSchema, Serialize, Deserialize)]
pub struct ExtensionSettingsData {
    pub enabled: bool,
    pub panel_url: String,
    pub raw_console_enabled: bool,
    pub query_timeout_seconds: u64,
    pub max_console_rows: u32,
    pub node_health_interval_seconds: u64,
}

impl Default for ExtensionSettingsData {
    fn default() -> Self {
        Self {
            enabled: true,
            panel_url: String::new(),
            raw_console_enabled: true,
            query_timeout_seconds: 10,
            max_console_rows: 500,
            node_health_interval_seconds: DEFAULT_NODE_HEALTH_INTERVAL_SECONDS,
        }
    }
}

#[async_trait::async_trait]
impl SettingsSerializeExt for ExtensionSettingsData {
    async fn serialize(
        &self,
        serializer: SettingsSerializer,
    ) -> Result<SettingsSerializer, anyhow::Error> {
        Ok(serializer.write_serde_setting("configuration", self)?)
    }
}

pub struct ExtensionSettingsDataDeserializer;

#[async_trait::async_trait]
impl SettingsDeserializeExt for ExtensionSettingsDataDeserializer {
    async fn deserialize_boxed(
        &self,
        deserializer: SettingsDeserializer<'_>,
    ) -> Result<ExtensionSettings, anyhow::Error> {
        let mut settings = deserializer
            .read_serde_setting::<ExtensionSettingsData>("configuration")
            .unwrap_or_default();
        settings.node_health_interval_seconds =
            normalize_node_health_interval(settings.node_health_interval_seconds);
        Ok(Box::new(settings))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upgrades_the_legacy_polling_default() {
        assert_eq!(normalize_node_health_interval(15), 300);
    }

    #[test]
    fn clamps_health_intervals_without_changing_valid_values() {
        assert_eq!(normalize_node_health_interval(30), 60);
        assert_eq!(normalize_node_health_interval(600), 600);
        assert_eq!(normalize_node_health_interval(7200), 3600);
    }
}
