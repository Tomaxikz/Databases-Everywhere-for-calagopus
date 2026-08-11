use super::{document, http_databases, relational};
use crate::{domain::DatabaseProtocol, persistence::DatabaseRecord};
use serde::{Deserialize, Serialize};
use shared::{State, response::DisplayError};
use std::collections::HashSet;
use utoipa::ToSchema;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SchemaMutationOperation {
    CreateObject,
    RenameObject,
    DeleteObject,
    AddColumn,
    RenameColumn,
    DeleteColumn,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SchemaColumnType {
    Integer,
    Bigint,
    Decimal,
    Boolean,
    Varchar,
    Text,
    Json,
    Uuid,
    Date,
    Timestamp,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct SchemaColumnInput {
    pub name: String,
    pub data_type: SchemaColumnType,
    #[serde(default)]
    pub nullable: bool,
    #[serde(default)]
    pub primary_key: bool,
    #[serde(default)]
    pub auto_increment: bool,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct SchemaMutationInput {
    pub operation: SchemaMutationOperation,
    pub namespace: Option<String>,
    pub object: String,
    /// Legacy single-column shape retained for older Panel clients.
    pub column: Option<SchemaColumnInput>,
    /// One or more columns for table creation and add-column operations.
    #[serde(default)]
    pub columns: Vec<SchemaColumnInput>,
    pub new_name: Option<String>,
    #[serde(default)]
    pub confirm: bool,
}

pub async fn mutate(
    state: &State,
    database: &DatabaseRecord,
    input: &SchemaMutationInput,
) -> Result<(), anyhow::Error> {
    match database.protocol {
        DatabaseProtocol::Postgres | DatabaseProtocol::Mysql | DatabaseProtocol::Mariadb => {
            mutate_relational(state, database, input).await
        }
        DatabaseProtocol::Clickhouse => mutate_clickhouse(state, database, input).await,
        DatabaseProtocol::Mongodb => mutate_mongodb(state, database, input).await,
        DatabaseProtocol::Redis | DatabaseProtocol::Valkey | DatabaseProtocol::Qdrant => Err(
            DisplayError::new("schema operations are not applicable to this database type").into(),
        ),
    }
}

async fn mutate_relational(
    state: &State,
    database: &DatabaseRecord,
    input: &SchemaMutationInput,
) -> Result<(), anyhow::Error> {
    relational::validate_identifier_input(&input.object)?;
    let postgres = database.protocol == DatabaseProtocol::Postgres;
    let (postgres_pool, table) = if postgres {
        let pool = relational::postgres_pool(state, database).await?;
        let namespace =
            relational::resolve_postgres_namespace(&pool, database, input.namespace.as_deref())
                .await?;
        (
            Some(pool),
            format!(
                "{}.{}",
                relational::quote_postgres(&namespace),
                relational::quote_postgres(&input.object)
            ),
        )
    } else {
        (None, relational::quote_mysql(&input.object))
    };

    let sql = match input.operation {
        SchemaMutationOperation::CreateObject => {
            let definitions = required_columns(input)?
                .into_iter()
                .map(|column| column_definition(database.protocol, column))
                .collect::<Result<Vec<_>, _>>()?;
            let suffix = if postgres {
                ""
            } else {
                " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
            };
            format!("CREATE TABLE {table} ({}){suffix}", definitions.join(", "))
        }
        SchemaMutationOperation::RenameObject => {
            let name = required_new_name(input)?;
            relational::validate_identifier_input(name)?;
            let quoted = if postgres {
                relational::quote_postgres(name)
            } else {
                relational::quote_mysql(name)
            };
            format!("ALTER TABLE {table} RENAME TO {quoted}")
        }
        SchemaMutationOperation::DeleteObject => {
            require_confirmation(input)?;
            format!("DROP TABLE {table}")
        }
        SchemaMutationOperation::AddColumn => {
            let definitions = required_columns(input)?
                .into_iter()
                .map(|column| {
                    column_definition(database.protocol, column)
                        .map(|definition| format!("ADD COLUMN {definition}"))
                })
                .collect::<Result<Vec<_>, _>>()?;
            format!("ALTER TABLE {table} {}", definitions.join(", "))
        }
        SchemaMutationOperation::RenameColumn => {
            let column = required_column(input)?;
            relational::validate_identifier_input(&column.name)?;
            let name = required_new_name(input)?;
            relational::validate_identifier_input(name)?;
            let (old, new) = if postgres {
                (
                    relational::quote_postgres(&column.name),
                    relational::quote_postgres(name),
                )
            } else {
                (
                    relational::quote_mysql(&column.name),
                    relational::quote_mysql(name),
                )
            };
            format!("ALTER TABLE {table} RENAME COLUMN {old} TO {new}")
        }
        SchemaMutationOperation::DeleteColumn => {
            require_confirmation(input)?;
            let column = required_column(input)?;
            relational::validate_identifier_input(&column.name)?;
            let quoted = if postgres {
                relational::quote_postgres(&column.name)
            } else {
                relational::quote_mysql(&column.name)
            };
            format!("ALTER TABLE {table} DROP COLUMN {quoted}")
        }
    };

    if let Some(pool) = postgres_pool {
        sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
            .execute(&pool)
            .await?;
    } else {
        let pool = relational::mysql_pool(state, database).await?;
        sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
            .execute(&pool)
            .await?;
    }
    Ok(())
}

async fn mutate_clickhouse(
    state: &State,
    database: &DatabaseRecord,
    input: &SchemaMutationInput,
) -> Result<(), anyhow::Error> {
    http_databases::validate_name(&input.object)?;
    let namespace = input
        .namespace
        .as_deref()
        .unwrap_or(&database.database_name);
    http_databases::validate_name(namespace)?;
    let table = format!(
        "{}.{}",
        http_databases::quote_clickhouse(namespace),
        http_databases::quote_clickhouse(&input.object)
    );
    let sql = match input.operation {
        SchemaMutationOperation::CreateObject => {
            let columns = required_columns(input)?;
            let definitions = columns
                .iter()
                .map(|column| clickhouse_column_definition(column))
                .collect::<Result<Vec<_>, _>>()?;
            let order = columns
                .iter()
                .find(|column| column.primary_key)
                .map(|column| http_databases::quote_clickhouse(&column.name))
                .unwrap_or_else(|| "tuple()".to_owned());
            format!(
                "CREATE TABLE {table} ({}) ENGINE = MergeTree ORDER BY {order}",
                definitions.join(", ")
            )
        }
        SchemaMutationOperation::RenameObject => {
            let name = required_new_name(input)?;
            http_databases::validate_name(name)?;
            format!(
                "RENAME TABLE {table} TO {}.{}",
                http_databases::quote_clickhouse(namespace),
                http_databases::quote_clickhouse(name)
            )
        }
        SchemaMutationOperation::DeleteObject => {
            require_confirmation(input)?;
            format!("DROP TABLE {table}")
        }
        SchemaMutationOperation::AddColumn => {
            let definitions = required_columns(input)?
                .into_iter()
                .map(|column| {
                    clickhouse_column_definition(column)
                        .map(|definition| format!("ADD COLUMN {definition}"))
                })
                .collect::<Result<Vec<_>, _>>()?;
            format!("ALTER TABLE {table} {}", definitions.join(", "))
        }
        SchemaMutationOperation::RenameColumn => {
            let column = required_column(input)?;
            http_databases::validate_name(&column.name)?;
            let name = required_new_name(input)?;
            http_databases::validate_name(name)?;
            format!(
                "ALTER TABLE {table} RENAME COLUMN {} TO {}",
                http_databases::quote_clickhouse(&column.name),
                http_databases::quote_clickhouse(name)
            )
        }
        SchemaMutationOperation::DeleteColumn => {
            require_confirmation(input)?;
            let column = required_column(input)?;
            http_databases::validate_name(&column.name)?;
            format!(
                "ALTER TABLE {table} DROP COLUMN {}",
                http_databases::quote_clickhouse(&column.name)
            )
        }
    };
    http_databases::clickhouse_query(state, database, &sql).await?;
    Ok(())
}

async fn mutate_mongodb(
    state: &State,
    database: &DatabaseRecord,
    input: &SchemaMutationInput,
) -> Result<(), anyhow::Error> {
    document::validate_collection(&input.object)?;
    let client = document::client(state, database).await?;
    let mongo_database = client.database(&database.database_name);
    match input.operation {
        SchemaMutationOperation::CreateObject => {
            mongo_database.create_collection(&input.object).await?;
        }
        SchemaMutationOperation::RenameObject => {
            return Err(DisplayError::new(
                "MongoDB collection renaming is not exposed by this visual editor; create a new collection and migrate documents instead",
            )
            .into());
        }
        SchemaMutationOperation::DeleteObject => {
            require_confirmation(input)?;
            mongo_database
                .collection::<mongodb::bson::Document>(&input.object)
                .drop()
                .await?;
        }
        SchemaMutationOperation::AddColumn
        | SchemaMutationOperation::RenameColumn
        | SchemaMutationOperation::DeleteColumn => {
            return Err(DisplayError::new("MongoDB collections do not have fixed columns").into());
        }
    }
    Ok(())
}

fn required_column(input: &SchemaMutationInput) -> Result<&SchemaColumnInput, anyhow::Error> {
    input
        .column
        .as_ref()
        .or_else(|| input.columns.first())
        .ok_or_else(|| DisplayError::new("a column definition is required").into())
}

fn required_columns(input: &SchemaMutationInput) -> Result<Vec<&SchemaColumnInput>, anyhow::Error> {
    let columns = if input.columns.is_empty() {
        input.column.iter().collect::<Vec<_>>()
    } else {
        input.columns.iter().collect::<Vec<_>>()
    };
    if columns.is_empty() || columns.len() > 64 {
        return Err(DisplayError::new("between 1 and 64 column definitions are required").into());
    }

    let mut names = HashSet::with_capacity(columns.len());
    for column in &columns {
        let normalized = column.name.trim().to_lowercase();
        if !names.insert(normalized) {
            return Err(DisplayError::new("column names must be unique").into());
        }
    }
    if columns.iter().filter(|column| column.primary_key).count() > 1 {
        return Err(DisplayError::new(
            "the visual editor currently supports one primary-key column per operation",
        )
        .into());
    }
    if columns
        .iter()
        .filter(|column| column.auto_increment)
        .count()
        > 1
    {
        return Err(DisplayError::new(
            "only one auto-increment column can be added in an operation",
        )
        .into());
    }
    Ok(columns)
}

fn required_new_name(input: &SchemaMutationInput) -> Result<&str, anyhow::Error> {
    input
        .new_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .ok_or_else(|| DisplayError::new("a new name is required").into())
}

fn require_confirmation(input: &SchemaMutationInput) -> Result<(), anyhow::Error> {
    if !input.confirm {
        return Err(
            DisplayError::new("explicit confirmation is required for this schema change").into(),
        );
    }
    Ok(())
}

fn column_definition(
    protocol: DatabaseProtocol,
    column: &SchemaColumnInput,
) -> Result<String, anyhow::Error> {
    relational::validate_identifier_input(&column.name)?;
    let postgres = protocol == DatabaseProtocol::Postgres;
    let quoted = if postgres {
        relational::quote_postgres(&column.name)
    } else {
        relational::quote_mysql(&column.name)
    };
    let data_type = if postgres {
        match (column.data_type, column.auto_increment) {
            (SchemaColumnType::Integer, true) => "SERIAL",
            (SchemaColumnType::Bigint, true) => "BIGSERIAL",
            (SchemaColumnType::Integer, false) => "INTEGER",
            (SchemaColumnType::Bigint, false) => "BIGINT",
            (SchemaColumnType::Decimal, _) => "NUMERIC(18,2)",
            (SchemaColumnType::Boolean, _) => "BOOLEAN",
            (SchemaColumnType::Varchar, _) => "VARCHAR(255)",
            (SchemaColumnType::Text, _) => "TEXT",
            (SchemaColumnType::Json, _) => "JSONB",
            (SchemaColumnType::Uuid, _) => "UUID",
            (SchemaColumnType::Date, _) => "DATE",
            (SchemaColumnType::Timestamp, _) => "TIMESTAMPTZ",
        }
    } else {
        match column.data_type {
            SchemaColumnType::Integer => "INT",
            SchemaColumnType::Bigint => "BIGINT",
            SchemaColumnType::Decimal => "DECIMAL(18,2)",
            SchemaColumnType::Boolean => "BOOLEAN",
            SchemaColumnType::Varchar => "VARCHAR(255)",
            SchemaColumnType::Text => "TEXT",
            SchemaColumnType::Json => "JSON",
            SchemaColumnType::Uuid => "CHAR(36)",
            SchemaColumnType::Date => "DATE",
            SchemaColumnType::Timestamp => "DATETIME",
        }
    };
    let mut definition = format!("{quoted} {data_type}");
    if !postgres && column.auto_increment {
        if !matches!(
            column.data_type,
            SchemaColumnType::Integer | SchemaColumnType::Bigint
        ) {
            return Err(DisplayError::new("auto increment requires an integer column").into());
        }
        definition.push_str(" AUTO_INCREMENT");
    }
    if !column.nullable {
        definition.push_str(" NOT NULL");
    }
    if column.primary_key {
        definition.push_str(" PRIMARY KEY");
    }
    Ok(definition)
}

fn clickhouse_column_definition(column: &SchemaColumnInput) -> Result<String, anyhow::Error> {
    http_databases::validate_name(&column.name)?;
    if column.auto_increment {
        return Err(DisplayError::new("ClickHouse does not support auto-increment columns").into());
    }
    let data_type = match column.data_type {
        SchemaColumnType::Integer => "Int32",
        SchemaColumnType::Bigint => "Int64",
        SchemaColumnType::Decimal => "Decimal(18, 2)",
        SchemaColumnType::Boolean => "Bool",
        SchemaColumnType::Varchar | SchemaColumnType::Text | SchemaColumnType::Uuid => "String",
        SchemaColumnType::Json => "JSON",
        SchemaColumnType::Date => "Date",
        SchemaColumnType::Timestamp => "DateTime",
    };
    Ok(format!(
        "{} {}{}",
        http_databases::quote_clickhouse(&column.name),
        if column.nullable { "Nullable(" } else { "" },
        if column.nullable {
            format!("{data_type})")
        } else {
            data_type.to_owned()
        }
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn column(data_type: SchemaColumnType) -> SchemaColumnInput {
        SchemaColumnInput {
            name: "id".to_owned(),
            data_type,
            nullable: false,
            primary_key: true,
            auto_increment: true,
        }
    }

    #[test]
    fn generates_protocol_specific_primary_keys() {
        assert_eq!(
            column_definition(
                DatabaseProtocol::Postgres,
                &column(SchemaColumnType::Bigint)
            )
            .unwrap(),
            "\"id\" BIGSERIAL NOT NULL PRIMARY KEY"
        );
        assert_eq!(
            column_definition(DatabaseProtocol::Mysql, &column(SchemaColumnType::Bigint)).unwrap(),
            "`id` BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY"
        );
    }

    #[test]
    fn rejects_auto_increment_on_non_integer_columns() {
        assert!(
            column_definition(DatabaseProtocol::Mysql, &column(SchemaColumnType::Text)).is_err()
        );
        assert!(clickhouse_column_definition(&column(SchemaColumnType::Bigint)).is_err());
    }

    #[test]
    fn accepts_multiple_unique_columns_and_legacy_single_column() {
        let mut second = column(SchemaColumnType::Text);
        second.name = "name".to_owned();
        second.primary_key = false;
        second.auto_increment = false;
        let input = SchemaMutationInput {
            operation: SchemaMutationOperation::CreateObject,
            namespace: None,
            object: "users".to_owned(),
            column: None,
            columns: vec![column(SchemaColumnType::Bigint), second],
            new_name: None,
            confirm: false,
        };
        assert_eq!(required_columns(&input).unwrap().len(), 2);

        let legacy = SchemaMutationInput {
            columns: Vec::new(),
            column: Some(column(SchemaColumnType::Bigint)),
            ..input
        };
        assert_eq!(required_columns(&legacy).unwrap().len(), 1);
    }

    #[test]
    fn rejects_duplicate_columns() {
        let input = SchemaMutationInput {
            operation: SchemaMutationOperation::AddColumn,
            namespace: None,
            object: "users".to_owned(),
            column: None,
            columns: vec![
                column(SchemaColumnType::Bigint),
                column(SchemaColumnType::Bigint),
            ],
            new_name: None,
            confirm: false,
        };
        assert!(required_columns(&input).is_err());
    }
}
