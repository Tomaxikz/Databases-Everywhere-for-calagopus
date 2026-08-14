use semver::{Version, VersionReq};
use shared::response::DisplayError;

pub const SUPPORTED_API_VERSION: &str = "0.12.0";
pub const MINIMUM_API_VERSION: &str = "0.10.0";
pub const TEMPORARY_UPLOAD_API_VERSION: &str = "0.11.0";
pub const DISCOVERY_AND_SCHEDULER_API_VERSION: &str = "0.12.0";

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

pub fn validate_system_response(system: &serde_json::Value) -> Result<(), anyhow::Error> {
    let advertised = system
        .get("api_version")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| DisplayError::new("DatabasesEverywhere did not report an API version"))?;
    let advertised = Version::parse(advertised)
        .map_err(|_| DisplayError::new("DatabasesEverywhere reported an invalid API version"))?;
    let requirement = VersionReq::parse(">=0.10.0, <0.13.0").expect("valid DBEV API requirement");
    if !requirement.matches(&advertised) {
        return Err(DisplayError::new(format!(
            "unsupported DatabasesEverywhere API version {advertised}; this extension supports API 0.10.x, 0.11.x, and 0.12.x"
        ))
        .into());
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
            return Err(DisplayError::new(format!(
                "DatabasesEverywhere API {SUPPORTED_API_VERSION} response is missing required field {field}"
            ))
            .into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_compatible_api_with_allocation_guards() {
        for api_version in ["0.10.0", "0.11.0", "0.12.0"] {
            assert!(
                validate_system_response(&serde_json::json!({
                    "api_version": api_version,
                    "prevent_cpu_overallocation": true,
                    "prevent_memory_overallocation": true,
                    "prevent_disk_overallocation": true
                }))
                .is_ok()
            );
        }
    }

    #[test]
    fn rejects_older_or_incomplete_system_contracts() {
        assert!(
            validate_system_response(&serde_json::json!({
                "api_version": "0.9.0",
                "prevent_cpu_overallocation": true,
                "prevent_memory_overallocation": true,
                "prevent_disk_overallocation": true
            }))
            .is_err()
        );
        assert!(
            validate_system_response(&serde_json::json!({
                "api_version": "0.10.0",
                "prevent_cpu_overallocation": true
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
