import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useEffect, useMemo } from 'react';
import { getDatabaseStatus } from '../api/client.ts';
import { scannerRestartBlockedState } from '../api/normalizers.ts';
import type { DatabaseList, DatabaseRecord, DbevInstanceStatusResponse } from '../api/types.ts';
import { databasesEverywhereQueryKey } from './databaseQuery.ts';
import { useDatabaseMonitoringEvents } from './useDatabaseWebSockets.ts';

interface NodeDatabaseGroup {
  key: string;
  node: string;
  databases: DatabaseRecord[];
}

const MAX_DATABASES_PER_MONITOR = 128;

export default function DatabaseListLiveUpdates({
  server,
  databases,
}: {
  server: string;
  databases: DatabaseRecord[];
}) {
  const groups = useMemo(() => {
    const byNode = new Map<string, DatabaseRecord[]>();
    for (const database of databases) {
      const current = byNode.get(database.node_uuid) ?? [];
      current.push(database);
      byNode.set(database.node_uuid, current);
    }
    const result: NodeDatabaseGroup[] = [];
    for (const [node, records] of byNode) {
      for (let index = 0; index < records.length; index += MAX_DATABASES_PER_MONITOR) {
        const databases = records.slice(index, index + MAX_DATABASES_PER_MONITOR);
        result.push({ key: `${node}:${index}`, node, databases });
      }
    }
    return result;
  }, [databases]);

  return (
    <Fragment>
      {groups.map((group) => (
        <NodeDatabaseMonitor server={server} group={group} key={group.key} />
      ))}
      {databases
        .filter((database) => database.status === 'creating' || database.status === 'booting')
        .map((database) => (
          <CreationStatusPoller server={server} database={database} key={`creation:${database.uuid}`} />
        ))}
    </Fragment>
  );
}

function CreationStatusPoller({ server, database }: { server: string; database: DatabaseRecord }) {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: [...databasesEverywhereQueryKey(server), database.uuid, 'creation-status'],
    queryFn: () => getDatabaseStatus(server, database.uuid),
    refetchInterval: (query) => {
      const value = query.state.data as DbevInstanceStatusResponse | undefined;
      return !value || value.status === 'creating' || value.status === 'booting' ? 2_000 : false;
    },
    refetchIntervalInBackground: true,
    retry: 2,
  });

  useEffect(() => {
    const value = status.data;
    if (!value) return;
    const diagnostic = value.progress?.diagnostic?.message?.trim() || null;
    queryClient.setQueryData<DatabaseList>(databasesEverywhereQueryKey(server), (current) => {
      if (!current) return current;
      let changed = false;
      const databases = current.databases.map((record) => {
        if (record.uuid !== database.uuid) return record;
        changed = true;
        return {
          ...record,
          status: value.status,
          last_error: diagnostic,
          metadata: {
            ...record.metadata,
            creation_progress: value.progress ?? null,
          },
        };
      });
      return changed ? { ...current, databases } : current;
    });
  }, [database.uuid, queryClient, server, status.data]);

  return null;
}

function NodeDatabaseMonitor({ server, group }: { server: string; group: NodeDatabaseGroup }) {
  const queryClient = useQueryClient();
  const instances = group.databases.map((database) => database.uuid);

  useDatabaseMonitoringEvents({
    server,
    database: instances[0],
    instances,
    enabled: instances.length > 0,
    onReconnected: async () => {
      await Promise.allSettled(group.databases.map((database) => getDatabaseStatus(server, database.uuid)));
      await queryClient.invalidateQueries({ queryKey: databasesEverywhereQueryKey(server) });
    },
    onMessage: (message) => {
      if (message.type !== 'stats' || !message.instances?.length) return;
      const snapshots = new Map(message.instances.map((instance) => [instance.instance_id, instance]));
      const statuses = new Map(
        message.instances
          .filter((instance) => instance.status)
          .map((instance) => [instance.instance_id, instance.status as string]),
      );
      const progress = new Map((message.install_progress ?? []).map((item) => [item.instance_id, item]));
      if (!statuses.size && !progress.size) return;

      queryClient.setQueryData<DatabaseList>(databasesEverywhereQueryKey(server), (current) => {
        if (!current) return current;
        let changed = false;
        const next = current.databases.map((database) => {
          const snapshot = snapshots.get(database.uuid);
          const status = statuses.get(database.uuid);
          const installation = progress.get(database.uuid);
          const scannerRestartBlocked = snapshot?.resources
            ? scannerRestartBlockedState(
                snapshot.resources.disk,
                typeof database.metadata.disk_scanner_restart_blocked === 'boolean'
                  ? database.metadata.disk_scanner_restart_blocked
                  : undefined,
              )
            : undefined;
          const scannerStateChanged =
            scannerRestartBlocked !== undefined &&
            database.metadata.disk_scanner_restart_blocked !== scannerRestartBlocked;
          if (!status && !installation && !scannerStateChanged) return database;
          const diagnostic = installation?.diagnostic?.message?.trim() || null;
          if (
            (!status || status === database.status) &&
            !installation &&
            diagnostic === database.last_error &&
            !scannerStateChanged
          )
            return database;
          changed = true;
          return {
            ...database,
            status: status ?? database.status,
            last_error: diagnostic ?? (status === 'running' ? null : database.last_error),
            metadata:
              installation || scannerStateChanged
                ? {
                    ...database.metadata,
                    ...(installation ? { creation_progress: installation } : {}),
                    ...(scannerRestartBlocked !== undefined
                      ? { disk_scanner_restart_blocked: scannerRestartBlocked }
                      : {}),
                  }
                : database.metadata,
          };
        });
        return changed ? { ...current, databases: next } : current;
      });
    },
  });

  return null;
}
