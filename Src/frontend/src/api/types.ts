import type { components as DbevComponents } from './dbev.generated.ts';

export const DBEV_API_VERSION = '0.12.0' as const;
export const DBEV_MINIMUM_API_VERSION = '0.10.0' as const;

export type DatabaseProtocol = DbevComponents['schemas']['Protocol'];
export type DbevSystemResponse = DbevComponents['schemas']['SystemResponse'];
export type DbevNodeResourceSummary = DbevComponents['schemas']['NodeResourceSummary'];
export type DbevConfigPatchResponse = DbevComponents['schemas']['ConfigPatchResponse'];
export type DbevInstanceStatusResponse = DbevComponents['schemas']['InstanceStatusResponse'];
export type DbevResetPasswordRequest = DbevComponents['schemas']['ResetInstancePasswordRequest'];
export type DbevResetPasswordResponse = DbevComponents['schemas']['ResetInstancePasswordResponse'];

type GeneratedDbevResourceReport = DbevComponents['schemas']['ResourceReport'];
type GeneratedDbevDiskResourceReport = GeneratedDbevResourceReport['disk'];

export type DbevDiskEnforcementStrength = 'hard' | 'soft' | 'none';

/** Keeps `enforcement_strength` optional for older API 0.10.0 nodes. */
export type DbevDiskResourceReport = Omit<GeneratedDbevDiskResourceReport, 'enforcement_strength'> & {
  enforcement_strength?: DbevDiskEnforcementStrength;
  [key: string]: unknown;
};

export type DbevResourceReport = Omit<GeneratedDbevResourceReport, 'disk'> & {
  disk: DbevDiskResourceReport;
  [key: string]: unknown;
};

export type DatabasePowerAction = 'start' | 'stop' | 'restart' | 'kill';

export type DatabaseWebSocketChannel = 'monitor' | 'logs' | 'import-export';

export interface DatabaseWebSocketToken {
  token_type: string;
  token: string;
  expires_at_unix: number;
  url: string;
  instance_id: string;
  scopes: string[];
}

export interface DatabaseMonitoringInstance {
  instance_id: string;
  protocol?: string;
  status?: string;
  runtime?: string;
  cpu_cores?: number;
  cpu_limit_cores?: number | null;
  cpu_usage_percent?: number | null;
  memory_mib?: number;
  memory_usage_bytes?: number | null;
  memory_limit_bytes?: number | null;
  disk_mib?: number;
  disk_limit_bytes?: number | null;
  disk_used_bytes?: number | null;
  disk_enforced?: boolean;
  network_rx_bytes?: number | null;
  network_tx_bytes?: number | null;
  resources?: DbevResourceReport | null;
  resource_error?: string | null;
}

export interface DatabaseInstallProgress {
  instance_id: string;
  action?: string;
  status?: string;
  stage?: string;
  message?: string;
  image?: string;
  layer?: string;
  current?: number;
  total?: number;
  percent?: number;
  diagnostic?: {
    code?: string;
    message?: string;
    error_id?: string;
  } | null;
  updated_at?: string;
}

export interface DatabaseRuntimeInfo {
  instance_id: string;
  protocol?: string;
  status?: string;
  image?: {
    current?: string | null;
    configured?: string;
    update_available?: boolean;
  } | null;
  database_version?: {
    current?: string | null;
    error?: unknown;
  } | null;
  updated_at?: string;
}

export interface ResourceLimits {
  cpu_cores: number;
  memory_mib: number;
  disk_mib: number;
}

export interface DatabaseRecord {
  uuid: string;
  node_uuid: string;
  protocol: DatabaseProtocol;
  protocol_label: string;
  display_name: string;
  database_name: string;
  username: string;
  password: string | null;
  public_host: string;
  public_port: number;
  tls: boolean;
  connection_uri: string | null;
  status: string;
  image: string | null;
  default_image: string | null;
  allowed_images: string[];
  stream_exports_only: boolean;
  max_artifacts_per_instance: number;
  limits: ResourceLimits;
  limits_sync_pending: boolean;
  last_error: string | null;
  metadata: Record<string, unknown>;
  created: string;
  updated: string;
}

export interface ResetDatabasePasswordResponse {
  restarted: boolean;
}

export interface DatabaseList {
  provider_available: boolean;
  provisioning_enabled: boolean;
  protocols: DatabaseProtocol[];
  database_limit: number;
  database_usage: number;
  database_cpu_cores: number | null;
  database_memory_mib: number | null;
  database_disk_mib: number | null;
  database_backup_limit: number;
  image_options: Partial<Record<DatabaseProtocol, string[]>>;
  databases: DatabaseRecord[];
}

export interface DatabaseBackupRecord {
  id: string;
  instance_id?: string;
  size_bytes?: number;
  modified_at?: string;
  sha256?: string;
  [key: string]: unknown;
}

export interface DatabaseBackupList {
  backups: DatabaseBackupRecord[];
  backup_usage: number;
  backup_limit: number;
}

export interface CreateDatabaseInput {
  protocol: DatabaseProtocol;
  display_name: string;
  database_name?: string;
  username?: string;
  image?: string;
}

export interface DataObject {
  name: string;
  namespace: string | null;
  kind: string;
  metadata: Record<string, unknown>;
}

export interface DataColumn {
  name: string;
  data_type: string;
  nullable: boolean;
  primary_key: boolean;
  default_value: string | null;
  extra: string | null;
}

export interface ExplorerOverview {
  protocol: DatabaseProtocol;
  objects: DataObject[];
  selective_export_supported: boolean;
}

export interface QueryOutput {
  columns: string[];
  rows: unknown[];
  affected_rows: number | null;
  elapsed_ms: number;
  truncated: boolean;
}

export interface DataMutationInput {
  operation: 'insert' | 'update' | 'delete';
  namespace?: string | null;
  object: string;
  original?: unknown;
  value?: unknown;
}

export interface BatchDataMutationInput {
  operation: 'delete';
  namespace?: string | null;
  object: string;
  originals: unknown[];
}

export type SchemaMutationOperation =
  | 'create_object'
  | 'rename_object'
  | 'delete_object'
  | 'add_column'
  | 'rename_column'
  | 'delete_column';

export type SchemaColumnType =
  | 'integer'
  | 'bigint'
  | 'decimal'
  | 'boolean'
  | 'varchar'
  | 'text'
  | 'json'
  | 'uuid'
  | 'date'
  | 'timestamp';

export interface SchemaColumnInput {
  name: string;
  data_type: SchemaColumnType;
  nullable: boolean;
  primary_key: boolean;
  auto_increment: boolean;
}

export interface SchemaMutationInput {
  operation: SchemaMutationOperation;
  namespace?: string | null;
  object: string;
  column?: SchemaColumnInput;
  columns?: SchemaColumnInput[];
  new_name?: string;
  confirm?: boolean;
}

export interface TransferSelection {
  mode: 'full' | 'selective';
  include?: string[];
  exclude?: string[];
  fields?: Record<string, string[]>;
}

export interface RemoteImportSource {
  type: 'remote';
  host: string;
  port: number;
  tls: boolean;
  database?: string;
  username?: string;
  password?: string;
  authentication_database?: string;
  database_index?: number;
  api_key?: string;
}

export interface ImportExportSchedulerConfiguration {
  dynamic_limiter_enabled: boolean;
  max_queued_jobs: number;
  max_queued_jobs_per_instance: number;
  manual_max_active_jobs: number;
  dynamic_max_active_jobs: number;
  dynamic_memory_budget_mib: number;
  dynamic_io_budget_mib: number;
  dynamic_cpu_units: number;
  starvation_timeout_seconds: number;
  max_bypass: number;
}

export interface SchedulerRecommendationRequest {
  protocol: DatabaseProtocol;
  action: 'import' | 'export';
  size_bytes: number;
  target_disk_mib: number;
  mode: 'merge' | 'wipe';
  compressed: boolean;
}

export interface SchedulerRecommendation {
  scheduler: {
    capacity: {
      mode: string;
      max_active_jobs: number;
      memory_budget_mib: number;
      io_budget_mib: number;
      cpu_units: number;
      [key: string]: unknown;
    };
    active_jobs: number;
    waiting_jobs: number;
    active_memory_mib: number;
    active_io_mib: number;
    active_cpu_units: number;
    accepting: boolean;
    [key: string]: unknown;
  };
  estimate: {
    input_size_bytes: number;
    memory_mib: number;
    io_mib: number;
    cpu_units: number;
    [key: string]: unknown;
  };
  recommended_active_jobs: number;
  admitted_jobs: number;
  max_queued_jobs: number;
  max_queued_jobs_per_instance: number;
  [key: string]: unknown;
}

export interface NodeRecord {
  uuid: string;
  name: string;
  enabled: boolean;
  api_url: string;
  public_host: string;
  daemon_uuid: string;
  token_id: string;
  default_cpu_cores: number;
  default_memory_mib: number;
  default_disk_mib: number;
  configuration: Record<string, unknown>;
  has_configuration_secrets: boolean;
  cached_system: DbevSystemResponse | null;
  cached_resources: DbevNodeResourceSummary | null;
  last_seen: string | null;
  last_error: string | null;
  created: string;
  updated: string;
}

export interface RegistryImage {
  tag: string;
  reference: string;
  digest_reference: string | null;
  last_updated: string | null;
  size_bytes: number | null;
}

export interface ImageRegistryResponse {
  protocol: DatabaseProtocol;
  repository: string;
  page: number;
  per_page: number;
  total: number;
  has_next: boolean;
  has_previous: boolean;
  images: RegistryImage[];
}

export interface NodeCredentials {
  daemon_uuid: string;
  token_id: string;
  token: string;
  jwt_signing_key: string;
  configuration_yaml: string;
}

export interface NodeInput {
  name: string;
  enabled?: boolean;
  api_url: string;
  public_host: string;
  default_cpu_cores: number;
  default_memory_mib: number;
  default_disk_mib: number;
  configuration?: Record<string, unknown>;
  configuration_secrets?: {
    s3_access_key_id?: string;
    s3_secret_access_key?: string;
    s3_session_token?: string;
    kopia_repository_password?: string;
    clear_s3_credentials?: boolean;
    clear_kopia_repository_password?: boolean;
  };
}

export interface HostAssignment {
  host: NodeRecord;
  created: string;
}

export interface PanelNodeHostAvailability {
  available: boolean;
  schedulable: boolean;
  direct_host_count: number;
  location_host_count: number;
}

export interface ExtensionSettings {
  enabled: boolean;
  panel_url: string;
  raw_console_enabled: boolean;
  query_timeout_seconds: number;
  max_console_rows: number;
  node_health_interval_seconds: number;
}

export interface ArtifactRecord {
  id: string;
  instance_id?: string;
  size_bytes?: number | null;
  modified_at?: string | null;
  sha256?: string | null;
  [key: string]: unknown;
}

export interface StagedUploadRecord {
  id: string;
  original_name: string;
  size_bytes: number;
  modified_at: string;
}

export type TemporaryUploadState =
  | 'uploading'
  | 'uploaded'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'importing'
  | 'consumed'
  | 'deleting';

export interface TemporaryUploadRecord {
  upload_id: string;
  instance_id: string;
  original_filename: string;
  protocol: DatabaseProtocol;
  archive_format: 'plain' | 'gzip' | 'bzip2' | 'tar' | 'tar.gz' | 'zip' | null;
  state: TemporaryUploadState;
  size_bytes: number;
  sha256: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
  catalog?: DumpInspection;
  error?: unknown;
  [key: string]: unknown;
}

export interface DumpInspectionObject {
  kind: 'table' | 'collection';
  name: string;
  namespace?: string;
  selection_key: string;
  [key: string]: unknown;
}

export interface DumpInspection {
  protocol: DatabaseProtocol;
  sha256: string;
  source_size_bytes: number;
  detected_archive_format: 'plain' | 'gzip' | 'bzip2' | 'tar' | 'tar.gz' | 'zip';
  selection_kind: 'tables' | 'collections' | 'full_only';
  selective_supported: boolean;
  catalog_complete: boolean;
  namespaces: string[];
  objects: DumpInspectionObject[];
  unselectable_object_count: number;
  selective_unavailable_reason?: string;
  [key: string]: unknown;
}

export interface StagedUploadList {
  available: boolean;
  contract_mismatch?: boolean;
  reason: string | null;
  api_version: string | null;
  max_upload_bytes: number;
  uploads: TemporaryUploadRecord[];
  staged_uploads: StagedUploadRecord[];
}

export interface TransferJob {
  job_id: string;
  instance_id?: string;
  action?: string;
  status?: string;
  artifact_id?: string | null;
  error?: unknown;
  created_at?: string;
  updated_at?: string;
  artifact_size_bytes?: number | null;
  [key: string]: unknown;
}

export interface AcceptedTransfer {
  job: Record<string, unknown>;
  location: string | null;
}
