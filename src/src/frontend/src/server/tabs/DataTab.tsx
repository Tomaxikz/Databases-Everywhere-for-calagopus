import { Box, Flex, Stack, Text } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { httpErrorToHuman } from '@/api/axios.ts';
import Alert from '@/elements/Alert.tsx';
import Card from '@/elements/Card.tsx';
import ConfirmationModal from '@/elements/modals/ConfirmationModal.tsx';
import { useToast } from '@/providers/ToastProvider.tsx';
import {
  browseData,
  describeDataObject,
  getExplorer,
  mutateData,
  mutateDataBatch,
  mutateSchema,
} from '../../api/client.ts';
import { dbevQueryKeys } from '../../api/queryKeys.ts';
import type {
  DatabaseRecord,
  DataObject,
  ExplorerOverview,
  QueryOutput,
  SchemaMutationInput,
} from '../../api/types.ts';
import translations from '../../translations.ts';
import RecordEditorModal from '../components/RecordEditorModal.tsx';
import SchemaEditorModal from '../components/SchemaEditorModal.tsx';
import ColumnsTable from '../data-editor/ColumnsTable.tsx';
import defaultNamespace from '../data-editor/defaultNamespace.ts';
import inferColumns from '../data-editor/inferColumns.ts';
import ObjectSidebar, { dataObjectKey } from '../data-editor/ObjectSidebar.tsx';
import RowsTable from '../data-editor/RowsTable.tsx';
import dataEditorTerminology from '../data-editor/terminology.ts';

type SchemaMode = 'create-object' | 'rename-object' | 'add-column' | 'rename-column' | 'delete-column';

const COLUMNS_PER_PAGE = 10;
const ROWS_PER_PAGE = 25;
const CACHE_TIME = 30_000;

export default function DataTab({ server, database }: { server: string; database: DatabaseRecord }) {
  const { t } = translations.useTranslations();
  const { addToast } = useToast();
  const queryClient = useQueryClient();
  const terminology = dataEditorTerminology(database.protocol);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [objectSearch, setObjectSearch] = useState('');
  const deferredObjectSearch = useDeferredValue(objectSearch);
  const [columnPage, setColumnPage] = useState(1);
  const [rowSearch, setRowSearch] = useState('');
  const deferredRowSearch = useDeferredValue(rowSearch);
  const [rowPage, setRowPage] = useState(1);
  const [selectedRow, setSelectedRow] = useState<{ index: number; value: unknown } | null>(null);
  const [selectedRows, setSelectedRows] = useState<Map<number, unknown>>(new Map());
  const [editorMode, setEditorMode] = useState<'insert' | 'update'>('insert');
  const [editorOpen, setEditorOpen] = useState(false);
  const [deleteRowOpen, setDeleteRowOpen] = useState(false);
  const [deleteRowsOpen, setDeleteRowsOpen] = useState(false);
  const [deleteObjectOpen, setDeleteObjectOpen] = useState(false);
  const [schemaMode, setSchemaMode] = useState<SchemaMode | null>(null);
  const [schemaColumn, setSchemaColumn] = useState<string | null>(null);
  const [mutating, setMutating] = useState(false);
  const readOnly = !database.mutations_allowed;

  const explorer = useQuery({
    queryKey: dbevQueryKeys.databaseExplorer(server, database.uuid),
    queryFn: () => getExplorer(server, database.uuid),
    retry: false,
    staleTime: CACHE_TIME,
    refetchOnWindowFocus: false,
  });
  const objects = explorer.data?.objects ?? [];
  const selected = useMemo(
    () => objects.find((object) => dataObjectKey(object) === selectedKey) ?? null,
    [objects, selectedKey],
  );
  const normalizedObjectSearch = deferredObjectSearch.trim().toLowerCase();
  const filteredObjects = useMemo(
    () =>
      objects.filter((object) => {
        if (!normalizedObjectSearch) return true;
        return [object.namespace, object.name, object.kind]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(normalizedObjectSearch));
      }),
    [normalizedObjectSearch, objects],
  );
  useEffect(() => {
    if (!selectedKey || !objects.some((object) => dataObjectKey(object) === selectedKey)) {
      setSelectedKey(objects[0] ? dataObjectKey(objects[0]) : null);
    }
  }, [objects, selectedKey]);

  const supportsObjects = !['redis', 'valkey', 'qdrant'].includes(database.protocol);
  const supportsColumns = ['postgres', 'mysql', 'mariadb', 'clickhouse'].includes(database.protocol);
  const collections = ['mongodb', 'qdrant'].includes(database.protocol);
  const objectMode = ['redis', 'valkey'].includes(database.protocol) ? 'key' : collections ? 'collection' : 'table';
  const fallbackNamespace = defaultNamespace(database.protocol, database.database_name);

  const rows = useQuery({
    queryKey: dbevQueryKeys.databaseRows(
      server,
      database.uuid,
      selected?.namespace ?? null,
      selected?.name ?? '',
      rowPage,
    ),
    queryFn: () =>
      browseData(
        server,
        database.uuid,
        selected!.name,
        selected!.namespace,
        (rowPage - 1) * ROWS_PER_PAGE,
        ROWS_PER_PAGE,
      ),
    enabled: Boolean(selected && explorer.isSuccess && !explorer.isFetching),
    retry: false,
    staleTime: CACHE_TIME,
    refetchOnWindowFocus: false,
    placeholderData: (previous, previousQuery) => {
      const previousKey = previousQuery?.queryKey;
      return previousKey?.at(-2) === selected?.name && previousKey?.at(-3) === (selected?.namespace ?? null)
        ? previous
        : undefined;
    },
  });

  const schema = useQuery({
    queryKey: dbevQueryKeys.databaseSchema(server, database.uuid, selected?.namespace ?? null, selected?.name ?? ''),
    queryFn: () => describeDataObject(server, database.uuid, selected!.name, selected!.namespace),
    enabled: Boolean(selected && supportsColumns && explorer.isSuccess && !explorer.isFetching),
    retry: false,
    staleTime: CACHE_TIME,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    setRowPage(1);
    setColumnPage(1);
    setRowSearch('');
    setSelectedRow(null);
    setSelectedRows(new Map());
  }, [selectedKey]);

  useEffect(() => {
    if (!rows.isFetching && rows.data && rowPage > 1 && rows.data.rows.length === 0) setRowPage(rowPage - 1);
  }, [rowPage, rows.data, rows.isFetching]);

  const inferredColumns = useMemo(() => inferColumns(rows.data), [rows.data]);
  const columnDefinitions = supportsColumns && schema.data ? schema.data : inferredColumns;
  const columnsInferred = !supportsColumns || Boolean(schema.error);
  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(columnDefinitions.length / COLUMNS_PER_PAGE));
    if (columnPage > totalPages) setColumnPage(totalPages);
  }, [columnDefinitions.length, columnPage]);
  const visibleRows = useMemo(() => {
    const needle = deferredRowSearch.trim().toLowerCase();
    const resultRows = Array.isArray(rows.data?.rows) ? rows.data.rows : [];
    return resultRows
      .map((value, index) => ({
        value,
        index,
        searchable: (JSON.stringify(value) ?? String(value ?? '')).toLowerCase(),
      }))
      .filter((row) => !needle || row.searchable.includes(needle))
      .map(({ value, index }) => ({ value, index }));
  }, [deferredRowSearch, rows.data]);

  const chooseObject = (object: DataObject) => {
    const key = dataObjectKey(object);
    if (key === selectedKey) return;
    setSelectedKey(key);
    setRowPage(1);
  };

  const closeMutationUi = () => {
    setEditorOpen(false);
    setDeleteRowOpen(false);
    setDeleteRowsOpen(false);
    setDeleteObjectOpen(false);
    setSchemaMode(null);
    setSchemaColumn(null);
    setSelectedRow(null);
    setSelectedRows(new Map());
  };

  const runMutation = async (operation: () => Promise<unknown>, message: string) => {
    if (readOnly)
      throw new Error(database.mutation_block_reason || 'This database is in read-only compatibility mode.');
    setMutating(true);
    try {
      const result = await operation();
      closeMutationUi();
      addToast(message, 'success');
      return result;
    } catch (error) {
      addToast(httpErrorToHuman(error), 'error');
      throw error;
    } finally {
      setMutating(false);
    }
  };

  const updateRowsCache = (mode: 'insert' | 'update' | 'delete', value?: unknown) => {
    if (!selected) return;
    queryClient.setQueryData<QueryOutput>(
      dbevQueryKeys.databaseRows(server, database.uuid, selected.namespace, selected.name, rowPage),
      (current) => {
        if (!current) return current;
        if (mode === 'delete' && selectedRow) {
          return { ...current, rows: current.rows.filter((_, index) => index !== selectedRow.index) };
        }
        if (mode === 'update' && selectedRow && value !== undefined) {
          return {
            ...current,
            rows: current.rows.map((row, index) => (index === selectedRow.index ? value : row)),
          };
        }
        if (mode === 'insert' && rowPage === 1 && value !== undefined) {
          return { ...current, rows: [value, ...current.rows].slice(0, ROWS_PER_PAGE) };
        }
        return current;
      },
    );
  };

  const saveRecord = async (value: unknown) => {
    if (!selected) return;
    const mode = editorMode;
    await runMutation(
      () =>
        mutateData(server, database.uuid, {
          operation: mode,
          namespace: selected.namespace,
          object: selected.name,
          original: mode === 'update' ? selectedRow?.value : undefined,
          value,
        }),
      terminology.records.saved,
    );
    updateRowsCache(mode, value);
    void rows.refetch();
  };

  const deleteRecord = async () => {
    if (!selected || !selectedRow) return;
    await runMutation(
      () =>
        mutateData(server, database.uuid, {
          operation: 'delete',
          namespace: selected.namespace,
          object: selected.name,
          original: selectedRow.value,
        }),
      terminology.records.deleted,
    );
    updateRowsCache('delete');
    void rows.refetch();
  };

  const deleteSelectedRecords = async () => {
    if (!selected || selectedRows.size === 0) return;
    const selectedIndexes = new Set(selectedRows.keys());
    try {
      await runMutation(
        () =>
          mutateDataBatch(server, database.uuid, {
            operation: 'delete',
            namespace: selected.namespace,
            object: selected.name,
            originals: Array.from(selectedRows.values()),
          }),
        terminology.records.selectedDeleted(selectedRows.size),
      );
      queryClient.setQueryData<QueryOutput>(
        dbevQueryKeys.databaseRows(server, database.uuid, selected.namespace, selected.name, rowPage),
        (current) =>
          current ? { ...current, rows: current.rows.filter((_, index) => !selectedIndexes.has(index)) } : current,
      );
    } finally {
      void rows.refetch();
    }
  };

  const toggleRow = (value: unknown, index: number, checked: boolean) => {
    setSelectedRows((current) => {
      const next = new Map(current);
      if (checked) next.set(index, value);
      else next.delete(index);
      return next;
    });
  };

  const toggleVisibleRows = (visible: { value: unknown; index: number }[], checked: boolean) => {
    setSelectedRows((current) => {
      const next = new Map(current);
      for (const row of visible) {
        if (checked) next.set(row.index, row.value);
        else next.delete(row.index);
      }
      return next;
    });
  };

  const updateExplorerCache = (input: SchemaMutationInput) => {
    queryClient.setQueryData<ExplorerOverview>(dbevQueryKeys.databaseExplorer(server, database.uuid), (current) => {
      if (!current) return current;
      if (input.operation === 'delete_object') {
        return { ...current, objects: current.objects.filter((object) => dataObjectKey(object) !== selectedKey) };
      }
      if (input.operation === 'rename_object' && selected && input.new_name) {
        return {
          ...current,
          objects: current.objects.map((object) =>
            dataObjectKey(object) === selectedKey ? { ...object, name: input.new_name as string } : object,
          ),
        };
      }
      if (input.operation === 'create_object') {
        return {
          ...current,
          objects: [
            ...current.objects,
            {
              name: input.object,
              namespace: input.namespace ?? fallbackNamespace,
              kind: collections ? 'collection' : 'base table',
              metadata: {},
            },
          ].sort((left, right) => dataObjectKey(left).localeCompare(dataObjectKey(right))),
        };
      }
      return current;
    });
  };

  const changeSchema = async (input: SchemaMutationInput) => {
    await runMutation(() => mutateSchema(server, database.uuid, input), t('server.dataEditor.structureUpdated', {}));
    const objectMutation = ['create_object', 'rename_object', 'delete_object'].includes(input.operation);
    if (objectMutation) {
      updateExplorerCache(input);
      if (input.operation === 'delete_object') setSelectedKey(null);
      if ((input.operation === 'rename_object' || input.operation === 'create_object') && input.new_name) {
        setSelectedKey(`${input.namespace ?? selected?.namespace ?? ''}\u0000${input.new_name}`);
      } else if (input.operation === 'create_object') {
        setSelectedKey(`${input.namespace ?? fallbackNamespace ?? ''}\u0000${input.object}`);
      }
      void explorer.refetch();
      return;
    }
    void Promise.all([schema.refetch(), rows.refetch()]);
  };

  const deleteObject = async () => {
    if (!selected) return;
    await changeSchema({
      operation: 'delete_object',
      namespace: selected.namespace,
      object: selected.name,
      confirm: true,
    });
  };

  const openRowEditor = (mode: 'insert' | 'update', value?: unknown, index?: number) => {
    setEditorMode(mode);
    setSelectedRow(mode === 'update' && index !== undefined ? { value, index } : null);
    setEditorOpen(true);
  };

  const openColumnEditor = (mode: 'rename-column' | 'delete-column', column: string) => {
    setSchemaColumn(column);
    setSchemaMode(mode);
  };

  return (
    <Stack mt='md'>
      {readOnly && (
        <Alert color='yellow'>
          {database.mutation_block_reason ||
            'Structure and records remain browsable, but editing is disabled until this database host matches API 0.12.0.'}
        </Alert>
      )}
      <Flex gap='md' align='flex-start' direction={{ base: 'column', lg: 'row' }}>
        <Box w={{ base: '100%', lg: 320, xl: 340 }} className='shrink-0 lg:sticky lg:top-4'>
          <ObjectSidebar
            objects={filteredObjects}
            filteredTotal={filteredObjects.length}
            loading={explorer.isFetching && !explorer.data}
            refreshing={explorer.isFetching}
            error={explorer.error ? httpErrorToHuman(explorer.error) : null}
            selectedKey={selectedKey}
            search={objectSearch}
            mode={objectMode}
            protocol={database.protocol}
            supportsCreation={supportsObjects}
            readOnly={readOnly}
            onSearch={setObjectSearch}
            onSelect={chooseObject}
            onCreate={() => setSchemaMode('create-object')}
            onRefresh={() => void explorer.refetch()}
          />
        </Box>

        <Box w='100%' className='min-w-0 flex-1'>
          {selected ? (
            <Stack gap='md'>
              {schema.error && supportsColumns && (
                <Alert color='yellow'>
                  {t('server.dataEditor.schemaLoadFailed', { error: httpErrorToHuman(schema.error) })}
                </Alert>
              )}
              <ColumnsTable
                object={selected}
                columns={columnDefinitions}
                page={columnPage}
                perPage={COLUMNS_PER_PAGE}
                loading={supportsColumns ? schema.isFetching && !schema.data : rows.isFetching && !rows.data}
                error={null}
                inferred={columnsInferred}
                collections={collections}
                labels={terminology.structure}
                supportsColumnMutations={supportsColumns}
                supportsObjectMutations={supportsObjects}
                readOnly={readOnly}
                onPage={setColumnPage}
                onAdd={() => setSchemaMode('add-column')}
                onRenameColumn={(column) => openColumnEditor('rename-column', column)}
                onDeleteColumn={(column) => openColumnEditor('delete-column', column)}
                onRenameObject={() => setSchemaMode('rename-object')}
                onDeleteObject={() => setDeleteObjectOpen(true)}
              />
              <RowsTable
                output={rows.data ?? null}
                fallbackColumns={columnDefinitions.map((column) => column.name)}
                visibleRows={visibleRows}
                page={rowPage}
                perPage={ROWS_PER_PAGE}
                loading={rows.isFetching && !rows.data}
                error={rows.error ? httpErrorToHuman(rows.error) : null}
                protocol={database.protocol}
                labels={terminology.records}
                readOnly={readOnly}
                selectedIndex={selectedRow?.index ?? null}
                selectedIndexes={new Set(selectedRows.keys())}
                bulkDeleting={mutating && deleteRowsOpen}
                filter={rowSearch}
                onFilter={setRowSearch}
                onPage={(page) => {
                  setSelectedRow(null);
                  setSelectedRows(new Map());
                  setRowPage(page);
                }}
                onSelect={(value, index) => setSelectedRow({ value, index })}
                onToggle={toggleRow}
                onToggleAll={toggleVisibleRows}
                onClearSelection={() => setSelectedRows(new Map())}
                onDeleteSelected={() => setDeleteRowsOpen(true)}
                onInsert={() => openRowEditor('insert')}
                onEdit={(value, index) => openRowEditor('update', value, index)}
                onDelete={(value, index) => {
                  setSelectedRow({ value, index });
                  setDeleteRowOpen(true);
                }}
              />
            </Stack>
          ) : (
            <Card mih={180} className='flex items-center justify-center'>
              <Text c='dimmed' ta='center'>
                {terminology.emptySelection}
              </Text>
            </Card>
          )}
        </Box>
      </Flex>

      <RecordEditorModal
        opened={editorOpen}
        onClose={() => setEditorOpen(false)}
        protocol={database.protocol}
        labels={terminology.records}
        columns={rows.data?.columns.length ? rows.data.columns : columnDefinitions.map((column) => column.name)}
        value={editorMode === 'update' ? selectedRow?.value : {}}
        mode={editorMode}
        loading={mutating}
        onSave={saveRecord}
      />
      {schemaMode && (
        <SchemaEditorModal
          opened
          onClose={() => {
            setSchemaMode(null);
            setSchemaColumn(null);
          }}
          mode={schemaMode}
          protocol={database.protocol}
          namespace={selected?.namespace ?? fallbackNamespace}
          object={selected?.name}
          columns={columnDefinitions.map((column) => column.name)}
          initialColumn={schemaColumn}
          loading={mutating}
          onSubmit={changeSchema}
        />
      )}
      <ConfirmationModal
        opened={deleteRowOpen}
        onClose={() => setDeleteRowOpen(false)}
        title={terminology.records.delete}
        confirm={terminology.records.delete}
        onConfirmed={deleteRecord}
      >
        {terminology.records.deleteWarning}
      </ConfirmationModal>
      <ConfirmationModal
        opened={deleteRowsOpen}
        onClose={() => setDeleteRowsOpen(false)}
        title={terminology.records.deleteSelectedTitle(selectedRows.size)}
        confirm={terminology.records.deleteSelected}
        onConfirmed={deleteSelectedRecords}
      >
        {terminology.records.deleteSelectedWarning(selectedRows.size)}
      </ConfirmationModal>
      <ConfirmationModal
        opened={deleteObjectOpen}
        onClose={() => setDeleteObjectOpen(false)}
        title={collections ? t('server.dataEditor.deleteCollection', {}) : t('server.dataEditor.deleteTable', {})}
        confirm={collections ? t('server.dataEditor.deleteCollection', {}) : t('server.dataEditor.deleteTable', {})}
        onConfirmed={deleteObject}
      >
        {t('server.dataEditor.deleteObjectWarning', { name: selected?.name ?? '' })}
      </ConfirmationModal>
    </Stack>
  );
}
