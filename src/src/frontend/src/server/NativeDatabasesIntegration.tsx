import { faDatabase, faPlus } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Menu, Text } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import {
  Children,
  cloneElement,
  Fragment,
  isValidElement,
  type ReactElement,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useMemo,
  useState,
} from 'react';
import { useNavigate } from 'react-router';
import Button from '@/elements/Button.tsx';
import ConditionalTooltip from '@/elements/ConditionalTooltip.tsx';
import type { Props as ServerContentContainerProps } from '@/elements/containers/ServerContentContainer.tsx';
import Table from '@/elements/Table.tsx';
import { useServerCan } from '@/plugins/usePermissions.ts';
import { useTranslations } from '@/providers/TranslationProvider.tsx';
import { useServerStore } from '@/stores/server.ts';
import type { DatabaseList, DatabaseRecord } from '../api/types.ts';
import translations from '../translations.ts';
import CreateDatabaseModal from './CreateDatabaseModal.tsx';
import DatabaseListLiveUpdates from './DatabaseListLiveUpdates.tsx';
import DatabaseTableRow, { type DatabaseTableLayout } from './DatabaseTableRow.tsx';
import { databasesEverywhereQueryKey, serverHasDatabasesEverywhere, useDatabasesEverywhere } from './databaseQuery.ts';

interface NativePagination {
  total: number;
  perPage: number;
  page: number;
  data: unknown[];
}

interface NativeTableProps {
  columns: unknown[];
  pagination?: NativePagination;
  children?: ReactNode;
}

interface NativeCreateButton {
  disabled: boolean;
  onClick?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  permission?: string;
}

function findNativeCreateButton(node: ReactNode, permission?: string): NativeCreateButton | null {
  let match: NativeCreateButton | null = null;
  Children.forEach(node, (child) => {
    if (match || !isValidElement(child)) return;
    const props = child.props as {
      action?: unknown;
      children?: ReactNode;
      disabled?: boolean;
      onClick?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
    };
    const inheritedPermission = typeof props.action === 'string' ? props.action : permission;
    if (child.type === Button) {
      match = {
        disabled: Boolean(props.disabled),
        onClick: props.onClick,
        permission: inheritedPermission,
      };
      return;
    }
    match = findNativeCreateButton(props.children, inheritedPermission);
  });
  return match;
}

function matchesSearch(database: DatabaseRecord, search: string) {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;

  return [
    database.uuid,
    database.display_name,
    database.protocol_label,
    database.public_host,
    database.database_name,
    database.username,
  ].some((value) => value.toLowerCase().includes(needle));
}

function countTables(node: ReactNode): number {
  let count = 0;
  Children.forEach(node, (child) => {
    if (!isValidElement(child)) return;
    if (child.type === Table) {
      count += 1;
      return;
    }

    count += countTables((child.props as { children?: ReactNode }).children);
  });
  return count;
}

function mergeRowsIntoTable(
  node: ReactNode,
  targetTable: number,
  tableIndex: { value: number },
  databases: DatabaseRecord[],
  memoryColumn: string,
  statusColumn: string,
): ReactNode {
  return Children.map(node, (child) => {
    if (!isValidElement(child)) return child;

    if (child.type === Table) {
      const currentTable = tableIndex.value;
      tableIndex.value += 1;
      if (currentTable !== targetTable) return child;

      const table = child as ReactElement<NativeTableProps>;
      const pagination = table.props.pagination;
      const layout: DatabaseTableLayout = table.props.columns[3] === memoryColumn ? 'agent' : 'classic';
      const showProviderRows = !pagination || pagination.page === 1;
      const columns = [...table.props.columns];
      columns[5] = statusColumn;
      const mergedPagination = pagination
        ? {
            ...pagination,
            total: Math.max(pagination.total, pagination.data.length + (showProviderRows ? databases.length : 0)),
          }
        : undefined;

      return cloneElement(
        table,
        { columns, pagination: mergedPagination },
        table.props.children,
        showProviderRows
          ? databases.map((database) => (
              <DatabaseTableRow database={database} layout={layout} key={`dbev-${database.uuid}`} />
            ))
          : null,
      );
    }

    const props = child.props as { children?: ReactNode };
    if (props.children === undefined) return child;

    return cloneElement(
      child as ReactElement<{ children?: ReactNode }>,
      undefined,
      mergeRowsIntoTable(props.children, targetTable, tableIndex, databases, memoryColumn, statusColumn),
    );
  });
}

function CombinedDatabaseUsage({ fallback }: { fallback?: string }) {
  const { t } = useTranslations();
  const server = useServerStore((state) => state.server);
  const canRead = useServerCan('databases-everywhere.read');
  const enabled = serverHasDatabasesEverywhere(server);
  const query = useDatabasesEverywhere(server.uuid, canRead && enabled);

  const visible = Boolean(query.data && (query.data.provider_available || query.data.databases.length > 0));
  if (!enabled || !canRead || !query.data || !visible) return fallback ?? null;

  return t('pages.server.databases.subtitle', {
    current: query.data.database_usage,
    max: query.data.database_limit,
  });
}

function DatabaseCreateAction({ nativeAction }: { nativeAction?: ReactNode }) {
  const { t } = translations.useTranslations();
  const server = useServerStore((state) => state.server);
  const canRead = useServerCan('databases-everywhere.read');
  const canCreate = useServerCan('databases-everywhere.create');
  const canCreateClassic = useServerCan('databases.create');
  const canCreateAgent = useServerCan('database-instances.create');
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [opened, setOpened] = useState(false);
  const enabled = serverHasDatabasesEverywhere(server);
  const query = useDatabasesEverywhere(server.uuid, canRead && enabled);

  const data = query.data;
  const atLimit = Boolean(data && data.database_usage >= data.database_limit);
  const visible = Boolean(data && (data.provider_available || data.databases.length > 0));
  const provisioningEnabled = Boolean(data?.provider_available && data.provisioning_enabled);
  const provisioningReason =
    data?.provisioning_block_reason || (!data?.provider_available ? t('server.provisioningDisabled', {}) : null);
  const nativeButton = useMemo(() => findNativeCreateButton(nativeAction), [nativeAction]);
  const canUseNative = Boolean(
    nativeButton &&
      (nativeButton.permission === 'databases.create'
        ? canCreateClassic
        : nativeButton.permission === 'database-instances.create'
          ? canCreateAgent
          : canCreateClassic || canCreateAgent),
  );

  const onCreated = (database: DatabaseRecord) => {
    queryClient.setQueryData<DatabaseList>(databasesEverywhereQueryKey(server.uuid), (current) =>
      current
        ? {
            ...current,
            database_usage: current.database_usage + 1,
            databases: [...current.databases, database],
          }
        : current,
    );
    navigate(`/server/${server.uuidShort}/databases/dbev/${database.uuid}`);
  };

  if (!enabled || !canRead || !data || !visible) return nativeAction ?? null;

  if (nativeAction && !nativeButton) {
    return (
      <Fragment>
        {nativeAction}
        {canCreate && (
          <ConditionalTooltip
            enabled={!provisioningEnabled || atLimit}
            label={atLimit ? t('server.limitReached', {}) : provisioningReason || t('server.provisioningDisabled', {})}
          >
            <Button
              color='blue'
              leftSection={<FontAwesomeIcon icon={faPlus} />}
              onClick={() => setOpened(true)}
              disabled={!provisioningEnabled || atLimit}
            >
              {t('server.addDbevDatabase', {})}
            </Button>
          </ConditionalTooltip>
        )}
        <CreateDatabaseModal
          opened={opened}
          server={server.uuid}
          protocols={data.protocols}
          imageOptions={data.image_options}
          onClose={() => setOpened(false)}
          onCreated={onCreated}
          onCheck={() => query.refetch()}
        />
      </Fragment>
    );
  }

  if (!canUseNative && !canCreate) return null;

  return (
    <Fragment>
      <Menu position='bottom-end' shadow='md' width={280}>
        <Menu.Target>
          <Button color='blue' leftSection={<FontAwesomeIcon icon={faPlus} />}>
            {t('server.addDatabase', {})}
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          {canUseNative && nativeButton && (
            <Menu.Item
              leftSection={<FontAwesomeIcon icon={faDatabase} />}
              disabled={nativeButton.disabled}
              onClick={(event) => nativeButton.onClick?.(event)}
            >
              <Text size='sm'>{t('server.standardDatabase', {})}</Text>
              <Text size='xs' c='dimmed'>
                {t('server.standardDatabaseDescription', {})}
              </Text>
            </Menu.Item>
          )}
          {canCreate && (
            <ConditionalTooltip
              enabled={!provisioningEnabled || atLimit}
              label={
                atLimit ? t('server.limitReached', {}) : provisioningReason || t('server.provisioningDisabled', {})
              }
            >
              <Menu.Item
                leftSection={<FontAwesomeIcon icon={faDatabase} />}
                disabled={!provisioningEnabled || atLimit}
                onClick={() => setOpened(true)}
              >
                <Text size='sm'>{t('server.managedDatabase', {})}</Text>
                <Text size='xs' c='dimmed'>
                  {t('server.managedDatabaseDescription', {})}
                </Text>
              </Menu.Item>
            </ConditionalTooltip>
          )}
        </Menu.Dropdown>
      </Menu>
      <CreateDatabaseModal
        opened={opened}
        server={server.uuid}
        protocols={data.protocols}
        imageOptions={data.image_options}
        onClose={() => setOpened(false)}
        onCreated={onCreated}
        onCheck={() => query.refetch()}
      />
    </Fragment>
  );
}

function countSectionActions(node: ReactNode): number {
  let count = 0;
  Children.forEach(node, (child) => {
    if (!isValidElement(child)) return;
    const props = child.props as { action?: ReactNode; search?: unknown; setSearch?: unknown; children?: ReactNode };
    if (props.action !== undefined && props.search !== undefined && props.setSearch !== undefined) count += 1;
    count += countSectionActions(props.children);
  });
  return count;
}

function injectCreateAction(node: ReactNode, target: number, index: { value: number }): ReactNode {
  return Children.map(node, (child) => {
    if (!isValidElement(child)) return child;
    const props = child.props as { action?: ReactNode; search?: unknown; setSearch?: unknown; children?: ReactNode };
    if (props.action !== undefined && props.search !== undefined && props.setSearch !== undefined) {
      const current = index.value++;
      if (current === target) {
        return cloneElement(child as ReactElement<{ action?: ReactNode }>, {
          action: <DatabaseCreateAction nativeAction={props.action} />,
        });
      }
    }
    if (props.children === undefined) return child;
    return cloneElement(
      child as ReactElement<{ children?: ReactNode }>,
      undefined,
      injectCreateAction(props.children, target, index),
    );
  });
}

function IntegratedDatabaseRows({ nativeChildren, search = '' }: { nativeChildren: ReactNode; search?: string }) {
  const { t } = useTranslations();
  const server = useServerStore((state) => state.server);
  const canRead = useServerCan('databases-everywhere.read');
  const enabled = serverHasDatabasesEverywhere(server);
  const query = useDatabasesEverywhere(server.uuid, canRead && enabled);
  const databases = useMemo(
    () => (query.data ? query.data.databases.filter((database) => matchesSearch(database, search)) : []),
    [query.data, search],
  );

  const visible = Boolean(query.data && (query.data.provider_available || query.data.databases.length > 0));
  if (!enabled || !canRead || !visible) return nativeChildren;

  const sectionActionCount = countSectionActions(nativeChildren);
  const childrenWithAction = sectionActionCount
    ? injectCreateAction(nativeChildren, sectionActionCount - 1, { value: 0 })
    : nativeChildren;
  const tableCount = countTables(childrenWithAction);
  if (tableCount > 0) {
    return (
      <>
        <DatabaseListLiveUpdates server={server.uuid} databases={query.data?.databases ?? []} />
        {mergeRowsIntoTable(
          childrenWithAction,
          tableCount - 1,
          { value: 0 },
          databases,
          t('common.form.memory', {}),
          t('common.table.columns.status', {}),
        )}
      </>
    );
  }

  const pagination: NativePagination = {
    total: databases.length,
    perPage: Math.max(databases.length, 1),
    page: 1,
    data: databases,
  };

  return (
    <>
      <DatabaseListLiveUpdates server={server.uuid} databases={query.data?.databases ?? []} />
      {childrenWithAction}
      <Table
        columns={[
          t('common.table.columns.name', {}),
          t('common.table.columns.type', {}),
          t('common.table.columns.address', {}),
          t('common.table.columns.username', {}),
          t('common.table.columns.size', {}),
          t('common.table.columns.status', {}),
          '',
        ]}
        pagination={pagination}
        allowSelect={false}
      >
        {databases.map((database) => (
          <DatabaseTableRow database={database} layout='classic' key={`dbev-${database.uuid}`} />
        ))}
      </Table>
    </>
  );
}

export function integrateNativeDatabasesContainer(props: ServerContentContainerProps): ServerContentContainerProps {
  return {
    ...props,
    subtitle: (<CombinedDatabaseUsage fallback={props.subtitle} />) as unknown as string,
    contentRight: props.contentRight ? <DatabaseCreateAction nativeAction={props.contentRight} /> : undefined,
    children: <IntegratedDatabaseRows nativeChildren={props.children} search={props.search} />,
  };
}
