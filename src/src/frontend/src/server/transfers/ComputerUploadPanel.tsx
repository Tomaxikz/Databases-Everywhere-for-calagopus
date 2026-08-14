import { faFileArrowUp, faMagnifyingGlass, faTrash, faXmark } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Group, Table as MantineTable, Stack, Text } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { httpErrorToHuman } from '@/api/axios.ts';
import Alert from '@/elements/Alert.tsx';
import Badge from '@/elements/Badge.tsx';
import Button from '@/elements/Button.tsx';
import Card from '@/elements/Card.tsx';
import Checkbox from '@/elements/input/Checkbox.tsx';
import FileInput from '@/elements/input/FileInput.tsx';
import Select from '@/elements/input/Select.tsx';
import TextInput from '@/elements/input/TextInput.tsx';
import Progress from '@/elements/Progress.tsx';
import { useToast } from '@/providers/ToastProvider.tsx';
import { deleteStagedUpload, inspectTemporaryUpload, queueUploadImport, uploadStagedDump } from '../../api/client.ts';
import { responseStatus } from '../../api/mutationErrors.ts';
import type { DatabaseRecord, DumpInspection, StagedUploadList, TemporaryUploadRecord } from '../../api/types.ts';
import { formatBytes, formatTimestamp } from '../../components/common.tsx';
import {
  canQueueUploadImport,
  disableUploadsForSession,
  isUploadContractMismatch,
  markUploadImporting,
  mongoImportConflictGuidance,
  mongoSourceDiscoveryState,
  resumableUploads,
  uploadFailureGuidance,
  uploadsDisabledForSession,
  validateDumpFile,
  validateMongoSourceForCatalog,
} from './uploadContracts.ts';

type UploadAction = 'upload' | 'inspect' | 'import' | 'delete' | null;

interface Props {
  server: string;
  database: DatabaseRecord;
  data?: StagedUploadList;
  loading: boolean;
  error: unknown;
  refetch: () => Promise<unknown>;
  onQueued: () => void;
  onFallback: () => void;
  onReadyUploadChange?: (upload: TemporaryUploadRecord | null) => void;
}

export default function ComputerUploadPanel({
  server,
  database,
  data,
  loading,
  error,
  refetch,
  onQueued,
  onFallback,
  onReadyUploadChange,
}: Props) {
  const { addToast } = useToast();
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [sha256, setSha256] = useState('');
  const [activeId, setActiveId] = useState('');
  const [activeUpload, setActiveUpload] = useState<TemporaryUploadRecord | null>(null);
  const [catalog, setCatalog] = useState<DumpInspection | null>(null);
  const [action, setAction] = useState<UploadAction>(null);
  const [progress, setProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [messageStatus, setMessageStatus] = useState<number | null>(null);
  const [mode, setMode] = useState<'merge' | 'wipe'>('merge');
  const [wipeConfirmed, setWipeConfirmed] = useState(false);
  const [sourceDatabase, setSourceDatabase] = useState('');
  const abortController = useRef<AbortController | null>(null);
  const queued = useRef(false);

  const resumable = useMemo(() => resumableUploads(data?.uploads ?? []), [data?.uploads]);
  const fileError = file ? validateDumpFile(file, data?.max_upload_bytes) : null;
  const sha256Error =
    sha256 && !/^[a-f0-9]{64}$/u.test(sha256) ? 'Use exactly 64 lowercase hexadecimal characters.' : null;
  const mongoDiscovery = useMemo(
    () => mongoSourceDiscoveryState(catalog, data?.api_version),
    [catalog, data?.api_version],
  );
  const sourceDatabaseError =
    database.protocol === 'mongodb' ? validateMongoSourceForCatalog(sourceDatabase, catalog, data?.api_version) : null;
  const busy = action !== null;
  const describeError = (cause: unknown) => {
    const base = httpErrorToHuman(cause);
    const status = responseStatus(cause);
    if (status === 409) return base;
    return uploadFailureGuidance(status) ?? base;
  };

  useEffect(() => {
    if (activeUpload) {
      const refreshed = resumable.find((upload) => upload.upload_id === activeUpload.upload_id);
      if (refreshed) {
        setActiveUpload(refreshed);
      } else if (data && action === null) {
        setActiveId('');
        setActiveUpload(null);
        setCatalog(null);
        setSourceDatabase('');
        queued.current = false;
        setMessage('That temporary upload expired, was deleted, or was consumed by a successful import.');
      }
      return;
    }
    const next = resumable.find((upload) => upload.state === 'ready') ?? resumable[0];
    if (next) {
      setActiveId(next.upload_id);
      setActiveUpload(next);
      setCatalog(next.catalog ?? null);
      setSourceDatabase('');
    }
  }, [action, activeUpload, data, resumable]);

  useEffect(() => {
    onReadyUploadChange?.(
      activeUpload && canQueueUploadImport(activeUpload.state) && !queued.current ? activeUpload : null,
    );
  }, [activeUpload, onReadyUploadChange]);

  useEffect(() => {
    if (database.protocol !== 'mongodb') return;
    if (mongoDiscovery.mode === 'auto') {
      setSourceDatabase(mongoDiscovery.candidates[0] ?? '');
    } else if (mongoDiscovery.mode === 'select' && !mongoDiscovery.candidates.includes(sourceDatabase.trim())) {
      setSourceDatabase('');
    }
  }, [database.protocol, mongoDiscovery, sourceDatabase]);

  useEffect(() => {
    if (action || !activeUpload || !['uploading', 'uploaded', 'processing'].includes(activeUpload.state)) return;
    const interval = window.setInterval(() => void refetch(), 2_500);
    return () => window.clearInterval(interval);
  }, [action, activeUpload, refetch]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!activeUpload || activeUpload.state !== 'ready' || queued.current) return;
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [activeUpload]);

  useEffect(() => {
    if (!isUploadContractMismatch(error)) return;
    disableUploadsForSession(database.node_uuid);
    onFallback();
  }, [database.node_uuid, error, onFallback]);

  const refreshAfterStateError = async (cause: unknown) => {
    const status = responseStatus(cause);
    if (status === 404) {
      setActiveId('');
      setActiveUpload(null);
      setCatalog(null);
      setSourceDatabase('');
      setMessage('That temporary upload expired, was deleted, or was already consumed.');
      setMessageStatus(404);
    }
    if (status === 404 || status === 409 || status === null) await refetch();
  };

  const upload = async () => {
    if (!file || fileError || sha256Error || busy) return;
    const controller = new AbortController();
    abortController.current = controller;
    setAction('upload');
    setProgress(null);
    setMessage(null);
    setMessageStatus(null);
    queued.current = false;
    try {
      const result = await uploadStagedDump(server, database.uuid, file, {
        sha256: sha256 || undefined,
        signal: controller.signal,
        onProgress: (loaded, total) => setProgress({ loaded, total }),
      });
      setActiveId(result.upload_id);
      setActiveUpload(result);
      setCatalog(result.catalog ?? null);
      setSourceDatabase('');
      setFile(null);
      setSha256('');
      await refetch();
      addToast('Dump uploaded. Review it before starting the import.', 'success');
    } catch (cause) {
      if (controller.signal.aborted) {
        setMessage('Upload cancelled. The host upload list was reconciled before another submission.');
        await refetch();
      } else if (isUploadContractMismatch(cause)) {
        disableUploadsForSession(database.node_uuid);
        setMessage('This node does not support temporary uploads. Existing import methods are still available.');
        onFallback();
      } else {
        setMessageStatus(responseStatus(cause));
        setMessage(describeError(cause));
        await refreshAfterStateError(cause);
      }
    } finally {
      abortController.current = null;
      setAction(null);
    }
  };

  const inspect = async () => {
    if (!activeUpload || busy) return;
    setAction('inspect');
    setMessage(null);
    setMessageStatus(null);
    try {
      const result = await inspectTemporaryUpload(server, database.uuid, activeUpload.upload_id);
      setCatalog(result);
      setActiveUpload((current) => (current ? { ...current, catalog: result } : current));
    } catch (cause) {
      const status = responseStatus(cause);
      if (status === 429 || status === 503) {
        setMessageStatus(status);
        setMessage(describeError(cause));
      } else {
        setMessageStatus(status);
        setMessage(describeError(cause));
      }
      await refreshAfterStateError(cause);
    } finally {
      setAction(null);
    }
  };

  const inspectedUploads = useRef(new Set<string>());
  useEffect(() => {
    if (
      action ||
      !activeUpload ||
      activeUpload.state !== 'ready' ||
      catalog ||
      inspectedUploads.current.has(activeUpload.upload_id)
    ) {
      return;
    }
    inspectedUploads.current.add(activeUpload.upload_id);
    void inspect();
  }, [action, activeUpload, catalog]);

  const startImport = async () => {
    if (
      !activeUpload ||
      !canQueueUploadImport(activeUpload.state) ||
      busy ||
      (mode === 'wipe' && !wipeConfirmed) ||
      sourceDatabaseError
    ) {
      return;
    }
    setAction('import');
    setMessage(null);
    setMessageStatus(null);
    try {
      await queueUploadImport(
        server,
        database.uuid,
        activeUpload.upload_id,
        mode,
        database.protocol === 'mongodb' ? sourceDatabase.trim() : undefined,
      );
      queued.current = true;
      setActiveUpload((current) => (current ? { ...current, state: 'importing' } : current));
      queryClient.setQueriesData<StagedUploadList>(
        { queryKey: ['dbev', server, database.uuid, 'staged-uploads'] },
        (current) => markUploadImporting(current, activeUpload.upload_id),
      );
      addToast('Import queued. The upload will be consumed only after a successful import.', 'success');
      onQueued();
    } catch (cause) {
      const correction =
        database.protocol === 'mongodb'
          ? mongoImportConflictGuidance(responseStatus(cause), sourceDatabase, mongoDiscovery)
          : null;
      setMessageStatus(responseStatus(cause));
      setMessage([describeError(cause), correction].filter(Boolean).join(' '));
      await refreshAfterStateError(cause);
    } finally {
      setAction(null);
    }
  };

  const remove = async () => {
    if (!activeUpload || busy) return;
    setAction('delete');
    setMessage(null);
    setMessageStatus(null);
    try {
      await deleteStagedUpload(server, database.uuid, activeUpload.upload_id);
      setActiveId('');
      setActiveUpload(null);
      setCatalog(null);
      setSourceDatabase('');
      await refetch();
      addToast('Temporary upload deleted.', 'success');
    } catch (cause) {
      setMessageStatus(responseStatus(cause));
      setMessage(describeError(cause));
      await refreshAfterStateError(cause);
    } finally {
      setAction(null);
    }
  };

  if (uploadsDisabledForSession(database.node_uuid) || data?.available === false) {
    return (
      <Alert color='yellow' title='Upload from computer is unavailable on this node'>
        {data?.reason ?? 'The node did not accept the API 0.11 temporary upload contract during this session.'}
      </Alert>
    );
  }
  if (error) return <Alert color='red'>{httpErrorToHuman(error)}</Alert>;
  if (loading && !data) return <Text c='dimmed'>Checking temporary upload support…</Text>;

  return (
    <Stack gap='md'>
      {message && (
        <Alert color='yellow'>
          <Stack gap='xs'>
            <Text size='sm'>{message}</Text>
            {messageStatus === 409 && (
              <Group justify='flex-end'>
                <Button size='compact-xs' variant='default' onClick={() => void refetch()}>
                  Refresh
                </Button>
              </Group>
            )}
          </Stack>
        </Alert>
      )}

      {resumable.length > 0 && (
        <Select
          searchable
          label='Ready and resumable uploads'
          description='Temporary uploads are stored by DBEV and expire automatically.'
          value={activeId}
          data={resumable.map((upload) => ({
            value: upload.upload_id,
            label: `${upload.original_filename} · ${upload.state} · ${formatBytes(upload.size_bytes)}`,
          }))}
          onChange={(value) => {
            const next = resumable.find((upload) => upload.upload_id === value) ?? null;
            setActiveId(value ?? '');
            setActiveUpload(next);
            setCatalog(next?.catalog ?? null);
            setSourceDatabase('');
            queued.current = next?.state === 'importing';
          }}
        />
      )}

      {!activeUpload && (
        <Card p='md'>
          <Stack gap='sm'>
            <FileInput
              clearable
              label='Database dump'
              description={`Raw streaming upload${data?.max_upload_bytes ? ` · up to ${formatBytes(data.max_upload_bytes)}` : ''}`}
              accept='.sql,.dump,.backup,.archive,.snapshot,.archive.gz,.tar.gz,.tgz,.tar,.zip,.gz,.gzip,.bz2,.bzip2'
              value={file}
              onChange={(next) => {
                setFile(next);
                setProgress(null);
                setMessage(null);
                setMessageStatus(null);
              }}
            />
            <TextInput
              label='Expected SHA-256 (optional)'
              description='DBEV verifies this checksum while accepting the stream.'
              value={sha256}
              error={sha256Error || undefined}
              onChange={(event) => setSha256(event.currentTarget.value.trim())}
              placeholder='64 lowercase hexadecimal characters'
            />
            {fileError && <Alert color='red'>{fileError}</Alert>}
            {progress && (
              <Stack gap={4}>
                <Group justify='space-between'>
                  <Text size='sm'>
                    {progress.loaded >= progress.total
                      ? 'Upload sent; waiting for DBEV to validate it…'
                      : `Uploading ${file?.name ?? 'dump'}…`}
                  </Text>
                  <Text size='sm' c='dimmed'>
                    {formatBytes(progress.loaded)} / {formatBytes(progress.total)}
                  </Text>
                </Group>
                <Progress
                  value={progress.total > 0 ? Math.min(100, (progress.loaded / progress.total) * 100) : 0}
                  hourglass={false}
                  withLabel={false}
                />
              </Stack>
            )}
            <Group justify='flex-end'>
              {action === 'upload' && (
                <Button
                  variant='default'
                  leftSection={<FontAwesomeIcon icon={faXmark} />}
                  onClick={() => abortController.current?.abort()}
                >
                  Cancel upload
                </Button>
              )}
              <Button
                leftSection={<FontAwesomeIcon icon={faFileArrowUp} />}
                loading={action === 'upload'}
                disabled={!file || Boolean(fileError) || Boolean(sha256Error) || busy}
                onClick={() => void upload()}
              >
                Upload from computer
              </Button>
            </Group>
          </Stack>
        </Card>
      )}

      {activeUpload && (
        <Card p='md'>
          <Stack gap='md'>
            <Group justify='space-between' align='flex-start'>
              <div>
                <Group gap='xs'>
                  <Text fw={700}>{activeUpload.original_filename}</Text>
                  <Badge color={activeUpload.state === 'ready' ? 'green' : 'blue'}>{activeUpload.state}</Badge>
                </Group>
                <Text size='sm' c='dimmed'>
                  {formatBytes(activeUpload.size_bytes)} · expires {formatTimestamp(activeUpload.expires_at)}
                </Text>
                <Text size='xs' ff='monospace' c='dimmed' mt={4}>
                  SHA-256: {activeUpload.sha256 ?? 'not supplied'}
                </Text>
              </div>
              <Group gap='xs'>
                <Button
                  variant='default'
                  leftSection={<FontAwesomeIcon icon={faMagnifyingGlass} />}
                  loading={action === 'inspect'}
                  disabled={busy || !canQueueUploadImport(activeUpload.state)}
                  onClick={() => void inspect()}
                >
                  Inspect contents
                </Button>
                <Button
                  variant='subtle'
                  color='red'
                  leftSection={<FontAwesomeIcon icon={faTrash} />}
                  loading={action === 'delete'}
                  disabled={busy || activeUpload.state === 'importing'}
                  onClick={() => void remove()}
                >
                  Delete
                </Button>
              </Group>
            </Group>

            {catalog && <CatalogPreview catalog={catalog} />}

            {database.protocol === 'mongodb' && mongoDiscovery.mode === 'auto' && (
              <Alert color='blue' title='Source database detected'>
                DBEV found one source database: <strong>{mongoDiscovery.candidates[0]}</strong>.
              </Alert>
            )}
            {database.protocol === 'mongodb' && mongoDiscovery.mode === 'select' && (
              <Select
                label='Original MongoDB database name'
                description='Choose one of the source databases in the complete dump catalog.'
                data={mongoDiscovery.candidates.map((candidate) => ({ value: candidate, label: candidate }))}
                value={sourceDatabase}
                error={sourceDatabase ? sourceDatabaseError : undefined}
                onChange={(value) => setSourceDatabase(value ?? '')}
                required
              />
            )}
            {database.protocol === 'mongodb' && mongoDiscovery.mode === 'manual' && (
              <Stack gap={4}>
                <TextInput
                  label='Original MongoDB database name'
                  description='Discovery is unavailable or incomplete, so enter the source database from the dump.'
                  value={sourceDatabase}
                  error={sourceDatabase ? sourceDatabaseError : undefined}
                  onChange={(event) => setSourceDatabase(event.currentTarget.value)}
                  required
                />
                {mongoDiscovery.hints.length > 0 && (
                  <Text size='xs' c='dimmed'>
                    Incomplete catalog hints (not authoritative): {mongoDiscovery.hints.join(', ')}
                  </Text>
                )}
              </Stack>
            )}
            <Select
              label='Import behavior'
              value={mode}
              data={[
                { value: 'merge', label: 'Merge with existing data' },
                { value: 'wipe', label: 'Clear target, then import' },
              ]}
              onChange={(value) => {
                if (!value) return;
                setMode(value as 'merge' | 'wipe');
                setWipeConfirmed(false);
              }}
            />
            {mode === 'wipe' && (
              <Alert color='red' title='This can remove existing data'>
                <Checkbox
                  checked={wipeConfirmed}
                  onChange={(event) => setWipeConfirmed(event.currentTarget.checked)}
                  label='I understand that DBEV clears the target database before importing.'
                />
              </Alert>
            )}
            <Group justify='flex-end'>
              <Button
                loading={action === 'import'}
                disabled={
                  busy ||
                  !canQueueUploadImport(activeUpload.state) ||
                  (mode === 'wipe' && !wipeConfirmed) ||
                  Boolean(sourceDatabaseError)
                }
                onClick={() => void startImport()}
              >
                {activeUpload.error ? 'Retry full import' : 'Queue full import'}
              </Button>
            </Group>
          </Stack>
        </Card>
      )}
    </Stack>
  );
}

function CatalogPreview({ catalog }: { catalog: DumpInspection }) {
  return (
    <Stack gap='xs'>
      <Alert color='blue' title='Read-only dump preview'>
        {catalog.selective_supported
          ? 'This catalog reports selectable objects, but computer uploads are submitted as full-database imports.'
          : catalog.selective_unavailable_reason || 'Uploaded dumps are imported in full.'}
      </Alert>
      <MantineTable.ScrollContainer minWidth={520} type='native'>
        <MantineTable striped highlightOnHover>
          <MantineTable.Thead>
            <MantineTable.Tr>
              <MantineTable.Th>Object</MantineTable.Th>
              <MantineTable.Th>Namespace</MantineTable.Th>
              <MantineTable.Th>Kind</MantineTable.Th>
            </MantineTable.Tr>
          </MantineTable.Thead>
          <MantineTable.Tbody>
            {catalog.objects.length ? (
              catalog.objects.map((object) => (
                <MantineTable.Tr key={object.selection_key}>
                  <MantineTable.Td>{object.name}</MantineTable.Td>
                  <MantineTable.Td>{object.namespace ?? '—'}</MantineTable.Td>
                  <MantineTable.Td>{object.kind}</MantineTable.Td>
                </MantineTable.Tr>
              ))
            ) : (
              <MantineTable.Tr>
                <MantineTable.Td colSpan={3}>
                  <Text ta='center' c='dimmed' py='md'>
                    No selectable objects were reported. Full import remains available.
                  </Text>
                </MantineTable.Td>
              </MantineTable.Tr>
            )}
          </MantineTable.Tbody>
        </MantineTable>
      </MantineTable.ScrollContainer>
    </Stack>
  );
}
