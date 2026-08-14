import { faDownload, faEye, faPlus, faRotateLeft, faSearch, faTrash } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Group, Stack, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { httpErrorToHuman } from '@/api/axios.ts';
import Alert from '@/elements/Alert.tsx';
import Button from '@/elements/Button.tsx';
import { ServerCan } from '@/elements/Can.tsx';
import Code from '@/elements/Code.tsx';
import ConditionalTooltip from '@/elements/ConditionalTooltip.tsx';
import ContextMenu, { ContextMenuToggle } from '@/elements/ContextMenu.tsx';
import Select from '@/elements/input/Select.tsx';
import TextInput from '@/elements/input/TextInput.tsx';
import ConfirmationModal from '@/elements/modals/ConfirmationModal.tsx';
import { Modal, ModalFooter } from '@/elements/modals/Modal.tsx';
import Spinner from '@/elements/Spinner.tsx';
import Table, { TableData, TableRow } from '@/elements/Table.tsx';
import FormattedTimestamp from '@/elements/time/FormattedTimestamp.tsx';
import { useServerCan } from '@/plugins/usePermissions.ts';
import { useToast } from '@/providers/ToastProvider.tsx';
import {
  createBackup,
  deleteBackup,
  downloadUrl,
  getBackupContents,
  getBackups,
  restoreBackup,
} from '../../api/client.ts';
import { dbevQueryKeys } from '../../api/queryKeys.ts';
import type { DatabaseBackupRecord, DatabaseRecord } from '../../api/types.ts';
import { formatBytes, isRecord, JsonView } from '../../components/common.tsx';
import translations from '../../translations.ts';

const PER_PAGE = 10;

export default function BackupsTab({ server, database }: { server: string; database: DatabaseRecord }) {
  const { t } = translations.useTranslations();
  const { addToast } = useToast();
  const [action, setAction] = useState<'create' | 'restore' | 'delete' | null>(null);
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search.trim().toLowerCase());
  const [page, setPage] = useState(1);
  const [selectedBackup, setSelectedBackup] = useState<string | null>(null);
  const [selectedObject, setSelectedObject] = useState<string | null>(null);
  const [restoreId, setRestoreId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const canDownload = useServerCan('databases-everywhere.download');
  const canRestore = useServerCan('databases-everywhere.backup-restore');
  const canDelete = useServerCan('databases-everywhere.backup-delete');
  const mutationBlocked = !database.mutations_allowed;

  const backupsQuery = useQuery({
    queryKey: dbevQueryKeys.databaseBackups(server, database.uuid),
    queryFn: () => getBackups(server, database.uuid),
    staleTime: 15_000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  });
  const contentsQuery = useQuery({
    queryKey: dbevQueryKeys.databaseBackupContents(server, database.uuid, selectedBackup, selectedObject),
    queryFn: () => getBackupContents(server, database.uuid, selectedBackup!, selectedObject || undefined),
    enabled: Boolean(selectedBackup),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const backups = backupsQuery.data?.backups ?? [];
  const backupLimit = backupsQuery.data?.backup_limit ?? 0;
  const backupUsage = backupsQuery.data?.backup_usage ?? 0;
  const atBackupLimit = backupLimit <= 0 || backupUsage >= backupLimit;
  const filteredBackups = useMemo(() => {
    if (!deferredSearch) return backups;
    return backups.filter((backup) =>
      [backup.id, backup.sha256, backup.modified_at, backup.instance_id]
        .filter((value): value is string => typeof value === 'string')
        .some((value) => value.toLowerCase().includes(deferredSearch)),
    );
  }, [backups, deferredSearch]);
  const lastPage = Math.max(1, Math.ceil(filteredBackups.length / PER_PAGE));
  const visibleBackups = filteredBackups.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  const pagination: Pagination<DatabaseBackupRecord> = {
    total: filteredBackups.length,
    perPage: PER_PAGE,
    page,
    data: visibleBackups,
  };

  useEffect(() => setPage(1), [deferredSearch]);
  useEffect(() => {
    if (page > lastPage) setPage(lastPage);
  }, [lastPage, page]);

  const catalogObjects = useMemo(() => {
    if (!isRecord(contentsQuery.data) || !Array.isArray(contentsQuery.data.objects)) return [];
    return contentsQuery.data.objects.filter(isRecord);
  }, [contentsQuery.data]);

  const mutate = async (name: 'create' | 'restore' | 'delete', success: string, operation: () => Promise<unknown>) => {
    if (mutationBlocked) return false;
    setAction(name);
    try {
      await operation();
      addToast(success, 'success');
      void backupsQuery.refetch();
      return true;
    } catch (error) {
      addToast(httpErrorToHuman(error), 'error');
      return false;
    } finally {
      setAction(null);
    }
  };

  const closeContents = () => {
    setSelectedBackup(null);
    setSelectedObject(null);
  };

  const closeRestore = () => {
    setRestoreId(null);
    setReason('');
  };

  const doRestore = async (event: FormEvent) => {
    event.preventDefault();
    if (!restoreId || !reason.trim()) return;
    if (
      await mutate('restore', t('server.backupRestored', {}), () =>
        restoreBackup(server, database.uuid, restoreId, reason.trim()),
      )
    ) {
      closeRestore();
    }
  };

  return (
    <Stack mt='md' gap='md'>
      <Group justify='space-between' align='flex-end'>
        <div>
          <Title order={2}>{t('server.backups', {})}</Title>
          <Text size='xs' c='dimmed'>
            {t('server.backupSummary', {
              used: backupUsage,
              limit: backupLimit,
            })}
          </Text>
        </div>

        <Group gap='sm'>
          <TextInput
            placeholder={t('common.search', {})}
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            leftSection={<FontAwesomeIcon icon={faSearch} />}
            w={250}
          />
          <ServerCan action='databases-everywhere.backup-create'>
            <ConditionalTooltip
              enabled={mutationBlocked || atBackupLimit}
              label={
                mutationBlocked
                  ? database.mutation_block_reason || 'This database is in read-only compatibility mode.'
                  : t('server.backupLimitReached', {})
              }
            >
              <Button
                color='blue'
                leftSection={<FontAwesomeIcon icon={faPlus} />}
                loading={action === 'create'}
                disabled={mutationBlocked || atBackupLimit}
                onClick={() => {
                  void mutate('create', t('server.backupCreated', {}), () => createBackup(server, database.uuid));
                }}
              >
                {t('server.createBackup', {})}
              </Button>
            </ConditionalTooltip>
          </ServerCan>
        </Group>
      </Group>

      <Table
        columns={[
          t('server.backupColumn', {}),
          t('server.checksumColumn', {}),
          t('server.sizeColumn', {}),
          t('server.createdColumn', {}),
          '',
        ]}
        loading={backupsQuery.isFetching}
        error={backupsQuery.error ? httpErrorToHuman(backupsQuery.error) : null}
        pagination={pagination}
        onPageSelect={setPage}
      >
        {visibleBackups.map((backup) => (
          <ContextMenu
            key={backup.id}
            items={[
              {
                type: 'action',
                icon: faEye,
                label: t('server.browseBackup', {}),
                color: 'gray',
                onClick: () => {
                  setSelectedBackup(backup.id);
                  setSelectedObject(null);
                },
              },
              {
                type: 'action',
                icon: faDownload,
                label: t('common.download', {}),
                color: 'gray',
                canAccess: canDownload,
                disabled: mutationBlocked,
                onClick: () => window.location.assign(downloadUrl(server, database.uuid, 'backups', backup.id)),
              },
              {
                type: 'action',
                icon: faRotateLeft,
                label: t('server.restoreBackup', {}),
                color: 'gray',
                canAccess: canRestore,
                disabled: mutationBlocked,
                onClick: () => setRestoreId(backup.id),
              },
              { type: 'divider', canAccess: canDelete },
              {
                type: 'action',
                icon: faTrash,
                label: t('common.delete', {}),
                color: 'red',
                canAccess: canDelete,
                disabled: mutationBlocked,
                onClick: () => setDeleteId(backup.id),
              },
            ]}
          >
            {({ items, openMenu }) => (
              <TableRow
                onContextMenu={(event) => {
                  event.preventDefault();
                  openMenu(event.clientX, event.clientY);
                }}
              >
                <TableData>
                  <Code>{backup.id}</Code>
                </TableData>
                <TableData>{backup.sha256 ? <Code>{backup.sha256}</Code> : '—'}</TableData>
                <TableData>{formatBytes(backup.size_bytes)}</TableData>
                <TableData>
                  {backup.modified_at ? <FormattedTimestamp timestamp={backup.modified_at} /> : '—'}
                </TableData>
                <ContextMenuToggle items={items} openMenu={openMenu} />
              </TableRow>
            )}
          </ContextMenu>
        ))}
      </Table>

      <Modal opened={Boolean(selectedBackup)} onClose={closeContents} title={t('server.backupContents', {})} size='xl'>
        <Stack gap='md'>
          <Code>{selectedBackup}</Code>
          {contentsQuery.isFetching ? (
            <Spinner.Centered />
          ) : contentsQuery.error ? (
            <Alert color='red'>{httpErrorToHuman(contentsQuery.error)}</Alert>
          ) : (
            <>
              {catalogObjects.length > 0 && (
                <Select
                  searchable
                  clearable
                  label={t('server.objects', {})}
                  value={selectedObject}
                  onChange={setSelectedObject}
                  data={catalogObjects
                    .map((object) => {
                      const value = String(object.id || object.object_id || object.name || '');
                      const namespace = typeof object.namespace === 'string' ? object.namespace : '';
                      const name = String(object.name || object.id || object.object_id || '');
                      return { value, label: namespace ? `${namespace}.${name}` : name };
                    })
                    .filter((item) => item.value)}
                />
              )}
              <JsonView value={contentsQuery.data} maxHeight={560} />
            </>
          )}
        </Stack>
        <ModalFooter>
          <Button variant='default' onClick={closeContents}>
            {t('common.close', {})}
          </Button>
        </ModalFooter>
      </Modal>

      <Modal opened={Boolean(restoreId)} onClose={closeRestore} title={t('server.restoreBackup', {})}>
        <form onSubmit={doRestore}>
          <Stack gap='md'>
            <Text size='sm'>{t('server.restoreBackupDescription', {})}</Text>
            <Code>{restoreId}</Code>
            <TextInput
              label={t('server.reason', {})}
              value={reason}
              onChange={(event) => setReason(event.currentTarget.value)}
              required
            />
          </Stack>
          <ModalFooter>
            <Button
              type='submit'
              color='red'
              loading={action === 'restore'}
              disabled={mutationBlocked || !reason.trim()}
            >
              {t('server.restoreBackup', {})}
            </Button>
            <Button variant='default' onClick={closeRestore}>
              {t('common.cancel', {})}
            </Button>
          </ModalFooter>
        </form>
      </Modal>

      <ConfirmationModal
        opened={Boolean(deleteId)}
        onClose={() => setDeleteId(null)}
        title={t('server.deleteBackupTitle', {})}
        confirm={t('common.delete', {})}
        onConfirmed={async () => {
          if (!deleteId) return;
          if (
            await mutate('delete', t('server.backupDeleted', {}), () => deleteBackup(server, database.uuid, deleteId))
          ) {
            if (selectedBackup === deleteId) closeContents();
            setDeleteId(null);
          }
        }}
      >
        <Text>{t('server.deleteBackupDescription', { backup: deleteId || '' })}</Text>
      </ConfirmationModal>
    </Stack>
  );
}
