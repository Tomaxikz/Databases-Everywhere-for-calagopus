import { faDownload, faFileImport, faRotateRight, faTrash } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Group, Table as MantineTable, Stack, Text, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { httpErrorToHuman } from '@/api/axios.ts';
import Alert from '@/elements/Alert.tsx';
import Badge from '@/elements/Badge.tsx';
import Button from '@/elements/Button.tsx';
import { ServerCan } from '@/elements/Can.tsx';
import Card from '@/elements/Card.tsx';
import NumberInput from '@/elements/input/NumberInput.tsx';
import TextInput from '@/elements/input/TextInput.tsx';
import ConfirmationModal from '@/elements/modals/ConfirmationModal.tsx';
import SegmentedControl from '@/elements/SegmentedControl.tsx';
import { Pagination } from '@/elements/Table.tsx';
import { useToast } from '@/providers/ToastProvider.tsx';
import {
  applyArtifactRetention,
  deleteArtifact,
  deleteStagedUpload,
  downloadUrl,
  getArtifacts,
  getStagedUploads,
} from '../../api/client.ts';
import type { ArtifactRecord, DatabaseRecord } from '../../api/types.ts';
import { formatBytes, formatTimestamp, recordId, recordsFromResult } from '../../components/common.tsx';
import { isArtifactGone, startBrowserDownload } from './artifactDownloads.ts';
import { disableUploadsForSession, isUploadContractMismatch, uploadsDisabledForSession } from './uploadContracts.ts';

const PER_PAGE = 10;

type FileKind = 'exports' | 'uploads';
type DeleteTarget = {
  kind: FileKind;
  id: string;
  label: string;
  sourceKind?: 'artifact' | 'staged' | 'upload';
};

export default function TransferFiles({
  server,
  database,
  onImport,
}: {
  server: string;
  database: DatabaseRecord;
  onImport: (id: string, kind: 'artifact' | 'staged' | 'upload') => void;
}) {
  const { addToast } = useToast();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<FileKind>('exports');
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search.trim().toLowerCase());
  const [page, setPage] = useState(1);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [keepLatest, setKeepLatest] = useState<number | string>(7);
  const [maxAgeDays, setMaxAgeDays] = useState<number | string>(30);
  const [savingRetention, setSavingRetention] = useState(false);
  const [uploadContractDisabled, setUploadContractDisabled] = useState(() =>
    uploadsDisabledForSession(database.node_uuid),
  );

  const artifactsQuery = useQuery({
    queryKey: ['dbev', server, database.uuid, 'artifacts'],
    queryFn: () => getArtifacts(server, database.uuid),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const uploadsQuery = useQuery({
    queryKey: ['dbev', server, database.uuid, 'staged-uploads', uploadContractDisabled ? 'legacy' : 'all'],
    queryFn: () => getStagedUploads(server, database.uuid, !uploadContractDisabled),
    staleTime: 30_000,
    retry: (failureCount, cause) => !isUploadContractMismatch(cause) && failureCount < 2,
    refetchOnMount: 'always',
    refetchOnReconnect: true,
    refetchOnWindowFocus: false,
  });
  const artifacts = recordsFromResult(artifactsQuery.data, ['artifacts', 'items', 'data']) as ArtifactRecord[];
  const uploads = useMemo(
    () => [
      ...(uploadsQuery.data?.uploads ?? []).map((upload) => ({
        id: upload.upload_id,
        label: upload.original_filename,
        size: upload.size_bytes,
        modified: upload.updated_at,
        sha256: upload.sha256,
        source: 'Temporary upload',
        importKind: 'upload' as const,
        state: upload.state,
      })),
      ...(uploadsQuery.data?.staged_uploads ?? []).map((upload) => ({
        id: upload.id,
        label: upload.original_name,
        size: upload.size_bytes,
        modified: upload.modified_at,
        sha256: null,
        source: 'Operator staged',
        importKind: 'staged' as const,
        state: 'ready',
      })),
    ],
    [uploadsQuery.data],
  );
  const files = useMemo(
    () =>
      (kind === 'exports'
        ? artifacts.map((artifact) => ({
            id: recordId(artifact),
            label: recordId(artifact),
            size: Number(artifact.size_bytes),
            modified: artifact.modified_at ?? null,
            sha256: typeof artifact.sha256 === 'string' ? artifact.sha256 : null,
            source: 'DBEV export',
            importKind: 'artifact' as const,
            state: 'ready',
          }))
        : uploads
      ).filter(
        (file) => file.id && (!deferredSearch || `${file.label} ${file.id}`.toLowerCase().includes(deferredSearch)),
      ),
    [artifacts, deferredSearch, kind, uploads],
  );
  const pageCount = Math.max(1, Math.ceil(files.length / PER_PAGE));
  const visible = files.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  const loading = kind === 'exports' ? artifactsQuery.isPending : uploadsQuery.isPending;
  const error = kind === 'exports' ? artifactsQuery.error : uploadsQuery.error;

  useEffect(() => setPage(1), [deferredSearch, kind]);
  useEffect(() => {
    if (!isUploadContractMismatch(uploadsQuery.error) && !uploadsQuery.data?.contract_mismatch) return;
    disableUploadsForSession(database.node_uuid);
    setUploadContractDisabled(true);
  }, [database.node_uuid, uploadsQuery.data?.contract_mismatch, uploadsQuery.error]);
  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  const refresh = () => Promise.all([artifactsQuery.refetch(), uploadsQuery.refetch()]);
  const remove = async () => {
    if (!deleteTarget) return;
    if (deleteTarget.kind === 'exports') {
      try {
        await deleteArtifact(server, database.uuid, deleteTarget.id);
        addToast('Export deleted.', 'success');
      } catch (error) {
        if (!isArtifactGone(error)) throw error;
        addToast('This export is already no longer available.', 'success');
      }
      await Promise.all([
        artifactsQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ['dbev', server, database.uuid, 'transfer-jobs'] }),
      ]);
    } else {
      await deleteStagedUpload(
        server,
        database.uuid,
        deleteTarget.id,
        deleteTarget.sourceKind === 'staged' ? 'staged' : 'upload',
      );
      await uploadsQuery.refetch();
      addToast('Upload deleted.', 'success');
    }
    setDeleteTarget(null);
  };

  return (
    <Stack gap='md'>
      <Card p={0}>
        <Group justify='space-between' align='flex-start' p='lg'>
          <div>
            <Title order={3}>Transfer files</Title>
            <Text c='dimmed' size='sm'>
              Download completed exports or resume temporary and operator-staged dumps.
            </Text>
          </div>
          <Button
            variant='default'
            leftSection={<FontAwesomeIcon icon={faRotateRight} />}
            loading={artifactsQuery.isFetching || uploadsQuery.isFetching}
            onClick={() => void refresh()}
          >
            Refresh
          </Button>
        </Group>

        <Stack px='lg' pb='lg'>
          <SegmentedControl
            fullWidth
            value={kind}
            onChange={(value) => setKind(value as FileKind)}
            data={[
              { value: 'exports', label: `Exports (${artifacts.length})` },
              { value: 'uploads', label: `Import uploads (${uploads.length})` },
            ]}
          />
          {kind === 'exports' && database.stream_exports_only && (
            <Alert color='yellow' title='One-use exports are shown in Transfer history'>
              Completed exports on this host are temporary and intentionally absent from the retained Files inventory.
              Download or delete them from their completed job before their one-hour expiry. An interrupted download may
              not be retryable.
            </Alert>
          )}
          {kind === 'uploads' && (uploadContractDisabled || uploadsQuery.data?.available === false) && (
            <Alert color='yellow' title='Uploaded dumps are not available for this host'>
              {uploadsQuery.data?.reason ??
                'This host did not accept the temporary-upload contract during this browser session. Existing exports remain available.'}
            </Alert>
          )}
          <TextInput label='Search files' value={search} onChange={(event) => setSearch(event.currentTarget.value)} />
          {error && <Alert color='red'>{httpErrorToHuman(error)}</Alert>}
        </Stack>

        <MantineTable.ScrollContainer minWidth={760} type='native'>
          <MantineTable striped highlightOnHover>
            <MantineTable.Thead>
              <MantineTable.Tr>
                <MantineTable.Th>File</MantineTable.Th>
                <MantineTable.Th>Source</MantineTable.Th>
                <MantineTable.Th>Size</MantineTable.Th>
                <MantineTable.Th>Modified</MantineTable.Th>
                <MantineTable.Th>Checksum</MantineTable.Th>
                <MantineTable.Th />
              </MantineTable.Tr>
            </MantineTable.Thead>
            <MantineTable.Tbody>
              {!loading && visible.length ? (
                visible.map((file) => (
                  <MantineTable.Tr key={file.id}>
                    <MantineTable.Td>
                      <Text fw={600}>{file.label}</Text>
                      {file.label !== file.id && (
                        <Text c='dimmed' size='xs'>
                          {file.id}
                        </Text>
                      )}
                    </MantineTable.Td>
                    <MantineTable.Td>
                      <Badge color={kind === 'exports' ? 'blue' : 'grape'}>{file.source}</Badge>
                    </MantineTable.Td>
                    <MantineTable.Td>{formatBytes(file.size)}</MantineTable.Td>
                    <MantineTable.Td>{formatTimestamp(file.modified)}</MantineTable.Td>
                    <MantineTable.Td>
                      <Text ff='monospace' size='xs' lineClamp={1} maw={180}>
                        {file.sha256 || '—'}
                      </Text>
                    </MantineTable.Td>
                    <MantineTable.Td>
                      <Group gap='xs' justify='flex-end' wrap='nowrap'>
                        <ServerCan action='databases-everywhere.import'>
                          <Button
                            size='compact-xs'
                            variant='light'
                            leftSection={<FontAwesomeIcon icon={faFileImport} />}
                            disabled={file.state !== 'ready'}
                            onClick={() => onImport(file.id, file.importKind)}
                          >
                            Import
                          </Button>
                        </ServerCan>
                        {kind === 'exports' && (
                          <ServerCan action='databases-everywhere.download'>
                            <Button
                              size='compact-xs'
                              variant='default'
                              leftSection={<FontAwesomeIcon icon={faDownload} />}
                              onClick={() => {
                                startBrowserDownload(downloadUrl(server, database.uuid, 'artifacts', file.id));
                                window.setTimeout(() => {
                                  void Promise.allSettled([
                                    artifactsQuery.refetch(),
                                    queryClient.invalidateQueries({
                                      queryKey: ['dbev', server, database.uuid, 'transfer-jobs'],
                                    }),
                                  ]);
                                }, 1_500);
                              }}
                            >
                              Download
                            </Button>
                          </ServerCan>
                        )}
                        <ServerCan
                          action={kind === 'exports' ? 'databases-everywhere.export' : 'databases-everywhere.import'}
                        >
                          <Button
                            size='compact-xs'
                            variant='subtle'
                            color='red'
                            leftSection={<FontAwesomeIcon icon={faTrash} />}
                            disabled={
                              file.importKind === 'upload' &&
                              !['uploading', 'uploaded', 'processing', 'ready', 'failed'].includes(file.state)
                            }
                            onClick={() =>
                              setDeleteTarget({
                                kind,
                                id: file.id,
                                label: file.label,
                                sourceKind: file.importKind,
                              })
                            }
                          >
                            Delete
                          </Button>
                        </ServerCan>
                      </Group>
                    </MantineTable.Td>
                  </MantineTable.Tr>
                ))
              ) : (
                <MantineTable.Tr>
                  <MantineTable.Td colSpan={6}>
                    <Text ta='center' c='dimmed' py='xl'>
                      {loading ? 'Loading files…' : 'No files match this view.'}
                    </Text>
                  </MantineTable.Td>
                </MantineTable.Tr>
              )}
            </MantineTable.Tbody>
          </MantineTable>
        </MantineTable.ScrollContainer>

        <Pagination
          data={{ total: files.length, perPage: PER_PAGE, page, data: visible }}
          onPageSelect={setPage}
          withShortcuts={false}
          p='md'
        />
      </Card>

      {!database.stream_exports_only && (
        <Card>
          <Group justify='space-between' align='flex-end'>
            <div>
              <Title order={4}>Export retention</Title>
              <Text c='dimmed' size='sm'>
                Ask DBEV to remove old completed export artifacts from this database.
              </Text>
            </div>
            <Group align='flex-end'>
              <NumberInput label='Keep latest' value={keepLatest} onChange={setKeepLatest} min={0} />
              <NumberInput label='Maximum age (days)' value={maxAgeDays} onChange={setMaxAgeDays} min={0} />
              <ServerCan action='databases-everywhere.export'>
                <Button
                  loading={savingRetention}
                  onClick={async () => {
                    setSavingRetention(true);
                    try {
                      await applyArtifactRetention(server, database.uuid, numeric(keepLatest), numeric(maxAgeDays));
                      await artifactsQuery.refetch();
                      addToast('Export retention applied.', 'success');
                    } catch (cause) {
                      addToast(httpErrorToHuman(cause), 'error');
                    } finally {
                      setSavingRetention(false);
                    }
                  }}
                >
                  Apply retention
                </Button>
              </ServerCan>
            </Group>
          </Group>
        </Card>
      )}

      <ConfirmationModal
        opened={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title='Delete transfer file'
        confirm='Delete file'
        onConfirmed={remove}
      >
        <Text>
          Delete <strong>{deleteTarget?.label}</strong>? This cannot be undone. Active imports keep their source file
          locked until the job finishes.
        </Text>
      </ConfirmationModal>
    </Stack>
  );
}

function numeric(value: number | string): number | undefined {
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}
