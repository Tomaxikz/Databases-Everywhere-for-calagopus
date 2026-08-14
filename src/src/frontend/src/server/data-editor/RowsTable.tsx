import { faEllipsisVertical, faPen, faPlus, faSearch, faTrash } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Checkbox, Group, Text, Title } from '@mantine/core';
import ActionIcon from '@/elements/ActionIcon.tsx';
import Button from '@/elements/Button.tsx';
import { ServerCan } from '@/elements/Can.tsx';
import Card from '@/elements/Card.tsx';
import TextInput from '@/elements/input/TextInput.tsx';
import Menu from '@/elements/Menu.tsx';
import Table, { Pagination, TableData, TableRow } from '@/elements/Table.tsx';
import { useServerCan } from '@/plugins/usePermissions.ts';
import type { DatabaseProtocol, QueryOutput } from '../../api/types.ts';
import translations from '../../translations.ts';
import DataValueCell from './DataValueCell.tsx';
import type { DataRecordLabels } from './terminology.ts';

interface VisibleRow {
  index: number;
  value: unknown;
}

interface Props {
  output: QueryOutput | null;
  fallbackColumns?: string[];
  visibleRows?: VisibleRow[];
  page: number;
  perPage: number;
  loading: boolean;
  error: string | null;
  protocol: DatabaseProtocol;
  labels: DataRecordLabels;
  readOnly?: boolean;
  selectedIndex: number | null;
  selectedIndexes: ReadonlySet<number>;
  bulkDeleting: boolean;
  filter: string;
  onFilter: (value: string) => void;
  onPage: (page: number) => void;
  onSelect: (value: unknown, index: number) => void;
  onToggle: (value: unknown, index: number, checked: boolean) => void;
  onToggleAll: (rows: VisibleRow[], checked: boolean) => void;
  onClearSelection: () => void;
  onDeleteSelected: () => void;
  onInsert: () => void;
  onEdit: (value: unknown, index: number) => void;
  onDelete: (value: unknown, index: number) => void;
}

export default function RowsTable({
  output,
  fallbackColumns = [],
  visibleRows = [],
  page,
  perPage,
  loading,
  error,
  protocol,
  labels,
  readOnly = false,
  selectedIndex,
  selectedIndexes,
  bulkDeleting,
  filter,
  onFilter,
  onPage,
  onSelect,
  onToggle,
  onToggleAll,
  onClearSelection,
  onDeleteSelected,
  onInsert,
  onEdit,
  onDelete,
}: Props) {
  const { t } = translations.useTranslations();
  const canWrite = useServerCan('databases-everywhere.data-write') && !readOnly;
  const outputRows = Array.isArray(output?.rows) ? output.rows : [];
  const outputColumns = Array.isArray(output?.columns) ? output.columns : [];
  const safeFallbackColumns = Array.isArray(fallbackColumns) ? fallbackColumns : [];
  const loaded = outputRows.length;
  const total = output ? (page - 1) * perPage + loaded + (output.truncated ? 1 : 0) : 0;
  const pagination = { total, perPage, page, data: outputRows };
  const columns = outputColumns.length ? outputColumns : safeFallbackColumns;
  const allVisibleSelected = visibleRows.length > 0 && visibleRows.every((row) => selectedIndexes.has(row.index));
  const someVisibleSelected = visibleRows.some((row) => selectedIndexes.has(row.index));

  return (
    <Card p={0}>
      <Group
        justify='space-between'
        align='center'
        wrap='wrap'
        className='border-b border-(--mantine-color-default-border) px-4 py-3'
      >
        <div>
          <Title order={4}>{labels.title}</Title>
          <Text size='xs' c='dimmed'>
            {filter ? labels.filtered(visibleRows.length, loaded) : labels.description}
          </Text>
        </div>
        <Group gap='xs'>
          <TextInput
            value={filter}
            onChange={(event) => onFilter(event.currentTarget.value)}
            placeholder={labels.filterPlaceholder}
            leftSection={<FontAwesomeIcon icon={faSearch} />}
            w={{ base: 200, sm: 280 }}
          />
          <ServerCan action='databases-everywhere.data-write'>
            <Button size='sm' onClick={onInsert} leftSection={<FontAwesomeIcon icon={faPlus} />}>
              {labels.create}
            </Button>
          </ServerCan>
        </Group>
      </Group>

      {selectedIndexes.size > 0 && (
        <Group
          justify='space-between'
          className='border-b border-(--mantine-color-default-border) bg-(--mantine-color-blue-light) px-4 py-2'
        >
          <Text size='sm' fw={600}>
            {labels.selected(selectedIndexes.size)}
          </Text>
          <Group gap='xs'>
            <Button size='compact-xs' variant='subtle' disabled={bulkDeleting} onClick={onClearSelection}>
              {t('server.dataEditor.clearSelection', {})}
            </Button>
            <ServerCan action='databases-everywhere.data-write'>
              <Button
                size='compact-xs'
                color='red'
                loading={bulkDeleting}
                leftSection={<FontAwesomeIcon icon={faTrash} />}
                onClick={onDeleteSelected}
              >
                {labels.deleteSelected}
              </Button>
            </ServerCan>
          </Group>
        </Group>
      )}

      <Table
        flush
        columns={[
          ...(canWrite
            ? [
                {
                  name: ' ',
                  rightSection: (
                    <Checkbox
                      size='xs'
                      aria-label={labels.selectVisible}
                      checked={allVisibleSelected}
                      indeterminate={!allVisibleSelected && someVisibleSelected}
                      disabled={visibleRows.length === 0 || bulkDeleting}
                      onChange={(event) => onToggleAll(visibleRows, event.currentTarget.checked)}
                    />
                  ),
                },
              ]
            : []),
          ...columns.map((name) => ({ name })),
          { name: '' },
        ]}
        loading={loading}
        error={error}
        pagination={pagination}
      >
        {visibleRows.map(({ value, index }) => {
          const record =
            value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
          const values = Array.isArray(value) ? value : columns.map((column) => record[column]);
          const selected = selectedIndex === index || selectedIndexes.has(index);

          return (
            <TableRow
              key={`${page}:${index}`}
              aria-selected={selected}
              bg={selected ? 'var(--mantine-color-blue-light)' : undefined}
              className='cursor-pointer'
              onClick={() => onSelect(value, index)}
            >
              {canWrite && (
                <TableData className='w-px py-3' onClick={(event) => event.stopPropagation()}>
                  <Checkbox
                    size='xs'
                    aria-label={labels.select((page - 1) * perPage + index + 1)}
                    checked={selectedIndexes.has(index)}
                    disabled={bulkDeleting}
                    onChange={(event) => onToggle(value, index, event.currentTarget.checked)}
                  />
                </TableData>
              )}
              {columns.map((column, columnIndex) => {
                const identityColumn =
                  (protocol === 'mongodb' && column === '_id') || (protocol === 'qdrant' && column === 'id');

                return (
                  <TableData
                    key={`${index}:${column}`}
                    className='py-3'
                    style={{
                      width: identityColumn ? '20rem' : undefined,
                      minWidth: identityColumn ? '18rem' : '10rem',
                      maxWidth: identityColumn ? '22rem' : '28rem',
                    }}
                  >
                    <DataValueCell value={values[columnIndex]} />
                  </TableData>
                );
              })}
              <TableData className='w-px py-3' onClick={(event) => event.stopPropagation()}>
                <ServerCan action='databases-everywhere.data-write'>
                  <Menu position='bottom-end' withinPortal>
                    <Menu.Target>
                      <ActionIcon variant='subtle' color='gray' aria-label={t('server.dataEditor.details', {})}>
                        <FontAwesomeIcon icon={faEllipsisVertical} />
                      </ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item leftSection={<FontAwesomeIcon icon={faPen} />} onClick={() => onEdit(value, index)}>
                        {labels.edit}
                      </Menu.Item>
                      <Menu.Item
                        color='red'
                        leftSection={<FontAwesomeIcon icon={faTrash} />}
                        onClick={() => onDelete(value, index)}
                      >
                        {labels.delete}
                      </Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                </ServerCan>
              </TableData>
            </TableRow>
          );
        })}
      </Table>

      <Pagination data={pagination} m='xs' onPageSelect={onPage} withShortcuts={false} />

      {output && (
        <Group justify='flex-end' className='border-t border-(--mantine-color-default-border) px-4 py-2'>
          <Text size='xs' c='dimmed'>
            {t('server.dataEditor.queryTiming', { elapsed: output.elapsed_ms, count: loaded })}
          </Text>
        </Group>
      )}
    </Card>
  );
}
