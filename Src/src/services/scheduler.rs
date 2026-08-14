use crate::{
    dbev::{DbevClient, validate_system_response},
    domain::{DatabaseProtocol, ResourceLimits, ServerDatabaseConfigurationExtension},
    persistence::{HostAssignment, NodeRecord},
    settings::ExtensionSettingsData,
};
use shared::{
    State,
    models::{BaseModel, server::Server},
    response::DisplayError,
};
use std::cmp::Ordering;

const BYTES_PER_MIB: i64 = 1024 * 1024;

pub struct ScheduledNode {
    pub node: NodeRecord,
    pub limits: ResourceLimits,
    pub system: serde_json::Value,
}

struct Candidate {
    scheduled: ScheduledNode,
    scope_rank: u8,
    host_memory_pressure: f64,
    allocation_pressure: f64,
    cpu_pressure: f64,
}

pub async fn select_node(
    state: &State,
    server: &Server,
    protocol: DatabaseProtocol,
    requested_image: Option<&str>,
) -> Result<ScheduledNode, anyhow::Error> {
    let settings = state.settings.get().await?;
    let extension_settings = settings
        .get_extension_settings::<ExtensionSettingsData>("com.tomaxikz.databaseseverywhere")?;
    if !extension_settings.enabled {
        return Err(DisplayError::new("DatabasesEverywhere is disabled").into());
    }
    drop(settings);

    let configuration = server.parse_model_extension::<ServerDatabaseConfigurationExtension>()?;
    let panel_node = server.node.fetch_cached(&state.database).await?;
    let mut candidates = Vec::new();

    for eligible in
        HostAssignment::eligible_for_panel_node(state, panel_node.uuid, panel_node.location.uuid)
            .await?
    {
        let node = eligible.host;
        if !node.protocol_enabled(protocol) || !node.allows_image(protocol, requested_image) {
            continue;
        }

        let limits = ResourceLimits {
            cpu_cores: configuration.cpu_cores.unwrap_or(node.default_cpu_cores),
            memory_mib: configuration.memory_mib.unwrap_or(node.default_memory_mib),
            disk_mib: configuration.disk_mib.unwrap_or(node.default_disk_mib),
        }
        .with_protocol_floors(protocol);
        if !limits.cpu_cores.is_finite()
            || !(0.01..=1024.0).contains(&limits.cpu_cores)
            || !(1..=1_048_576).contains(&limits.memory_mib)
            || limits.disk_mib < 1
        {
            return Err(DisplayError::new(
                "the resolved DatabasesEverywhere resource limits are invalid",
            )
            .into());
        }

        let client = DbevClient::for_node(state, &node).await?;
        let snapshot = async {
            let heartbeat = client.get::<serde_json::Value>("/api/heartbeat").await?;
            if heartbeat.get("status").and_then(serde_json::Value::as_str) != Some("ok") {
                return Err(anyhow::anyhow!("node heartbeat is not ready"));
            }
            let system = client.get::<serde_json::Value>("/api/system").await?;
            validate_system_response(&system)?;
            validate_system_identity(&node, &system)?;
            if !protocol.enabled_by_system(&system) {
                return Err(anyhow::anyhow!(
                    "{} is disabled on this node",
                    protocol.label()
                ));
            }
            let summary = client
                .get::<serde_json::Value>("/api/admin/resources/summary")
                .await?;
            if let Some(resource) = capacity_failure(&system, &summary, limits) {
                return Err(anyhow::anyhow!(
                    "node has insufficient {resource} allocation capacity"
                ));
            }
            Ok::<_, anyhow::Error>((system, summary))
        }
        .await;

        let (system, summary) = match snapshot {
            Ok(snapshot) => snapshot,
            Err(error) => {
                let message = error.to_string();
                if let Err(store_error) = node.store_health(state, None, None, Some(&message)).await
                {
                    tracing::warn!(node = %node.uuid, error = ?store_error, "failed to store DatabasesEverywhere node health error");
                }
                tracing::warn!(node = %node.uuid, error = ?error, "DatabasesEverywhere node is not eligible");
                continue;
            }
        };

        node.store_health(state, Some(&system), Some(&summary), None)
            .await?;
        candidates.push(Candidate {
            host_memory_pressure: ratio(&summary, "/memory/host_used_bytes", "/memory/total_bytes"),
            allocation_pressure: ratio(
                &summary,
                "/memory/allocated_bytes",
                "/memory/allocation_limit_bytes",
            ),
            cpu_pressure: number(&summary, "/cpu/host_usage_percent").unwrap_or(0.0),
            scope_rank: eligible.assignment_rank as u8,
            scheduled: ScheduledNode {
                node,
                limits,
                system,
            },
        });
    }

    candidates.sort_by(|left, right| {
        left.scope_rank
            .cmp(&right.scope_rank)
            .then_with(|| compare_float(left.host_memory_pressure, right.host_memory_pressure))
            .then_with(|| compare_float(left.allocation_pressure, right.allocation_pressure))
            .then_with(|| compare_float(left.cpu_pressure, right.cpu_pressure))
            .then_with(|| left.scheduled.node.uuid.cmp(&right.scheduled.node.uuid))
    });

    candidates
        .into_iter()
        .next()
        .map(|candidate| candidate.scheduled)
        .ok_or_else(|| {
            DisplayError::new(
                "no eligible DatabasesEverywhere node supports this protocol with enough allocation capacity",
            )
            .with_status(axum::http::StatusCode::EXPECTATION_FAILED)
            .into()
        })
}

fn validate_system_identity(
    node: &NodeRecord,
    system: &serde_json::Value,
) -> Result<(), anyhow::Error> {
    if let Some(actual) = system
        .get("uuid")
        .or_else(|| system.get("node_uuid"))
        .and_then(serde_json::Value::as_str)
        && actual != node.daemon_uuid
    {
        return Err(anyhow::anyhow!(
            "daemon UUID does not match the registered node"
        ));
    }
    if let Some(actual) = system.get("token_id").and_then(serde_json::Value::as_str)
        && actual != node.token_id
    {
        return Err(anyhow::anyhow!(
            "daemon token ID does not match the registered node"
        ));
    }
    Ok(())
}

fn capacity_failure(
    system: &serde_json::Value,
    summary: &serde_json::Value,
    limits: ResourceLimits,
) -> Option<&'static str> {
    if system
        .get("prevent_cpu_overallocation")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true)
    {
        let total = number(summary, "/cpu/total_cores").unwrap_or_default();
        let allocated = number(summary, "/cpu/allocated_cores")
            .unwrap_or_default()
            .max(0.0);
        if total <= 0.0 || allocated + limits.cpu_cores > total + f64::EPSILON {
            return Some("CPU");
        }
    }

    for (resource, requested_mib, guard) in [
        ("memory", limits.memory_mib, "prevent_memory_overallocation"),
        ("disk", limits.disk_mib, "prevent_disk_overallocation"),
    ] {
        if !system
            .get(guard)
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true)
        {
            continue;
        }
        let prefix = format!("/{resource}");
        let allocation_limit =
            integer(summary, &format!("{prefix}/allocation_limit_bytes")).unwrap_or_default();
        let allocated = integer(summary, &format!("{prefix}/allocated_bytes"))
            .unwrap_or_default()
            .max(0);
        let reserved = integer(summary, &format!("{prefix}/reserved_bytes"))
            .unwrap_or_default()
            .max(0);
        let available = integer(summary, &format!("{prefix}/available_bytes"))
            .unwrap_or_default()
            .max(0);
        let requested = requested_mib.saturating_mul(BYTES_PER_MIB);
        if allocation_limit <= 0
            || allocated.saturating_add(requested) > allocation_limit
            || requested.saturating_add(reserved) > available
        {
            return Some(resource);
        }
    }
    None
}

fn integer(value: &serde_json::Value, pointer: &str) -> Option<i64> {
    value.pointer(pointer).and_then(serde_json::Value::as_i64)
}

fn number(value: &serde_json::Value, pointer: &str) -> Option<f64> {
    value.pointer(pointer).and_then(serde_json::Value::as_f64)
}

fn ratio(value: &serde_json::Value, numerator: &str, denominator: &str) -> f64 {
    let numerator = integer(value, numerator).unwrap_or_default().max(0) as f64;
    let denominator = integer(value, denominator).unwrap_or(1).max(1) as f64;
    numerator / denominator
}

fn compare_float(left: f64, right: f64) -> Ordering {
    left.partial_cmp(&right).unwrap_or(Ordering::Equal)
}

#[cfg(test)]
mod tests {
    use super::capacity_failure;
    use crate::domain::ResourceLimits;

    fn system(cpu: bool, memory: bool, disk: bool) -> serde_json::Value {
        serde_json::json!({
            "prevent_cpu_overallocation": cpu,
            "prevent_memory_overallocation": memory,
            "prevent_disk_overallocation": disk
        })
    }

    fn summary() -> serde_json::Value {
        serde_json::json!({
            "cpu": { "total_cores": 8, "allocated_cores": 7.5 },
            "memory": {
                "allocation_limit_bytes": 2_147_483_648_i64,
                "allocated_bytes": 1_073_741_824_i64,
                "reserved_bytes": 0,
                "available_bytes": 2_147_483_648_i64
            },
            "disk": {
                "allocation_limit_bytes": 10_737_418_240_i64,
                "allocated_bytes": 1_073_741_824_i64,
                "reserved_bytes": 0,
                "available_bytes": 10_737_418_240_i64
            }
        })
    }

    #[test]
    fn cpu_guard_uses_configured_core_reservations() {
        let limits = ResourceLimits {
            cpu_cores: 1.0,
            memory_mib: 512,
            disk_mib: 512,
        };
        assert_eq!(
            capacity_failure(&system(true, true, true), &summary(), limits),
            Some("CPU")
        );
        assert_eq!(
            capacity_failure(&system(false, true, true), &summary(), limits),
            None
        );
    }

    #[test]
    fn allocation_guards_are_independent() {
        let limits = ResourceLimits {
            cpu_cores: 0.25,
            memory_mib: 2048,
            disk_mib: 512,
        };
        assert_eq!(
            capacity_failure(&system(true, true, false), &summary(), limits),
            Some("memory")
        );
        assert_eq!(
            capacity_failure(&system(true, false, false), &summary(), limits),
            None
        );
    }
}
