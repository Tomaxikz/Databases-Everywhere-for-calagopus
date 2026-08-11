import {
  faArrowsRotate,
  faEye,
  faKey,
  faLock,
  faPlay,
  faSkull,
  faStop,
  faTrash,
} from '@fortawesome/free-solid-svg-icons';
import { Group, Text } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { httpErrorToHuman } from '@/api/axios.ts';
import Badge from '@/elements/Badge.tsx';
import Code from '@/elements/Code.tsx';
import ContextMenu, { ContextMenuToggle } from '@/elements/ContextMenu.tsx';
import CopyOnClick from '@/elements/CopyOnClick.tsx';
import { TableData, TableRow } from '@/elements/Table.tsx';
import TableLink from '@/elements/TableLink.tsx';
import { bytesToString, mbToBytes } from '@/lib/size.ts';
import { useServerCan } from '@/plugins/usePermissions.ts';
import { useToast } from '@/providers/ToastProvider.tsx';
import { useServerStore } from '@/stores/server.ts';
import { powerDatabase, reconcileDatabase } from '../api/client.ts';
import { dbevMutationFailure } from '../api/mutationErrors.ts';
import type { DatabaseList, DatabaseRecord } from '../api/types.ts';
import { StatusBadge } from '../components/common.tsx';
import ProtocolIcon from '../components/ProtocolIcon.tsx';
import translations from '../translations.ts';
import { databaseActionPolicy } from './databaseActionPolicy.ts';
import { databasesEverywhereQueryKey } from './databaseQuery.ts';
import DatabaseCredentialsModal from './modals/DatabaseCredentialsModal.tsx';
import DatabaseDeleteModal from './modals/DatabaseDeleteModal.tsx';
import ResetDatabasePasswordModal from './modals/ResetDatabasePasswordModal.tsx';

export type DatabaseTableLayout = 'classic' | 'agent';

export default function DatabaseTableRow({
  database,
  layout,
}: {
  database: DatabaseRecord;
  layout: DatabaseTableLayout;
}) {
  const { t } = translations.useTranslations();
  const { addToast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const server = useServerStore((state) => state.server);
  const [openModal, setOpenModal] = useState<'credentials' | 'delete' | 'password' | null>(null);
  const [credentialDatabase, setCredentialDatabase] = useState<DatabaseRecord | null>(null);
  const address = `${database.public_host}:${database.public_port}`;
  const viewPath = `/server/${server.uuidShort}/databases/dbev/${database.uuid}`;
  const canRead = useServerCan('databases-everywhere.read');
  const canCredentials = useServerCan('databases-everywhere.credentials');
  const canPower = useServerCan('databases-everywhere.power');
  const canUpdate = useServerCan('databases-everywhere.update');
  const canDelete = useServerCan('databases-everywhere.delete');
  const policy = databaseActionPolicy(database.status, {
    scannerRestartBlocked: database.metadata.disk_scanner_restart_blocked === true,
  });

  const run = async (operation: () => Promise<unknown>) => {
    try {
      await operation();
      addToast(t('server.operationQueued', {}), 'success');
    } catch (error) {
      const failure = dbevMutationFailure(error, httpErrorToHuman(error));
      addToast(
        failure.retryable ? `${failure.message} ${t('server.checkStateBeforeRetry', {})}.` : failure.message,
        'error',
      );
    }
  };

  return (
    <>
      <DatabaseCredentialsModal
        database={credentialDatabase ?? database}
        opened={openModal === 'credentials'}
        onClose={() => {
          setCredentialDatabase(null);
          setOpenModal(null);
        }}
      />
      <ResetDatabasePasswordModal
        server={server.uuid}
        database={database}
        opened={openModal === 'password'}
        onClose={() => setOpenModal(null)}
        onRefresh={() => queryClient.invalidateQueries({ queryKey: databasesEverywhereQueryKey(server.uuid) })}
        onReset={(refreshed) => {
          queryClient.setQueryData<DatabaseList>(databasesEverywhereQueryKey(server.uuid), (current) =>
            current
              ? {
                  ...current,
                  databases: current.databases.map((item) => (item.uuid === refreshed.uuid ? refreshed : item)),
                }
              : current,
          );
          setCredentialDatabase(refreshed);
          setOpenModal('credentials');
        }}
      />
      <DatabaseDeleteModal
        server={server.uuid}
        database={database}
        opened={openModal === 'delete'}
        onClose={() => setOpenModal(null)}
        onDeleted={() => {
          queryClient.setQueryData<DatabaseList>(databasesEverywhereQueryKey(server.uuid), (current) =>
            current
              ? {
                  ...current,
                  database_usage: Math.max(0, current.database_usage - 1),
                  databases: current.databases.filter((item) => item.uuid !== database.uuid),
                }
              : current,
          );
        }}
      />

      <ContextMenu
        items={[
          {
            type: 'action',
            icon: faEye,
            label: 'Manage database',
            onClick: () => navigate(viewPath),
            color: 'gray',
            canAccess: canRead,
          },
          {
            type: 'action',
            icon: faKey,
            label: t('server.credentials', {}),
            onClick: () => setOpenModal('credentials'),
            color: 'gray',
            canAccess: canCredentials,
          },
          {
            type: 'action',
            icon: faPlay,
            label: 'Power',
            color: 'gray',
            canAccess: canPower,
            disabled: !policy.start && !policy.restart && !policy.stop && !policy.kill,
            items: [
              {
                type: 'action',
                icon: faPlay,
                label: t('server.start', {}),
                color: 'gray',
                disabled: !policy.start,
                onClick: () => void run(() => powerDatabase(server.uuid, database.uuid, 'start')),
              },
              {
                type: 'action',
                icon: faArrowsRotate,
                label: t('server.restart', {}),
                color: 'gray',
                disabled: !policy.restart,
                onClick: () => void run(() => powerDatabase(server.uuid, database.uuid, 'restart')),
              },
              {
                type: 'action',
                icon: faStop,
                label: t('server.stop', {}),
                color: 'gray',
                disabled: !policy.stop,
                onClick: () => void run(() => powerDatabase(server.uuid, database.uuid, 'stop')),
              },
              {
                type: 'action',
                icon: faSkull,
                label: t('server.kill', {}),
                color: 'red',
                disabled: !policy.kill,
                onClick: () => void run(() => powerDatabase(server.uuid, database.uuid, 'kill')),
              },
            ],
          },
          {
            type: 'action',
            icon: faArrowsRotate,
            label: t('server.reconcile', {}),
            onClick: () => void run(() => reconcileDatabase(server.uuid, database.uuid)),
            color: 'gray',
            canAccess: canUpdate,
            disabled: !policy.reconcile,
          },
          {
            type: 'action',
            icon: faLock,
            label: database.protocol === 'qdrant' ? t('server.resetApiKey', {}) : t('server.resetPassword', {}),
            onClick: () => setOpenModal('password'),
            color: 'gray',
            canAccess: canUpdate && canCredentials,
            disabled: !policy.resetCredential,
          },
          { type: 'divider', canAccess: canDelete },
          {
            type: 'action',
            icon: faTrash,
            label: t('common.delete', {}),
            onClick: () => setOpenModal('delete'),
            color: 'red',
            canAccess: canDelete,
          },
        ]}
      >
        {({ items, openMenu }) => (
          <TableRow
            className='cursor-pointer'
            onClick={() => navigate(viewPath)}
            onContextMenu={(event) => {
              event.preventDefault();
              openMenu(event.clientX, event.clientY);
            }}
          >
            <TableData>
              <TableLink to={viewPath}>
                <Group gap='xs' wrap='nowrap'>
                  <ProtocolIcon protocol={database.protocol} size={22} />
                  <Text fw={500}>{database.display_name}</Text>
                </Group>
              </TableLink>
            </TableData>
            <TableData>
              <Group gap='xs' wrap='nowrap'>
                <Text>{database.protocol_label}</Text>
                <Badge size='xs' variant='light' color='violet'>
                  {t('server.managedBadge', {})}
                </Badge>
              </Group>
            </TableData>
            <TableData onClick={(event) => event.stopPropagation()}>
              <CopyOnClick content={address}>
                <Code>{address}</Code>
              </CopyOnClick>
            </TableData>

            {layout === 'agent' ? (
              <>
                <TableData>{bytesToString(mbToBytes(database.limits.memory_mib))}</TableData>
                <TableData>{bytesToString(mbToBytes(database.limits.disk_mib))}</TableData>
              </>
            ) : (
              <>
                <TableData>{database.username}</TableData>
                <TableData>{bytesToString(mbToBytes(database.limits.disk_mib))}</TableData>
              </>
            )}

            <TableData>
              <div>
                <StatusBadge status={database.status} />
                {database.last_error && (
                  <Text size='xs' c='red' mt={3} lineClamp={1} title={database.last_error}>
                    {database.last_error}
                  </Text>
                )}
              </div>
            </TableData>
            <ContextMenuToggle items={items} openMenu={openMenu} />
          </TableRow>
        )}
      </ContextMenu>
    </>
  );
}
