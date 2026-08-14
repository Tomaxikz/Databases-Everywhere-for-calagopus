use super::contracts::{LegacyStagedUpload, has_allowed_extension};
use crate::persistence::{DatabaseRecord, NodeRecord};
use shared::{State, response::DisplayError};
use std::path::{Path, PathBuf};

const DEFAULT_CONFIG_PATH: &str = "/etc/databases-everywhere/config.yml";
const CONFIG_PATH_ENV: &str = "CALAGOPUS_DBEV_CONFIG_PATH";
const DEFAULT_ARTIFACTS_PATH: &str = "/var/lib/dbev/artifacts";
const MAX_LISTED_UPLOADS: usize = 500;

pub enum LocalStaging {
    Available(PathBuf),
    Unavailable(String),
}

pub async fn list(
    state: &State,
    database: &DatabaseRecord,
) -> Result<(Vec<LegacyStagedUpload>, Option<String>), anyhow::Error> {
    let root = match local_staging(state, database).await? {
        LocalStaging::Available(root) => root,
        LocalStaging::Unavailable(reason) => return Ok((Vec::new(), Some(reason))),
    };
    let mut entries = match tokio::fs::read_dir(root).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((Vec::new(), None));
        }
        Err(error) => return Err(error.into()),
    };
    let mut uploads = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        let id = match entry.file_name().to_str() {
            Some(id) if super::validate_id("upload", id).is_ok() && has_allowed_extension(id) => {
                id.to_owned()
            }
            _ => continue,
        };
        let file_type = entry.file_type().await?;
        if file_type.is_symlink() || !file_type.is_file() {
            continue;
        }
        let metadata = entry.metadata().await?;
        uploads.push(LegacyStagedUpload {
            original_name: original_name(&id),
            id,
            size_bytes: metadata.len(),
            modified_at: metadata.modified()?.into(),
        });
    }
    uploads.sort_by(|left, right| right.modified_at.cmp(&left.modified_at));
    uploads.truncate(MAX_LISTED_UPLOADS);
    Ok((uploads, None))
}

pub async fn delete(
    state: &State,
    database: &DatabaseRecord,
    upload: &str,
) -> Result<bool, anyhow::Error> {
    super::validate_id("upload", upload)?;
    if !has_allowed_extension(upload) {
        return Err(DisplayError::new("invalid staged dump filename").into());
    }
    let root = match local_staging(state, database).await? {
        LocalStaging::Available(root) => root,
        LocalStaging::Unavailable(reason) => return Err(DisplayError::new(reason).into()),
    };
    let path = root.join(upload);
    let metadata = match tokio::fs::symlink_metadata(&path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(DisplayError::new("staged dump is not a regular file").into());
    }
    tokio::fs::remove_file(path).await?;
    Ok(true)
}

async fn local_staging(
    state: &State,
    database: &DatabaseRecord,
) -> Result<LocalStaging, anyhow::Error> {
    let node = NodeRecord::by_uuid(state, database.dbev_node_uuid)
        .await?
        .ok_or_else(|| anyhow::anyhow!("DatabasesEverywhere node no longer exists"))?;
    let config_path = std::env::var_os(CONFIG_PATH_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_CONFIG_PATH));
    let yaml = match tokio::fs::read_to_string(&config_path).await {
        Ok(yaml) => yaml,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(LocalStaging::Unavailable(
                "This older DBEV node has no shared local import directory available to Panel."
                    .to_owned(),
            ));
        }
        Err(_) => {
            return Ok(LocalStaging::Unavailable(
                "Panel cannot read this older DBEV node's local import directory configuration."
                    .to_owned(),
            ));
        }
    };
    let configuration: serde_json::Value = serde_norway::from_str(&yaml)
        .map_err(|_| DisplayError::new("the local DBEV configuration is invalid"))?;
    let local_uuid = configuration
        .get("uuid")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    if local_uuid != node.daemon_uuid {
        return Ok(LocalStaging::Unavailable(
            "This database is assigned to a remote DBEV host; use an operator-staged file, export artifact, or remote import."
                .to_owned(),
        ));
    }

    let artifacts = pointer(&configuration, "/paths/artifacts").unwrap_or(DEFAULT_ARTIFACTS_PATH);
    let imports = pointer(&configuration, "/paths/imports")
        .map(str::to_owned)
        .unwrap_or_else(|| format!("{}/imports", artifacts.trim_end_matches('/')));
    let imports = PathBuf::from(imports);
    if !imports.is_absolute() || imports.parent().is_none() || imports == Path::new("/") {
        return Err(DisplayError::new("the local DBEV imports path is unsafe").into());
    }
    let root = imports.join(database.instance_id());
    match tokio::fs::symlink_metadata(&root).await {
        Ok(metadata) if !metadata.file_type().is_symlink() && metadata.is_dir() => {}
        Ok(_) => return Err(DisplayError::new("the local DBEV imports path is unsafe").into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(LocalStaging::Available(root));
        }
        Err(error) => return Err(error.into()),
    }
    Ok(LocalStaging::Available(root))
}

fn pointer<'a>(value: &'a serde_json::Value, path: &str) -> Option<&'a str> {
    value
        .pointer(path)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn original_name(id: &str) -> String {
    id.get(38..)
        .filter(|_| {
            id.get(36..38) == Some("--")
                && id
                    .get(..36)
                    .is_some_and(|prefix| uuid::Uuid::parse_str(prefix).is_ok())
        })
        .unwrap_or(id)
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restores_legacy_staged_display_names() {
        assert_eq!(
            original_name("123e4567-e89b-12d3-a456-426614174000--backup.sql"),
            "backup.sql"
        );
        assert_eq!(original_name("operator.sql"), "operator.sql");
    }
}
