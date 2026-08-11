import { faCloudArrowDown, faDatabase, faFileArrowUp } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Group, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { httpErrorToHuman } from '@/api/axios.ts';
import Alert from '@/elements/Alert.tsx';
import Button from '@/elements/Button.tsx';
import { ServerCan } from '@/elements/Can.tsx';
import Checkbox from '@/elements/input/Checkbox.tsx';
import Select from '@/elements/input/Select.tsx';
import Switch from '@/elements/input/Switch.tsx';
import { Modal, ModalFooter } from '@/elements/modals/Modal.tsx';
import SegmentedControl from '@/elements/SegmentedControl.tsx';
import { useToast } from '@/providers/ToastProvider.tsx';
import {
  deleteStagedUpload,
  getArtifacts,
  getDatabaseStatus,
  getStagedUploads,
  getTransferJobs,
  queueArtifactImport,
  queueExport,
  queueRemoteImport,
} from '../../api/client.ts';
import { type DbevMutationFailure, dbevMutationFailure } from '../../api/mutationErrors.ts';
import type { ArtifactRecord, DatabaseRecord, TemporaryUploadRecord, TransferSelection } from '../../api/types.ts';
import { formatBytes, recordId, recordsFromResult } from '../../components/common.tsx';
import { supportsSelectiveExport, supportsSelectiveImport } from '../../components/protocols.ts';
import MutationFailureAlert from '../components/MutationFailureAlert.tsx';
import SectionCard from '../components/SectionCard.tsx';
import { artifactCapacityGuidance } from './artifactDownloads.ts';
import ComputerUploadPanel from './ComputerUploadPanel.tsx';
import RemoteSourceFields from './RemoteSourceFields.tsx';
import SelectionEditor from './SelectionEditor.tsx';
import {
  archiveFormatLabel,
  buildRemoteSource,
  buildSelection,
  defaultRemote,
  type ImportArchiveChoice,
  remoteCredentialError,
  resolveImportArchiveFormat,
} from './transferUtils.ts';
import {
  apiSupportsTemporaryUploads,
  cancellationDeletesUpload,
  disableUploadsForSession,
  isUploadContractMismatch,
  uploadsDisabledForSession,
} from './uploadContracts.ts';

type ImportSource = 'computer' | 'saved' | 'remote';
type SavedSourceKind = 'artifact' | 'staged';
type SavedOption = { value: string; label: string; filename: string; kind: SavedSourceKind; state?: string };

export interface ImportPreset {
  revision: number;
  id: string;
  kind?: SavedSourceKind;
}

export default function TransferComposer({
  server,
  database,
  preset,
  onQueued,
  onReadyUploadChange,
}: {
  server: string;
  database: DatabaseRecord;
  preset?: ImportPreset | null;
  onQueued: () => void;
  onReadyUploadChange?: (upload: TemporaryUploadRecord | null) => void;
}) {
  const { addToast } = useToast();
  const queryClient = useQueryClient();
  const [action, setAction] = useState<string | null>(null);
  const [failure, setFailure] = useState<DbevMutationFailure | null>(null);
  const [checkingState, setCheckingState] = useState(false);

  const [exportFormat, setExportFormat] = useState('plain');
  const [selectiveExport, setSelectiveExport] = useState(false);
  const [exportInclude, setExportInclude] = useState<string[]>([]);
  const [exportExclude, setExportExclude] = useState<string[]>([]);

  const [sourceType, setSourceType] = useState<ImportSource>(() =>
    preset || uploadsDisabledForSession(database.node_uuid) ? 'saved' : 'computer',
  );
  const [savedId, setSavedId] = useState(preset?.id ?? '');
  const [archiveChoice, setArchiveChoice] = useState<ImportArchiveChoice>('auto');
  const [importMode, setImportMode] = useState<'merge' | 'wipe'>('merge');
  const [wipeConfirmed, setWipeConfirmed] = useState(false);
  const [selectiveImport, setSelectiveImport] = useState(false);
  const [importInclude, setImportInclude] = useState<string[]>([]);
  const [importExclude, setImportExclude] = useState<string[]>([]);
  const [remote, setRemote] = useState(() => defaultRemote(database.protocol));
  const [uploadContractDisabled, setUploadContractDisabled] = useState(() =>
    uploadsDisabledForSession(database.node_uuid),
  );
  const [readyUpload, setReadyUpload] = useState<TemporaryUploadRecord | null>(null);
  const [pendingSource, setPendingSource] = useState<ImportSource | null>(null);
  const [discardingUpload, setDiscardingUpload] = useState(false);

  const artifactsQuery = useQuery({
    queryKey: ['dbev', server, database.uuid, 'artifacts'],
    queryFn: () => getArtifacts(server, database.uuid),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const uploadsQuery = useQuery({
    queryKey: ['dbev', server, database.uuid, 'staged-uploads', uploadContractDisabled ? 'legacy' : 'all'],
    queryFn: () => getStagedUploads(server, database.uuid, !uploadContractDisabled),
    retry: (failureCount, error) => !isUploadContractMismatch(error) && failureCount < 2,
    staleTime: 15_000,
    refetchOnMount: 'always',
    refetchOnReconnect: true,
    refetchOnWindowFocus: false,
  });
  const artifacts = recordsFromResult(artifactsQuery.data, ['artifacts', 'items', 'data']) as ArtifactRecord[];
  const savedOptions = useMemo<SavedOption[]>(
    () => [
      ...(uploadsQuery.data?.staged_uploads ?? []).map((upload) => ({
        value: upload.id,
        label: `${upload.original_name} · operator staged · ${formatBytes(upload.size_bytes)}`,
        filename: upload.original_name,
        kind: 'staged' as const,
      })),
      ...artifacts.flatMap((artifact): SavedOption[] => {
        const id = recordId(artifact);
        return id
          ? [
              {
                value: id,
                label: `${id} · export · ${formatBytes(artifact.size_bytes)}`,
                filename: id,
                kind: 'artifact',
              },
            ]
          : [];
      }),
    ],
    [artifacts, uploadsQuery.data],
  );
  const selectedSaved = savedOptions.find((option) => option.value === savedId) ?? null;
  const computerAvailable =
    uploadsQuery.data?.available === true &&
    apiSupportsTemporaryUploads(uploadsQuery.data.api_version) &&
    !uploadContractDisabled;

  useEffect(() => {
    if (!preset) return;
    setSourceType('saved');
    setSavedId(preset.id);
  }, [preset]);
  useEffect(() => {
    if (!savedId && savedOptions[0]) setSavedId(savedOptions[0].value);
  }, [savedId, savedOptions]);
  useEffect(() => {
    if (!isUploadContractMismatch(uploadsQuery.error)) return;
    disableUploadsForSession(database.node_uuid);
    setUploadContractDisabled(true);
    if (sourceType === 'computer') setSourceType('saved');
  }, [database.node_uuid, sourceType, uploadsQuery.error]);
  useEffect(() => {
    if (!uploadsQuery.data?.contract_mismatch) return;
    disableUploadsForSession(database.node_uuid);
    setUploadContractDisabled(true);
    if (sourceType === 'computer') setSourceType('saved');
  }, [database.node_uuid, sourceType, uploadsQuery.data?.contract_mismatch]);
  useEffect(() => onReadyUploadChange?.(readyUpload), [onReadyUploadChange, readyUpload]);
  useEffect(() => {
    if (uploadsQuery.data?.available === false && sourceType === 'computer') setSourceType('saved');
  }, [sourceType, uploadsQuery.data?.available]);
  useEffect(() => {
    const kind = sourceType === 'remote' ? 'remote' : 'artifact';
    if (!supportsSelectiveImport(database.protocol, kind)) setSelectiveImport(false);
  }, [database.protocol, selectedSaved?.kind, sourceType]);
  useEffect(() => setWipeConfirmed(false), [importMode]);

  const mutate = async (name: string, operation: () => Promise<unknown>) => {
    setAction(name);
    setFailure(null);
    try {
      await operation();
      addToast('Transfer queued.', 'success');
      onQueued();
      return true;
    } catch (error) {
      const nextFailure = dbevMutationFailure(error, httpErrorToHuman(error));
      const capacityMessage = name === 'export' ? artifactCapacityGuidance(nextFailure) : null;
      const presentedFailure = capacityMessage ? { ...nextFailure, message: capacityMessage } : nextFailure;
      setFailure(presentedFailure);
      if (!presentedFailure.retryable) addToast(presentedFailure.message, 'error');
      if (nextFailure.status === 404 || nextFailure.status === 409) await uploadsQuery.refetch();
      if (name === 'export' && nextFailure.status === 409) {
        await Promise.allSettled([
          artifactsQuery.refetch(),
          queryClient.invalidateQueries({ queryKey: ['dbev', server, database.uuid, 'transfer-jobs'] }),
        ]);
      }
      return false;
    } finally {
      setAction(null);
    }
  };

  const doExport = (event: FormEvent) => {
    event.preventDefault();
    let selection: TransferSelection | undefined;
    try {
      selection = selectiveExport ? buildSelection(exportInclude, exportExclude) : undefined;
    } catch (error) {
      addToast(String(error), 'error');
      return;
    }
    void mutate('export', () => queueExport(server, database.uuid, database.protocol, exportFormat, selection));
  };

  const doImport = async (event: FormEvent) => {
    event.preventDefault();
    if (importMode === 'wipe' && !physicalArtifact && !wipeConfirmed) return;
    let selection: TransferSelection | undefined;
    try {
      selection = selectiveImport ? buildSelection(importInclude, importExclude) : undefined;
    } catch (error) {
      addToast(String(error), 'error');
      return;
    }

    if (sourceType === 'remote') {
      const source = buildRemoteSource(database.protocol, remote);
      await mutate('import', () => queueRemoteImport(server, database.uuid, source, importMode, selection));
      setRemote((current) => ({ ...current, password: '', apiKey: '' }));
      return;
    }
    if (!selectedSaved) return;
    await mutate('import', () =>
      queueArtifactImport(
        server,
        database.uuid,
        selectedSaved.value,
        importMode,
        resolveImportArchiveFormat(database.protocol, selectedSaved.filename, archiveChoice),
        selection,
      ),
    );
  };

  const physicalArtifact = sourceType === 'saved' && ['redis', 'valkey', 'qdrant'].includes(database.protocol);
  const importSourceKind = sourceType === 'remote' ? 'remote' : 'artifact';
  const remoteSecretError = sourceType === 'remote' ? remoteCredentialError(database.protocol, remote) : null;
  const importDisabled =
    action !== null ||
    (sourceType === 'saved' && !selectedSaved) ||
    (sourceType === 'remote' && !remote.host.trim()) ||
    Boolean(remoteSecretError) ||
    (importMode === 'wipe' && !physicalArtifact && !wipeConfirmed);

  return (
    <Stack gap='md'>
      <MutationFailureAlert
        failure={failure}
        checking={checkingState}
        onCheck={() => {
          setCheckingState(true);
          void Promise.all([
            getDatabaseStatus(server, database.uuid),
            getTransferJobs(server, database.uuid),
            uploadsQuery.refetch(),
          ])
            .then(() => {
              setFailure(null);
              addToast('Database and transfer state reconciled.', 'success');
            })
            .catch((error) => setFailure(dbevMutationFailure(error, httpErrorToHuman(error))))
            .finally(() => setCheckingState(false));
        }}
      />

      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing='md' style={{ alignItems: 'start' }}>
        <form onSubmit={doExport} style={{ minWidth: 0 }}>
          <SectionCard
            heading={
              <div>
                <Title order={3}>Create an export</Title>
                <Text c='dimmed' size='sm'>
                  {database.stream_exports_only
                    ? 'DBEV creates a temporary one-use dump in the background. Download it from Transfer history.'
                    : 'DBEV creates the dump in the background. Completed exports appear under Files.'}
                </Text>
              </div>
            }
            headerRight={<FontAwesomeIcon icon={faCloudArrowDown} size='2x' />}
          >
            {database.stream_exports_only && (
              <Alert color='yellow' title='This export will be one-use' mb='md'>
                The file remains in a private temporary spool until it is downloaded, disconnected, deleted, or reaches
                its one-hour expiry. An interrupted download may not be retryable. This database can hold up to{' '}
                {database.max_artifacts_per_instance} retained artifacts plus pending one-use exports.
              </Alert>
            )}
            <SimpleGrid cols={{ base: 1, md: 2 }}>
              {!['redis', 'valkey', 'qdrant'].includes(database.protocol) ? (
                <Select
                  label='Compression'
                  value={exportFormat}
                  onChange={(value) => value && setExportFormat(value)}
                  data={
                    database.protocol === 'mongodb'
                      ? [
                          { value: 'plain', label: 'Native gzip' },
                          { value: 'bzip2', label: 'Native gzip with Bzip2 wrapper' },
                        ]
                      : [
                          { value: 'plain', label: 'Uncompressed' },
                          { value: 'gzip', label: 'Gzip' },
                          { value: 'bzip2', label: 'Bzip2' },
                        ]
                  }
                />
              ) : (
                <Alert color='blue'>This database uses its native full-database archive format.</Alert>
              )}
              {supportsSelectiveExport(database.protocol) && (
                <Switch
                  mt='xl'
                  label='Export selected objects only'
                  checked={selectiveExport}
                  onChange={(event) => setSelectiveExport(event.currentTarget.checked)}
                />
              )}
            </SimpleGrid>
            {selectiveExport && (
              <SelectionEditor
                server={server}
                database={database.uuid}
                protocol={database.protocol}
                operation='export'
                discover
                include={exportInclude}
                exclude={exportExclude}
                onInclude={setExportInclude}
                onExclude={setExportExclude}
              />
            )}
            <Group justify='flex-end' mt='lg'>
              <ServerCan action='databases-everywhere.export'>
                <Button type='submit' loading={action === 'export'} disabled={selectiveExport && !exportInclude.length}>
                  Queue export
                </Button>
              </ServerCan>
            </Group>
          </SectionCard>
        </form>

        <SectionCard
          heading={
            <div>
              <Title order={3}>Import into {database.display_name}</Title>
              <Text c='dimmed' size='sm'>
                Upload from this computer, reuse a saved source, or connect to another database.
              </Text>
            </div>
          }
          headerRight={<FontAwesomeIcon icon={faFileArrowUp} size='2x' />}
        >
          <SegmentedControl
            fullWidth
            value={sourceType}
            onChange={(value) => {
              const next = value as ImportSource;
              if (sourceType === 'computer' && next !== 'computer' && readyUpload) {
                setPendingSource(next);
              } else {
                setSourceType(next);
              }
            }}
            data={[
              ...(computerAvailable || (uploadsQuery.isPending && !uploadContractDisabled)
                ? [{ value: 'computer', label: 'Upload from computer' }]
                : []),
              { value: 'saved', label: 'Saved file' },
              { value: 'remote', label: 'Another database' },
            ]}
          />

          {sourceType === 'computer' ? (
            <ServerCan action='databases-everywhere.import'>
              <Stack mt='lg'>
                <ComputerUploadPanel
                  server={server}
                  database={database}
                  data={uploadsQuery.data}
                  loading={uploadsQuery.isPending}
                  error={uploadsQuery.error}
                  refetch={uploadsQuery.refetch}
                  onQueued={onQueued}
                  onFallback={() => {
                    setUploadContractDisabled(true);
                    setSourceType('saved');
                  }}
                  onReadyUploadChange={setReadyUpload}
                />
              </Stack>
            </ServerCan>
          ) : (
            <form onSubmit={(event) => void doImport(event)}>
              <Stack gap='md' mt='lg'>
                {sourceType === 'saved' && (
                  <>
                    {(artifactsQuery.error || uploadsQuery.error) && (
                      <Alert color='yellow'>
                        Some saved sources could not be loaded:{' '}
                        {httpErrorToHuman(artifactsQuery.error || uploadsQuery.error)}
                      </Alert>
                    )}
                    <Select
                      searchable
                      label='Saved dump or export'
                      data={savedOptions}
                      value={savedId}
                      onChange={(value) => {
                        setSavedId(value || '');
                        setArchiveChoice('auto');
                        setSelectiveImport(false);
                      }}
                      nothingFoundMessage='No saved sources are available.'
                      required
                    />
                  </>
                )}

                {sourceType === 'remote' ? (
                  <>
                    <Alert color='blue' icon={<FontAwesomeIcon icon={faDatabase} />}>
                      Credentials are sent to DBEV for this transfer and are not stored in its durable job record.
                    </Alert>
                    <RemoteSourceFields protocol={database.protocol} value={remote} onChange={setRemote} />
                    {remoteSecretError && <Alert color='red'>{remoteSecretError}</Alert>}
                    {!remote.tls && (
                      <Alert color='yellow'>Plaintext imports must also be allowed by this DBEV node's policy.</Alert>
                    )}
                  </>
                ) : (
                  !physicalArtifact &&
                  selectedSaved && (
                    <Select
                      label='Archive wrapper'
                      description={`Detected: ${archiveFormatLabel(database.protocol, selectedSaved.filename)}`}
                      value={archiveChoice}
                      onChange={(value) => value && setArchiveChoice(value as ImportArchiveChoice)}
                      data={[
                        { value: 'auto', label: 'Detect from filename' },
                        { value: 'unwrapped', label: 'Unwrapped dump' },
                        { value: 'gzip', label: 'Gzip' },
                        { value: 'bzip2', label: 'Bzip2' },
                        { value: 'tar', label: 'Tar' },
                        { value: 'tar.gz', label: 'Tar + gzip' },
                        { value: 'zip', label: 'Zip' },
                      ]}
                    />
                  )
                )}

                {physicalArtifact ? (
                  <Alert color='blue'>This native archive replaces the complete physical database.</Alert>
                ) : (
                  <SimpleGrid cols={{ base: 1, md: 2 }}>
                    <Select
                      label='Import behavior'
                      value={importMode}
                      onChange={(value) => value && setImportMode(value as typeof importMode)}
                      data={[
                        { value: 'merge', label: 'Merge with existing data' },
                        { value: 'wipe', label: 'Clear target, then import' },
                      ]}
                    />
                    {supportsSelectiveImport(database.protocol, importSourceKind) && (
                      <Switch
                        mt='xl'
                        label='Import selected objects only'
                        checked={selectiveImport}
                        onChange={(event) => setSelectiveImport(event.currentTarget.checked)}
                      />
                    )}
                  </SimpleGrid>
                )}
                {selectiveImport && (
                  <SelectionEditor
                    server={server}
                    database={database.uuid}
                    protocol={database.protocol}
                    operation='import'
                    discover={false}
                    include={importInclude}
                    exclude={importExclude}
                    onInclude={setImportInclude}
                    onExclude={setImportExclude}
                  />
                )}
                {importMode === 'wipe' && !physicalArtifact && (
                  <Alert color='red' title='This can remove existing data'>
                    <Checkbox
                      checked={wipeConfirmed}
                      onChange={(event) => setWipeConfirmed(event.currentTarget.checked)}
                      label='I understand that DBEV clears the target database before importing.'
                    />
                  </Alert>
                )}
              </Stack>
              <Group justify='flex-end' mt='lg'>
                <ServerCan action='databases-everywhere.import'>
                  <Button type='submit' loading={action === 'import'} disabled={importDisabled}>
                    Queue import
                  </Button>
                </ServerCan>
              </Group>
            </form>
          )}
        </SectionCard>
      </SimpleGrid>

      <Modal
        opened={pendingSource !== null}
        onClose={() => {
          setPendingSource(null);
        }}
        title='Cancel this upload import?'
      >
        <Text>
          <strong>{readyUpload?.original_filename}</strong> has not been accepted by an import job. Canceling deletes
          the temporary upload from the database host.
        </Text>
        <ModalFooter>
          <Button
            color='red'
            loading={discardingUpload}
            onClick={async () => {
              if (!readyUpload || !pendingSource || !cancellationDeletesUpload(readyUpload.state, false)) return;
              setDiscardingUpload(true);
              try {
                await deleteStagedUpload(server, database.uuid, readyUpload.upload_id);
                await uploadsQuery.refetch();
                setReadyUpload(null);
                setSourceType(pendingSource);
                setPendingSource(null);
                addToast('Temporary upload discarded.', 'success');
              } catch (cause) {
                addToast(httpErrorToHuman(cause), 'error');
              } finally {
                setDiscardingUpload(false);
              }
            }}
          >
            Cancel import and delete
          </Button>
          <Button
            variant='default'
            disabled={discardingUpload}
            onClick={() => {
              setPendingSource(null);
            }}
          >
            Continue import
          </Button>
        </ModalFooter>
      </Modal>
    </Stack>
  );
}
