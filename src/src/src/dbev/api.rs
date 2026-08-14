use axum::http::StatusCode;
use semver::Version;
use shared::response::DisplayError;

pub const SUPPORTED_API_VERSION: &str = "0.12.0";
pub const MINIMUM_API_VERSION: &str = "0.10.0";
pub const TEMPORARY_UPLOAD_API_VERSION: &str = "0.11.0";
pub const DISCOVERY_AND_SCHEDULER_API_VERSION: &str = "0.12.0";
pub const DBEV_SERVICE: &str = "databases-everywhere";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DbevCapabilities {
    pub stored_tenant_credentials: bool,
    pub temporary_dump_uploads: bool,
    pub mongodb_source_discovery: bool,
    pub scheduler_recommendations: bool,
}

impl DbevCapabilities {
    pub fn from_system(system: &serde_json::Value) -> Self {
        Self {
            stored_tenant_credentials: version_at_least(system, "api_version", MINIMUM_API_VERSION),
            temporary_dump_uploads: version_at_least(
                system,
                "api_version",
                TEMPORARY_UPLOAD_API_VERSION,
            ),
            mongodb_source_discovery: version_at_least(
                system,
                "api_version",
                DISCOVERY_AND_SCHEDULER_API_VERSION,
            ),
            scheduler_recommendations: version_at_least(
                system,
                "api_version",
                DISCOVERY_AND_SCHEDULER_API_VERSION,
            ),
        }
    }
}

fn parse_version(value: &str) -> Option<Version> {
    Version::parse(value.trim().trim_start_matches('v')).ok()
}

fn version_at_least(system: &serde_json::Value, field: &str, minimum: &str) -> bool {
    let Some(advertised) = system
        .get(field)
        .and_then(serde_json::Value::as_str)
        .and_then(parse_version)
    else {
        return false;
    };
    let minimum = Version::parse(minimum).expect("valid DBEV capability version");
    advertised >= minimum
}

pub fn mutation_contract_block_reason(system: Option<&serde_json::Value>) -> Option<String> {
    let Some(system) = system else {
        return Some(
            "The DatabasesEverywhere node has not been sampled yet. Test the connection before changing node or database state."
                .to_owned(),
        );
    };

    let service = system
        .get("service")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("an unknown service");
    if service != DBEV_SERVICE {
        return Some(format!(
            "This extension requires the {DBEV_SERVICE} service, but this node reports {service}. Read-only diagnostics remain available."
        ));
    }

    let advertised = system
        .get("api_version")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("an unknown version");
    if advertised != SUPPORTED_API_VERSION {
        return Some(format!(
            "This extension supports DatabasesEverywhere API {SUPPORTED_API_VERSION}, but this node reports {advertised}. Update the extension or daemon before changing node or database state."
        ));
    }

    for field in [
        "prevent_cpu_overallocation",
        "prevent_memory_overallocation",
        "prevent_disk_overallocation",
    ] {
        if system
            .get(field)
            .and_then(serde_json::Value::as_bool)
            .is_none()
        {
            return Some(format!(
                "DatabasesEverywhere API {SUPPORTED_API_VERSION} response is missing required field {field}"
            ));
        }
    }
    None
}

pub fn validate_system_response(system: &serde_json::Value) -> Result<(), anyhow::Error> {
    if let Some(reason) = mutation_contract_block_reason(Some(system)) {
        return Err(DisplayError::new(reason)
            .with_status(StatusCode::CONFLICT)
            .into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_exact_mutation_contract() {
        assert!(
            validate_system_response(&serde_json::json!({
                "service": "databases-everywhere",
                "api_version": "0.12.0",
                "prevent_cpu_overallocation": true,
                "prevent_memory_overallocation": true,
                "prevent_disk_overallocation": true
            }))
            .is_ok()
        );
    }

    #[test]
    fn rejects_older_or_incomplete_system_contracts() {
        assert!(
            validate_system_response(&serde_json::json!({
                "api_version": "0.9.0",
                "service": "databases-everywhere",
                "prevent_cpu_overallocation": true,
                "prevent_memory_overallocation": true,
                "prevent_disk_overallocation": true
            }))
            .is_err()
        );
        assert!(
            validate_system_response(&serde_json::json!({
                "api_version": "0.10.0",
                "service": "databases-everywhere",
                "prevent_cpu_overallocation": true
            }))
            .is_err()
        );
        assert!(
            validate_system_response(&serde_json::json!({
                "service": "something-else",
                "api_version": "0.12.0",
                "prevent_cpu_overallocation": true,
                "prevent_memory_overallocation": true,
                "prevent_disk_overallocation": true
            }))
            .is_err()
        );
    }

    #[test]
    fn detects_v010_capabilities_from_the_api_contract() {
        let capabilities = DbevCapabilities::from_system(&serde_json::json!({
            "api_version": "0.10.0"
        }));
        assert!(capabilities.stored_tenant_credentials);
        assert!(!capabilities.temporary_dump_uploads);
        assert!(!capabilities.mongodb_source_discovery);
        assert!(!capabilities.scheduler_recommendations);
    }

    #[test]
    fn capabilities_use_semantic_api_versions_and_ignore_binary_versions() {
        assert!(
            DbevCapabilities::from_system(&serde_json::json!({
                "api_version": "0.11.0",
                "version": "0.5.1"
            }))
            .temporary_dump_uploads
        );
        let current = DbevCapabilities::from_system(&serde_json::json!({
            "api_version": "0.12.0",
            "version": "0.0.1"
        }));
        assert!(current.temporary_dump_uploads);
        assert!(current.mongodb_source_discovery);
        assert!(current.scheduler_recommendations);
        assert!(
            !DbevCapabilities::from_system(&serde_json::json!({
                "api_version": "0.10.99",
                "version": "99.0.0"
            }))
            .temporary_dump_uploads
        );
        assert!(
            !DbevCapabilities::from_system(&serde_json::json!({
                "api_version": "0.11.99",
                "version": "99.0.0"
            }))
            .mongodb_source_discovery
        );
    }
}
