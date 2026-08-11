import { faDownload, faRotate, faRotateRight, faTrash } from '@fortawesome/free-solid-svg-icons';
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
import Select from '@/elements/input/Select.tsx';
import TextInput from '@/elements/input/TextInput.tsx';
import ConfirmationModal from '@/elements/modals/ConfirmationModal.tsx';
import { Pagination } from '@/elements/Table.tsx';
import { useToast } from '@/providers/ToastProvider.tsx';
import { deleteArtifact, downloadUrl, getArtifacts, getTransferJobs, retryTransferJob } from '../../api/client.ts';
import type { ArtifactRecord, DatabaseRecord, TransferJob } from '../../api/types.ts';
import { formatBytes, formatTimestamp, recordId, recordsFromResult, StatusBadge } from '../../components/common.tsx';
import { useImportExportEvents } from '../useDatabaseWebSockets.ts';
import {
  artifactAvailability,
  isArtifactGone,
  markOneUseArtifactDownloaded,
  oneUseArtifactExpired,
  oneUseArtifactWasDownloaded,
  startBrowserDownload,
} from './artifactDownloads.ts';
import { transferDiagnostic } from './transferUtils.ts';

const PER_PAGE = 12;

export default function TransferHistory({ server, database }: { server: string; database: DatabaseRecord }) {
  const { addToast } = useToast();
  const queryClient = useQueryClient();
  const live = useImportExportEvents(server, database.uuid);
  const fallback = useQuery({
    queryKey: ['dbev', server, database.uuid, 'transfer-jobs'],
    queryFn: () => getTransferJobs(server, database.uuid),
    staleTime: 15_000,
    refetchInterval: live.state === 'connected' ? false : 10_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
  });
  const artifactsQuery = useQuery({
    queryKey: ['dbev', server, database.uuid, 'artifacts'],
    queryFn: () => getArtifacts(server, database.uuid),
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search.trim().toLowerCase());
  const [page, setPage] = useState(1);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [unavailableArtifactIds, setUnavailableArtifactIds] = useState<Set<string>>(() => new Set());
  const jobs = recordsFromResult(live.state === 'connected' && live.jobs ? live.jobs : (fallback.data ?? live.jobs), [
    'jobs',
    'items',
    'data',
  ]) as TransferJob[];
  const artifacts = recordsFromResult(artifactsQuery.data, ['artifacts', 'items', 'data']) as ArtifactRecord[];
  const completedRevision = useMemo(
    () =>
      jobs
        .filter((job) => job.status === 'succeeded' && job.action === 'export')
        .map((job) => `${job.job_id}:${job.updated_at ?? ''}`)
        .sort()
        .join('|'),
    [jobs],
  );
  const terminalRevision = useMemo(
    () =>
      jobs
        .filter((job) => job.status === 'succeeded' || job.status === 'failed')
        .map((job) => `${job.job_id}:${job.status}:${job.updated_at ?? ''}`)
        .sort()
        .join('|'),
    [jobs],
  );
  const filtered = useMemo(
    () =>
      jobs.filter((job) => {
        if (filter !== 'all' && job.status !== filter) return false;
        if (!deferredSearch) return true;
        return [job.job_id, job.action, job.status, job.artifact_id, transferDiagnostic(job.error)]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(deferredSearch));
      }),
    [deferredSearch, filter, jobs],
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const visible = filtered.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  useEffect(() => setPage(1), [deferredSearch, filter]);
  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);
  useEffect(() => {
    if (!completedRevision) return;
    void queryClient.invalidateQueries({ queryKey: ['dbev', server, database.uuid, 'artifacts'] });
  }, [completedRevision, database.uuid, queryClient, server]);
  useEffect(() => {
    if (!terminalRevision) return;
    void queryClient.invalidateQueries({ queryKey: ['dbev', server, database.uuid, 'staged-uploads'] });
  }, [database.uuid, queryClient, server, terminalRevision]);

  const refresh = async () => {
    try {
      await Promise.all([fallback.refetch(), artifactsQuery.refetch()]);
    } catch (error) {
      addToast(httpErrorToHuman(error), 'error');
    }
  };

  const markUnavailable = (artifact: string) => {
    setUnavailableArtifactIds((current) => new Set(current).add(artifact));
  };

  const removeArtifact = async () => {
    if (!deleteTarget) return;
    try {
      await deleteArtifact(server, database.uuid, deleteTarget);
      markUnavailable(deleteTarget);
      addToast('Export deleted.', 'success');
    } catch (error) {
      if (isArtifactGone(error)) {
        markUnavailable(deleteTarget);
        addToast('This export is already no longer available.', 'success');
      } else {
        throw error;
      }
    } finally {
      setDeleteTarget(null);
      await Promise.allSettled([fallback.refetch(), artifactsQuery.refetch()]);
    }
  };

  return (
    <Card p={0}>
      <Stack gap={0}>
        <Group justify='space-between' align='flex-start' p='lg'>
          <div>
            <Group gap='xs'>
              <Title order={3}>Transfer history</Title>
              <Badge color={live.state === 'connected' ? 'green' : live.state === 'reconnecting' ? 'yellow' : 'gray'}>
                {live.state === 'connected' ? 'Live' : live.state}
              </Badge>
            </Group>
            <Text c='dimmed' size='sm'>
              Imports and exports update here as DBEV runs them in the background.
            </Text>
          </div>
          <Button
            variant='default'
            leftSection={<FontAwesomeIcon icon={faRotateRight} />}
            loading={fallback.isFetching}
            onClick={() => void refresh()}
          >
            Refresh
          </Button>
        </Group>

        {(live.error || fallback.error) && (
          <Alert color='yellow' mx='lg' mb='md'>
            {live.error || httpErrorToHuman(fallback.error)}
          </Alert>
        )}

        {database.stream_exports_only && (
          <Alert color='yellow' mx='lg' mb='md' title='One-use export downloads'>
            Completed exports use a private temporary spool until downloaded, disconnected, manually deleted, or their
            one-hour expiry. An interrupted download may not be retryable; create another export if the file is no
            longer available. Up to {database.max_artifacts_per_instance} retained artifacts plus pending one-use
            exports may exist for this database.
          </Alert>
        )}

        <Group p='lg' pt={0} grow align='flex-end'>
          <TextInput label='Search jobs' value={search} onChange={(event) => setSearch(event.currentTarget.value)} />
          <Select
            label='Status'
            value={filter}
            onChange={(value) => value && setFilter(value)}
            data={[
              { value: 'all', label: 'All statuses' },
              { value: 'queued', label: 'Queued' },
              { value: 'running', label: 'Running' },
              { value: 'succeeded', label: 'Succeeded' },
              { value: 'failed', label: 'Failed' },
            ]}
          />
        </Group>

        <MantineTable.ScrollContainer minWidth={850} type='native'>
          <MantineTable striped highlightOnHover>
            <MantineTable.Thead>
              <MantineTable.Tr>
                <MantineTable.Th>Operation</MantineTable.Th>
                <MantineTable.Th>Status</MantineTable.Th>
                <MantineTable.Th>File</MantineTable.Th>
                <MantineTable.Th>Size</MantineTable.Th>
                <MantineTable.Th>Updated</MantineTable.Th>
                <MantineTable.Th>Error</MantineTable.Th>
                <MantineTable.Th />
              </MantineTable.Tr>
            </MantineTable.Thead>
            <MantineTable.Tbody>
              {visible.length ? (
                visible.map((job) => {
                  const id = recordId(job, ['job_id', 'id']);
                  const status = String(job.status || 'unknown');
                  const diagnostic = transferDiagnostic(job.error);
                  const artifactId = job.artifact_id || null;
                  const knownUnavailable = Boolean(
                    artifactId &&
                      (unavailableArtifactIds.has(artifactId) ||
                        oneUseArtifactWasDownloaded(server, database.uuid, artifactId) ||
                        (database.stream_exports_only &&
                          status === 'succeeded' &&
                          oneUseArtifactExpired(job.updated_at || job.created_at))),
                  );
                  const availability = artifactId
                    ? !database.stream_exports_only &&
                      !knownUnavailable &&
                      (artifactsQuery.isPending || artifactsQuery.isError)
                      ? 'retained'
                      : artifactAvailability(artifactId, artifacts, database.stream_exports_only, knownUnavailable)
                    : null;
                  return (
                    <MantineTable.Tr key={id}>
                      <MantineTable.Td>
                        <Text fw={600} tt='capitalize'>
                          {String(job.action || 'transfer')}
                        </Text>
                        <Text c='dimmed' size='xs'>
                          {id}
                        </Text>
                      </MantineTable.Td>
                      <MantineTable.Td>
                        <StatusBadge status={status} />
                      </MantineTable.Td>
                      <MantineTable.Td>
                        {artifactId ? (
                          <Stack gap={2}>
                            <Text size='sm'>{artifactId}</Text>
                            {availability === 'one-use' && (
                              <Text size='xs' c='yellow'>
                                One-use download
                              </Text>
                            )}
                            {availability === 'unavailable' && (
                              <Text size='xs' c='dimmed'>
                                Downloaded / no longer available
                              </Text>
                            )}
                          </Stack>
                        ) : (
                          '—'
                        )}
                      </MantineTable.Td>
                      <MantineTable.Td>{formatBytes(job.artifact_size_bytes)}</MantineTable.Td>
                      <MantineTable.Td>{formatTimestamp(job.updated_at || job.created_at)}</MantineTable.Td>
                      <MantineTable.Td maw={320}>
                        <Text size='sm' c={diagnostic ? 'red' : 'dimmed'} lineClamp={2}>
                          {diagnostic || '—'}
                        </Text>
                      </MantineTable.Td>
                      <MantineTable.Td>
                        <Group gap='xs' justify='flex-end' wrap='nowrap'>
                          {status === 'succeeded' &&
                            job.action === 'export' &&
                            artifactId &&
                            availability !== 'unavailable' && (
                              <ServerCan action='databases-everywhere.download'>
                                <Button
                                  size='compact-xs'
                                  variant='default'
                                  leftSection={<FontAwesomeIcon icon={faDownload} />}
                                  onClick={() => {
                                    startBrowserDownload(downloadUrl(server, database.uuid, 'artifacts', artifactId));
                                    if (availability === 'one-use') {
                                      markOneUseArtifactDownloaded(server, database.uuid, artifactId);
                                      markUnavailable(artifactId);
                                    }
                                    window.setTimeout(() => {
                                      void Promise.allSettled([fallback.refetch(), artifactsQuery.refetch()]);
                                    }, 1_500);
                                  }}
                                >
                                  Download
                                </Button>
                              </ServerCan>
                            )}
                          {job.action === 'export' && artifactId && availability !== 'unavailable' && (
                            <ServerCan action='databases-everywhere.export'>
                              <Button
                                size='compact-xs'
                                variant='subtle'
                                color='red'
                                leftSection={<FontAwesomeIcon icon={faTrash} />}
                                onClick={() => setDeleteTarget(artifactId)}
                              >
                                Delete
                              </Button>
                            </ServerCan>
                          )}
                          {status === 'failed' && (
                            <ServerCan action='databases-everywhere.import'>
                              <Button
                                size='compact-xs'
                                variant='light'
                                loading={retrying === id}
                                leftSection={<FontAwesomeIcon icon={faRotate} />}
                                onClick={async () => {
                                  setRetrying(id);
                                  try {
                                    await retryTransferJob(server, database.uuid, id);
                                    addToast('Transfer retry queued.', 'success');
                                  } catch (error) {
                                    addToast(httpErrorToHuman(error), 'error');
                                  } finally {
                                    setRetrying(null);
                                  }
                                }}
                              >
                                Retry
                              </Button>
                            </ServerCan>
                          )}
                        </Group>
                      </MantineTable.Td>
                    </MantineTable.Tr>
                  );
                })
              ) : (
                <MantineTable.Tr>
                  <MantineTable.Td colSpan={7}>
                    <Text ta='center' c='dimmed' py='xl'>
                      No transfer jobs match this view.
                    </Text>
                  </MantineTable.Td>
                </MantineTable.Tr>
              )}
            </MantineTable.Tbody>
          </MantineTable>
        </MantineTable.ScrollContainer>

        <Pagination
          data={{ total: filtered.length, perPage: PER_PAGE, page, data: visible }}
          onPageSelect={setPage}
          withShortcuts={false}
          p='md'
        />
      </Stack>
      <ConfirmationModal
        opened={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title='Delete export'
        confirm='Delete export'
        onConfirmed={removeArtifact}
      >
        <Text>
          Delete <strong>{deleteTarget}</strong>? Pending one-use exports can also be cancelled this way. This cannot be
          undone.
        </Text>
      </ConfirmationModal>
    </Card>
  );
}
