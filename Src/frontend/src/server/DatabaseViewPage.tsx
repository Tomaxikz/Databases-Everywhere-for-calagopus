import {
  faArrowLeft,
  faArrowsRotate,
  faEllipsisVertical,
  faKey,
  faLock,
  faTrash,
} from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Group, Menu } from '@mantine/core';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { httpErrorToHuman } from '@/api/axios.ts';
import ActionIcon from '@/elements/ActionIcon.tsx';
import Alert from '@/elements/Alert.tsx';
import Button from '@/elements/Button.tsx';
import ServerContentContainer from '@/elements/containers/ServerContentContainer.tsx';
import Spinner from '@/elements/Spinner.tsx';
import { useServerCan } from '@/plugins/usePermissions.ts';
import { useToast } from '@/providers/ToastProvider.tsx';
import { useServerStore } from '@/stores/server.ts';
import { reconcileDatabase } from '../api/client.ts';
import { dbevMutationFailure } from '../api/mutationErrors.ts';
import translations from '../translations.ts';
import DatabaseWorkspace from './DatabaseWorkspace.tsx';
import { databaseActionPolicy } from './databaseActionPolicy.ts';
import { serverHasDatabasesEverywhere, useDatabasesEverywhere } from './databaseQuery.ts';
import DatabaseCredentialsModal from './modals/DatabaseCredentialsModal.tsx';
import DatabaseDeleteModal from './modals/DatabaseDeleteModal.tsx';
import ResetDatabasePasswordModal from './modals/ResetDatabasePasswordModal.tsx';

export default function DatabaseViewPage() {
  const { t } = translations.useTranslations();
  const { addToast } = useToast();
  const { database: databaseUuid } = useParams<{ database: string }>();
  const navigate = useNavigate();
  const server = useServerStore((state) => state.server);
  const canRead = useServerCan('databases-everywhere.read');
  const canCredentials = useServerCan('databases-everywhere.credentials');
  const canUpdate = useServerCan('databases-everywhere.update');
  const canDelete = useServerCan('databases-everywhere.delete');
  const [openModal, setOpenModal] = useState<'credentials' | 'delete' | 'password' | null>(null);
  const [credentialDatabase, setCredentialDatabase] = useState<typeof database>(undefined);
  const enabled = serverHasDatabasesEverywhere(server);
  const query = useDatabasesEverywhere(server.uuid, canRead && enabled);
  const database = query.data?.databases.find((item) => item.uuid === databaseUuid);
  const listPath = `/server/${server.uuidShort}/databases`;

  useEffect(() => {
    if (!enabled || (query.data && !database)) {
      navigate(listPath, { replace: true });
    }
  }, [database, enabled, listPath, navigate, query.data]);

  if (!enabled || !query.data || !database) {
    return (
      <ServerContentContainer title={t('server.title', {})} hideTitleComponent>
        {query.error ? <Alert color='red'>{httpErrorToHuman(query.error)}</Alert> : <Spinner.Centered />}
      </ServerContentContainer>
    );
  }

  const onDeleted = () => {
    navigate(listPath, { replace: true });
    void query.refetch();
  };
  const policy = databaseActionPolicy(database.status);

  return (
    <>
      <DatabaseCredentialsModal
        database={credentialDatabase ?? database}
        opened={openModal === 'credentials'}
        onClose={() => {
          setCredentialDatabase(undefined);
          setOpenModal(null);
        }}
      />
      <ResetDatabasePasswordModal
        server={server.uuid}
        database={database}
        opened={openModal === 'password'}
        onClose={() => setOpenModal(null)}
        onRefresh={() => query.refetch()}
        onReset={(refreshed) => {
          setCredentialDatabase(refreshed);
          setOpenModal('credentials');
          void query.refetch();
        }}
      />
      <DatabaseDeleteModal
        server={server.uuid}
        database={database}
        opened={openModal === 'delete'}
        onClose={() => setOpenModal(null)}
        onDeleted={onDeleted}
      />
      <ServerContentContainer
        title={database.display_name}
        subtitle={database.protocol_label}
        contentRight={
          <Group gap='xs'>
            <Menu position='bottom-end' width={260} shadow='md'>
              <Menu.Target>
                <ActionIcon variant='default' size='input-sm' aria-label='Database actions'>
                  <FontAwesomeIcon icon={faEllipsisVertical} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                {canCredentials && (
                  <Menu.Item leftSection={<FontAwesomeIcon icon={faKey} />} onClick={() => setOpenModal('credentials')}>
                    {t('server.credentials', {})}
                  </Menu.Item>
                )}
                {canUpdate && (
                  <Menu.Item
                    disabled={!policy.reconcile}
                    leftSection={<FontAwesomeIcon icon={faArrowsRotate} />}
                    onClick={async () => {
                      try {
                        await reconcileDatabase(server.uuid, database.uuid);
                        addToast(t('server.operationQueued', {}), 'success');
                        await query.refetch();
                      } catch (error) {
                        const failure = dbevMutationFailure(error, httpErrorToHuman(error));
                        addToast(
                          failure.retryable
                            ? `${failure.message} ${t('server.checkStateBeforeRetry', {})}.`
                            : failure.message,
                          'error',
                        );
                      }
                    }}
                  >
                    {t('server.reconcile', {})}
                  </Menu.Item>
                )}
                {canUpdate && canCredentials && (
                  <Menu.Item
                    disabled={!policy.resetCredential}
                    leftSection={<FontAwesomeIcon icon={faLock} />}
                    onClick={() => setOpenModal('password')}
                  >
                    {database.protocol === 'qdrant' ? t('server.resetApiKey', {}) : t('server.resetPassword', {})}
                  </Menu.Item>
                )}
                {canDelete && <Menu.Divider />}
                {canDelete && (
                  <Menu.Item
                    color='red'
                    leftSection={<FontAwesomeIcon icon={faTrash} />}
                    onClick={() => setOpenModal('delete')}
                  >
                    {t('common.delete', {})}
                  </Menu.Item>
                )}
              </Menu.Dropdown>
            </Menu>
            <Button
              variant='default'
              leftSection={<FontAwesomeIcon icon={faArrowLeft} />}
              onClick={() => navigate(listPath)}
            >
              {t('server.backToDatabases', {})}
            </Button>
          </Group>
        }
      >
        <DatabaseWorkspace
          server={server.uuid}
          database={database}
          onChanged={() => query.refetch()}
          onDeleted={onDeleted}
        />
      </ServerContentContainer>
    </>
  );
}
