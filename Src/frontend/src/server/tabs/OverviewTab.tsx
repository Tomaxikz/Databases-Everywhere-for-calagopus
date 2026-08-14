import { faArrowsRotate, faBolt, faSkull, faStop } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Group, Stack, Text } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { httpErrorToHuman } from '@/api/axios.ts';
import Alert from '@/elements/Alert.tsx';
import Badge from '@/elements/Badge.tsx';
import Button from '@/elements/Button.tsx';
import { ServerCan } from '@/elements/Can.tsx';
import { useServerCan } from '@/plugins/usePermissions.ts';
import { useToast } from '@/providers/ToastProvider.tsx';
import { getDatabaseStatus, powerDatabase } from '../../api/client.ts';
import { type DbevMutationFailure, dbevMutationFailure } from '../../api/mutationErrors.ts';
import type { DatabaseInstallProgress, DatabaseList, DatabasePowerAction, DatabaseRecord } from '../../api/types.ts';
import { StatusBadge } from '../../components/common.tsx';
import translations from '../../translations.ts';
import DatabaseLiveLogs from '../components/DatabaseLiveLogs.tsx';
import DatabaseLiveStats from '../components/DatabaseLiveStats.tsx';
import DiskRestartBlockedAlert from '../components/DiskRestartBlockedAlert.tsx';
import MutationFailureAlert from '../components/MutationFailureAlert.tsx';
import { databaseActionPolicy } from '../databaseActionPolicy.ts';
import { databasesEverywhereQueryKey } from '../databaseQuery.ts';
import { isDatabaseProgressActive } from '../installProgress.ts';
import { useDatabaseLiveOverview } from '../useDatabaseWebSockets.ts';

interface Props {
  server: string;
  database: DatabaseRecord;
  onChanged: () => void;
  onDeleted: () => void;
}

export default function OverviewTab({ server, database, onChanged }: Props) {
  const { t } = translations.useTranslations();
  const { addToast } = useToast();
  const queryClient = useQueryClient();
  const canReadLogs = useServerCan('databases-everywhere.logs');
  const [action, setAction] = useState<string | null>(null);
  const [failure, setFailure] = useState<DbevMutationFailure | null>(null);
  const [checkingState, setCheckingState] = useState(false);
  const synchronizeStatus = useCallback(
    (status: string) => {
      queryClient.setQueryData<DatabaseList>(databasesEverywhereQueryKey(server), (current) => {
        if (!current) return current;
        const index = current.databases.findIndex((item) => item.uuid === database.uuid);
        if (index < 0 || current.databases[index].status === status) return current;
        const databases = [...current.databases];
        databases[index] = { ...databases[index], status };
        return { ...current, databases };
      });

      if (['running', 'stopped', 'failed', 'quarantined'].includes(status) && status !== database.status) {
        void getDatabaseStatus(server, database.uuid).catch(() => undefined);
      }
    },
    [database.status, database.uuid, queryClient, server],
  );
  const live = useDatabaseLiveOverview({
    server,
    database: database.uuid,
    logsEnabled: canReadLogs,
    onStatusChange: synchronizeStatus,
  });

  const run = async (name: string, operation: () => Promise<unknown>, success = t('server.operationQueued', {})) => {
    setAction(name);
    setFailure(null);
    try {
      await operation();
      addToast(success, 'success');
      onChanged();
    } catch (error) {
      const nextFailure = dbevMutationFailure(error, httpErrorToHuman(error));
      setFailure(nextFailure);
      if (!nextFailure.retryable) addToast(nextFailure.message, 'error');
    } finally {
      setAction(null);
    }
  };

  const runPower = (power: DatabasePowerAction) =>
    run(power, async () => {
      const result = await powerDatabase(server, database.uuid, power);
      if (power === 'start' || power === 'restart') live.reconnectLogs();
      return result;
    });
  const status = live.instance?.status || database.status;
  const disk = live.instance?.resources?.disk;
  const scannerRestartBlocked = disk?.scanner_restart_blocked === true;
  const policy = databaseActionPolicy(status, { scannerRestartBlocked });
  const persistedProgress = database.metadata.creation_progress ?? database.metadata.progress;
  const storedProgress =
    persistedProgress && typeof persistedProgress === 'object' ? (persistedProgress as DatabaseInstallProgress) : null;
  const progress = live.progress ?? storedProgress;
  const activeProgress = progress && isDatabaseProgressActive(progress, status) ? progress : null;

  return (
    <Stack mt='md'>
      <MutationFailureAlert
        failure={failure}
        checking={checkingState}
        onCheck={() => {
          setCheckingState(true);
          void getDatabaseStatus(server, database.uuid)
            .then((current) => {
              if (current.status) synchronizeStatus(current.status);
              setFailure(null);
              onChanged();
              addToast(t('server.databaseStateRefreshed', {}), 'success');
            })
            .catch((error) => setFailure(dbevMutationFailure(error, httpErrorToHuman(error))))
            .finally(() => setCheckingState(false));
        }}
      />
      {database.last_error && (
        <Alert color='red' title='Last synchronization error'>
          {database.last_error}
        </Alert>
      )}
      {live.monitoring.error && (
        <Alert color='yellow' title='Live metrics are reconnecting'>
          {live.monitoring.error}
        </Alert>
      )}
      {live.monitoring.state === 'reconnecting' && !live.monitoring.error && (
        <Alert color='blue'>{t('server.agentReconnecting', {})}</Alert>
      )}
      {status === 'quarantined' && (
        <Alert color='red' title={t('server.quarantinedTitle', {})}>
          {t('server.quarantinedDescription', {})}
        </Alert>
      )}
      <DiskRestartBlockedAlert disk={disk} />
      {activeProgress && (
        <Alert
          color={activeProgress.status === 'failed' ? 'red' : 'blue'}
          title={activeProgress.action || 'Database operation'}
        >
          {activeProgress.diagnostic?.message ||
            activeProgress.message ||
            activeProgress.stage ||
            activeProgress.status}
          {typeof activeProgress.percent === 'number' ? ` · ${activeProgress.percent.toFixed(0)}%` : ''}
        </Alert>
      )}

      <Group justify='space-between'>
        <Stack gap={4}>
          <Group gap='sm'>
            <StatusBadge status={status} />
            <Badge color={live.monitoring.state === 'connected' ? 'green' : 'yellow'}>
              Live metrics {live.monitoring.state}
            </Badge>
            {database.limits_sync_pending && <Badge color='blue'>{t('server.pendingLimits', {})}</Badge>}
          </Group>
          <Text size='xs' c='dimmed'>
            {t('server.maximumResources', {
              cpu: database.limits.cpu_cores,
              memory: database.limits.memory_mib,
              disk: database.limits.disk_mib,
            })}
          </Text>
        </Stack>
        <ServerCan action='databases-everywhere.power'>
          <Group gap='xs'>
            <Button
              size='xs'
              loading={action === 'start'}
              disabled={action !== null || !policy.start}
              onClick={() => runPower('start')}
              leftSection={<FontAwesomeIcon icon={faBolt} />}
            >
              {t('server.start', {})}
            </Button>
            <Button
              size='xs'
              variant='default'
              loading={action === 'stop'}
              disabled={action !== null || !policy.stop}
              onClick={() => runPower('stop')}
              leftSection={<FontAwesomeIcon icon={faStop} />}
            >
              {t('server.stop', {})}
            </Button>
            <Button
              size='xs'
              variant='default'
              loading={action === 'restart'}
              disabled={action !== null || !policy.restart}
              onClick={() => runPower('restart')}
              leftSection={<FontAwesomeIcon icon={faArrowsRotate} />}
            >
              {t('server.restart', {})}
            </Button>
            <Button
              size='xs'
              color='red'
              variant='light'
              loading={action === 'kill'}
              disabled={action !== null || !policy.kill}
              onClick={() => runPower('kill')}
              leftSection={<FontAwesomeIcon icon={faSkull} />}
            >
              {t('server.kill', {})}
            </Button>
          </Group>
        </ServerCan>
      </Group>

      <DatabaseLiveStats instance={live.instance} samples={live.samples} limits={database.limits} />

      {canReadLogs && <DatabaseLiveLogs lines={live.logs} state={live.logStream.state} error={live.logStream.error} />}
    </Stack>
  );
}
