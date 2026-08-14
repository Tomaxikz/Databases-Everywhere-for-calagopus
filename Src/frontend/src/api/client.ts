import { axiosInstance } from '@/api/axios.ts';
import {
  acceptedTransfer,
  DBEV_LONG_MUTATION_TIMEOUT_MS,
  exportRequestPayload,
  imageUpdatePayload,
  parseSchedulerRecommendation,
  schedulerRecommendationParams,
  uploadImportPayload,
} from './mutationContracts.ts';
import { normalizeDatabaseBackups, normalizeDbevResourceReport, normalizeQueryOutput } from './normalizers.ts';
import type {
  AcceptedTransfer,
  BatchDataMutationInput,
  CreateDatabaseInput,
  DatabaseBackupList,
  DatabaseList,
  DatabasePowerAction,
  DatabaseProtocol,
  DatabaseRecord,
  DatabaseRuntimeInfo,
  DatabaseWebSocketChannel,
  DatabaseWebSocketToken,
  DataColumn,
  DataMutationInput,
  DbevConfigPatchResponse,
  DbevInstanceStatusResponse,
  DbevResourceReport,
  DumpInspection,
  ExplorerOverview,
  ExtensionSettings,
  HostAssignment,
  ImageRegistryResponse,
  NodeCredentials,
  NodeInput,
  NodeRecord,
  PanelNodeHostAvailability,
  QueryOutput,
  RemoteImportSource,
  ResetDatabasePasswordResponse,
  SchedulerRecommendation,
  SchedulerRecommendationRequest,
  SchemaMutationInput,
  StagedUploadList,
  TemporaryUploadRecord,
  TransferSelection,
} from './types.ts';

const serverBase = (server: string) => `/api/client/servers/${server}/databases-everywhere`;
const databaseBase = (server: string, database: string) => `${serverBase(server)}/${database}`;
const adminBase = '/api/admin/databases-everywhere';

export async function getExtensionSettings(): Promise<ExtensionSettings> {
  const { data } = await axiosInstance.get(`${adminBase}/settings`);
  return data.settings;
}

export async function updateExtensionSettings(input: ExtensionSettings): Promise<ExtensionSettings> {
  const { data } = await axiosInstance.put(`${adminBase}/settings`, input);
  return data.settings;
}

export async function listDatabases(server: string): Promise<DatabaseList> {
  const { data } = await axiosInstance.get(serverBase(server));
  return data;
}

export async function createDatabase(server: string, input: CreateDatabaseInput): Promise<DatabaseRecord> {
  const { data } = await axiosInstance.post(serverBase(server), input);
  return data.database;
}

export async function getDatabase(server: string, database: string): Promise<DatabaseRecord> {
  const { data } = await axiosInstance.get(databaseBase(server, database));
  return data.database;
}

export async function deleteDatabase(server: string, database: string, reason: string): Promise<boolean> {
  const { data } = await axiosInstance.delete(databaseBase(server, database), { data: { reason } });
  return data.deferred === true;
}

export async function powerDatabase(
  server: string,
  database: string,
  action: DatabasePowerAction,
): Promise<Record<string, unknown>> {
  const { data } = await axiosInstance.post(`${databaseBase(server, database)}/power`, { action });
  return data.result;
}

export async function updateDatabaseImage(
  server: string,
  database: string,
  image: string,
  majorUpgrade: boolean,
  legacyPassword?: string,
): Promise<Record<string, unknown>> {
  const { data } = await axiosInstance.patch(
    `${databaseBase(server, database)}/image`,
    imageUpdatePayload(image, majorUpgrade, legacyPassword),
    { timeout: DBEV_LONG_MUTATION_TIMEOUT_MS },
  );
  return data.result;
}

export async function reconcileDatabase(server: string, database: string): Promise<Record<string, unknown>> {
  const { data } = await axiosInstance.post(`${databaseBase(server, database)}/reconcile`);
  return data.result;
}

export async function resetDatabasePassword(
  server: string,
  database: string,
  password: string,
): Promise<ResetDatabasePasswordResponse> {
  const { data } = await axiosInstance.patch(
    `${databaseBase(server, database)}/password`,
    { password },
    { timeout: DBEV_LONG_MUTATION_TIMEOUT_MS },
  );
  return data;
}

export async function getDatabaseStatus(server: string, database: string): Promise<DbevInstanceStatusResponse> {
  const { data } = await axiosInstance.get(`${databaseBase(server, database)}/monitoring/status`);
  return data.result;
}

export async function getDatabaseRuntime(server: string, database: string): Promise<DatabaseRuntimeInfo> {
  const { data } = await axiosInstance.get(`${databaseBase(server, database)}/monitoring/instance`);
  return data.result;
}

export async function getDatabaseResources(server: string, database: string): Promise<DbevResourceReport> {
  const { data } = await axiosInstance.get(`${databaseBase(server, database)}/monitoring/resources`);
  const result = normalizeDbevResourceReport(data.result);
  if (!result) throw new Error('DatabasesEverywhere returned an invalid resource report.');
  return result;
}

export async function getDatabaseLogs(server: string, database: string, tail = 300): Promise<unknown> {
  const { data } = await axiosInstance.get(`${databaseBase(server, database)}/monitoring/logs`, { params: { tail } });
  return data.result;
}

export async function mintDatabaseWebSocketToken(
  server: string,
  database: string,
  channel: DatabaseWebSocketChannel,
  instances?: string[],
): Promise<DatabaseWebSocketToken> {
  const { data } = await axiosInstance.post(`${databaseBase(server, database)}/monitoring/ws-token`, {
    channel,
    instances,
  });
  return data;
}

export async function getExplorer(server: string, database: string): Promise<ExplorerOverview> {
  const { data } = await axiosInstance.get(`${databaseBase(server, database)}/data`);
  return data.explorer;
}

export async function browseData(
  server: string,
  database: string,
  object: string,
  namespace?: string | null,
  offset = 0,
  limit = 100,
): Promise<QueryOutput> {
  const { data } = await axiosInstance.get(`${databaseBase(server, database)}/data/browse`, {
    params: { object, namespace: namespace || undefined, offset, limit },
  });
  return normalizeQueryOutput(data.output);
}

export async function describeDataObject(
  server: string,
  database: string,
  object: string,
  namespace?: string | null,
): Promise<DataColumn[]> {
  const { data } = await axiosInstance.get(`${databaseBase(server, database)}/data/describe`, {
    params: { object, namespace: namespace || undefined },
  });
  return data.columns;
}

export async function executeCommand(server: string, database: string, command: string): Promise<QueryOutput> {
  const { data } = await axiosInstance.post(`${databaseBase(server, database)}/data/console`, { command });
  return normalizeQueryOutput(data.output);
}

export async function mutateData(server: string, database: string, input: DataMutationInput): Promise<QueryOutput> {
  const { data } = await axiosInstance.post(`${databaseBase(server, database)}/data/mutate`, input);
  return normalizeQueryOutput(data.output);
}

export async function mutateDataBatch(
  server: string,
  database: string,
  input: BatchDataMutationInput,
): Promise<QueryOutput> {
  const { data } = await axiosInstance.post(`${databaseBase(server, database)}/data/mutate/batch`, input);
  return normalizeQueryOutput(data.output);
}

export async function mutateSchema(server: string, database: string, input: SchemaMutationInput): Promise<void> {
  await axiosInstance.post(`${databaseBase(server, database)}/data/schema`, input);
}

export async function queueExport(
  server: string,
  database: string,
  protocol: DatabaseProtocol,
  archiveFormat?: string,
  selection?: TransferSelection,
): Promise<AcceptedTransfer> {
  const response = await axiosInstance.post(
    `${databaseBase(server, database)}/transfers/export`,
    exportRequestPayload(protocol, archiveFormat, selection),
  );
  return acceptedTransfer(response.data.result, response.headers.location);
}

export async function queueArtifactImport(
  server: string,
  database: string,
  artifactId: string,
  mode: 'merge' | 'wipe',
  archiveFormat?: string,
  selection?: TransferSelection,
): Promise<AcceptedTransfer> {
  const response = await axiosInstance.post(`${databaseBase(server, database)}/transfers/import`, {
    source: { type: 'artifact', artifact_id: artifactId, archive_format: archiveFormat || undefined },
    mode,
    selection,
  });
  return acceptedTransfer(response.data.result, response.headers.location);
}

export async function queueRemoteImport(
  server: string,
  database: string,
  source: RemoteImportSource,
  mode: 'merge' | 'wipe',
  selection?: TransferSelection,
): Promise<AcceptedTransfer> {
  const response = await axiosInstance.post(`${databaseBase(server, database)}/transfers/import`, {
    source,
    mode,
    selection,
  });
  return acceptedTransfer(response.data.result, response.headers.location);
}

export async function getTransferJobs(server: string, database: string, status?: string): Promise<unknown> {
  const { data } = await axiosInstance.get(`${databaseBase(server, database)}/transfers/jobs`, {
    params: { status: status || undefined, limit: 100 },
  });
  return data.result;
}

export async function retryTransferJob(server: string, database: string, job: string): Promise<unknown> {
  const { data } = await axiosInstance.post(
    `${databaseBase(server, database)}/transfers/jobs/${encodeURIComponent(job)}/retry`,
  );
  return data.result;
}

export async function getArtifacts(server: string, database: string): Promise<unknown> {
  const { data } = await axiosInstance.get(`${databaseBase(server, database)}/transfers/artifacts`);
  return data.result;
}

export async function getStagedUploads(
  server: string,
  database: string,
  includeTemporary = true,
): Promise<StagedUploadList> {
  const { data } = await axiosInstance.get(`${databaseBase(server, database)}/transfers/uploads`, {
    params: includeTemporary ? undefined : { temporary: false },
  });
  return data;
}

export async function uploadStagedDump(
  server: string,
  database: string,
  file: File,
  options: {
    sha256?: string;
    signal?: AbortSignal;
    onProgress?: (loaded: number, total: number) => void;
  } = {},
): Promise<TemporaryUploadRecord> {
  const { data } = await axiosInstance.post(`${databaseBase(server, database)}/transfers/uploads`, file, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Calagopus-CSRF': 'dbev-upload-v1',
      'X-Calagopus-Upload-Filename': encodeURIComponent(file.name),
      ...(options.sha256 ? { 'X-Calagopus-Upload-SHA256': options.sha256 } : {}),
    },
    signal: options.signal,
    timeout: 0,
    onUploadProgress: (event) => options.onProgress?.(event.loaded, event.total ?? file.size),
  });
  return data.upload;
}

export async function deleteStagedUpload(
  server: string,
  database: string,
  upload: string,
  source: 'upload' | 'staged' = 'upload',
): Promise<void> {
  await axiosInstance.delete(`${databaseBase(server, database)}/transfers/uploads/${encodeURIComponent(upload)}`, {
    headers: { 'X-Calagopus-CSRF': 'dbev-upload-v1' },
    params: source === 'staged' ? { source: 'legacy' } : undefined,
  });
}

export async function getTemporaryUpload(
  server: string,
  database: string,
  upload: string,
): Promise<TemporaryUploadRecord> {
  const { data } = await axiosInstance.get(
    `${databaseBase(server, database)}/transfers/uploads/${encodeURIComponent(upload)}`,
  );
  return data.upload;
}

export async function inspectTemporaryUpload(
  server: string,
  database: string,
  upload: string,
): Promise<DumpInspection> {
  const { data } = await axiosInstance.post(
    `${databaseBase(server, database)}/transfers/uploads/${encodeURIComponent(upload)}/catalog`,
    {},
    { headers: { 'X-Calagopus-CSRF': 'dbev-upload-v1' } },
  );
  return data.catalog;
}

export async function queueUploadImport(
  server: string,
  database: string,
  uploadId: string,
  mode: 'merge' | 'wipe',
  sourceDatabase?: string,
): Promise<AcceptedTransfer> {
  const response = await axiosInstance.post(
    `${databaseBase(server, database)}/transfers/import`,
    uploadImportPayload(uploadId, mode, sourceDatabase),
    {
      headers: { 'X-Calagopus-CSRF': 'dbev-upload-v1' },
    },
  );
  return acceptedTransfer(response.data.result, response.headers.location);
}

export async function deleteArtifact(server: string, database: string, artifact: string): Promise<void> {
  await axiosInstance.delete(`${databaseBase(server, database)}/transfers/artifacts/${encodeURIComponent(artifact)}`);
}

export async function applyArtifactRetention(
  server: string,
  database: string,
  keepLatest?: number,
  maxAgeDays?: number,
): Promise<unknown> {
  const { data } = await axiosInstance.post(`${databaseBase(server, database)}/transfers/artifacts/retention`, {
    keep_latest: keepLatest,
    max_age_days: maxAgeDays,
  });
  return data.result;
}

export async function getBackups(server: string, database: string): Promise<DatabaseBackupList> {
  const { data } = await axiosInstance.get(`${databaseBase(server, database)}/transfers/backups`);
  const usage = Number(data.backup_usage);
  const limit = Number(data.backup_limit);
  return {
    backups: normalizeDatabaseBackups(data.result),
    backup_usage: Number.isFinite(usage) && usage >= 0 ? usage : 0,
    backup_limit: Number.isFinite(limit) && limit >= 0 ? limit : 0,
  };
}

export async function createBackup(server: string, database: string): Promise<unknown> {
  const { data } = await axiosInstance.post(`${databaseBase(server, database)}/transfers/backups`);
  return data.result;
}

export async function getBackupContents(
  server: string,
  database: string,
  backup: string,
  object?: string,
  offset = 0,
): Promise<unknown> {
  const { data } = await axiosInstance.get(
    `${databaseBase(server, database)}/transfers/backups/${encodeURIComponent(backup)}/contents`,
    { params: { object: object || undefined, offset, limit: 100 } },
  );
  return data.result;
}

export async function restoreBackup(
  server: string,
  database: string,
  backup: string,
  reason: string,
): Promise<unknown> {
  const { data } = await axiosInstance.post(
    `${databaseBase(server, database)}/transfers/backups/${encodeURIComponent(backup)}/restore`,
    { reason },
  );
  return data.result;
}

export async function deleteBackup(server: string, database: string, backup: string): Promise<void> {
  await axiosInstance.delete(`${databaseBase(server, database)}/transfers/backups/${encodeURIComponent(backup)}`);
}

export function downloadUrl(server: string, database: string, kind: 'artifacts' | 'backups', id: string): string {
  return `${databaseBase(server, database)}/transfers/${kind}/${encodeURIComponent(id)}/download`;
}

export async function listNodes(): Promise<NodeRecord[]> {
  const { data } = await axiosInstance.get(adminBase);
  return data.nodes;
}

export async function listRegistryImages(protocol: string, page = 1, perPage = 50): Promise<ImageRegistryResponse> {
  const { data } = await axiosInstance.get(`${adminBase}/image-registry/${encodeURIComponent(protocol)}`, {
    params: { page, per_page: perPage },
  });
  return data;
}

export async function createNode(input: NodeInput): Promise<{ node: NodeRecord; credentials: NodeCredentials }> {
  const { data } = await axiosInstance.post(adminBase, input);
  return data;
}

export async function getNode(node: string): Promise<NodeRecord> {
  const { data } = await axiosInstance.get(`${adminBase}/${node}`);
  return data.node;
}

export async function updateNode(node: string, input: Partial<NodeInput>): Promise<NodeRecord> {
  const { data } = await axiosInstance.patch(`${adminBase}/${node}`, input);
  return data.node;
}

export async function updateNodeImages(
  node: string,
  protocol: string,
  defaultImage: string,
  allowedImages: string[],
): Promise<NodeRecord> {
  const { data } = await axiosInstance.patch(`${adminBase}/${node}/images/${encodeURIComponent(protocol)}`, {
    default_image: defaultImage,
    allowed_images: allowedImages,
  });
  return data.node;
}

export async function deleteNode(node: string): Promise<void> {
  await axiosInstance.delete(`${adminBase}/${node}`);
}

export async function listPanelNodeHostAssignments(panelNode: string): Promise<HostAssignment[]> {
  const { data } = await axiosInstance.get(`${adminBase}/assignments/nodes/${panelNode}`);
  return data.hosts;
}

export async function assignHostToPanelNode(panelNode: string, dbevNode: string): Promise<void> {
  await axiosInstance.post(`${adminBase}/assignments/nodes/${panelNode}`, { dbev_node_uuid: dbevNode });
}

export async function removeHostFromPanelNode(panelNode: string, dbevNode: string): Promise<void> {
  await axiosInstance.delete(`${adminBase}/assignments/nodes/${panelNode}/${dbevNode}`);
}

export async function listLocationHostAssignments(location: string): Promise<HostAssignment[]> {
  const { data } = await axiosInstance.get(`${adminBase}/assignments/locations/${location}`);
  return data.hosts;
}

export async function assignHostToLocation(location: string, dbevNode: string): Promise<void> {
  await axiosInstance.post(`${adminBase}/assignments/locations/${location}`, { dbev_node_uuid: dbevNode });
}

export async function removeHostFromLocation(location: string, dbevNode: string): Promise<void> {
  await axiosInstance.delete(`${adminBase}/assignments/locations/${location}/${dbevNode}`);
}

export async function getPanelNodeHostAvailability(panelNode: string): Promise<PanelNodeHostAvailability> {
  const { data } = await axiosInstance.get(`${adminBase}/assignments/eligibility/nodes/${panelNode}`);
  return data;
}

export async function getNodeConfiguration(node: string): Promise<string> {
  const { data } = await axiosInstance.get(`${adminBase}/${node}/config`);
  return data.configuration_yaml;
}

export async function resetNodeCredentials(node: string): Promise<NodeCredentials> {
  const { data } = await axiosInstance.post(`${adminBase}/${node}/reset-credentials`);
  return data.credentials;
}

export async function nodeOperation(node: string, operation: string, method: 'get' | 'post' = 'get'): Promise<unknown> {
  const { data } = await axiosInstance.request({ method, url: `${adminBase}/${node}/${operation}` });
  return data.result ?? data;
}

export async function patchRemoteConfiguration(
  node: string,
  patch: Record<string, unknown>,
): Promise<DbevConfigPatchResponse> {
  const { data } = await axiosInstance.patch(`${adminBase}/${node}/remote-config`, { patch });
  return data.result;
}

export async function getSchedulerRecommendation(
  node: string,
  request: SchedulerRecommendationRequest,
  signal?: AbortSignal,
): Promise<SchedulerRecommendation> {
  const { data } = await axiosInstance.get(`${adminBase}/${node}/scheduler/recommendation`, {
    params: schedulerRecommendationParams(request),
    signal,
  });
  return parseSchedulerRecommendation(data.result);
}

export async function pullNodeImage(node: string, protocol: string, image?: string): Promise<unknown> {
  const { data } = await axiosInstance.post(`${adminBase}/${node}/pull-image`, { protocol, image: image || undefined });
  return data.result;
}
