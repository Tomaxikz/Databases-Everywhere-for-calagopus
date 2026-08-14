import { faEllipsisVertical, faPen, faPlus, faTrash } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Group, Text, Title } from '@mantine/core';
import ActionIcon from '@/elements/ActionIcon.tsx';
import Badge from '@/elements/Badge.tsx';
import Button from '@/elements/Button.tsx';
import { ServerCan } from '@/elements/Can.tsx';
import Card from '@/elements/Card.tsx';
import Code from '@/elements/Code.tsx';
import Menu from '@/elements/Menu.tsx';
import Table, { Pagination, TableData, TableRow } from '@/elements/Table.tsx';
import type { DataColumn, DataObject } from '../../api/types.ts';
import translations from '../../translations.ts';
import type { DataStructureLabels } from './terminology.ts';

interface Props {
  object: DataObject;
  columns: DataColumn[];
  page: number;
  perPage: number;
  loading: boolean;
  error: string | null;
  inferred: boolean;
  collections: boolean;
  labels: DataStructureLabels;
  supportsColumnMutations: boolean;
  supportsObjectMutations: boolean;
  readOnly?: boolean;
  onPage: (page: number) => void;
  onAdd: () => void;
  onRenameColumn: (column: string) => void;
  onDeleteColumn: (column: string) => void;
  onRenameObject: () => void;
  onDeleteObject: () => void;
}

export default function ColumnsTable({
  object,
  columns,
  page,
  perPage,
  loading,
  error,
  inferred,
  collections,
  labels,
  supportsColumnMutations,
  supportsObjectMutations,
  readOnly = false,
  onPage,
  onAdd,
  onRenameColumn,
  onDeleteColumn,
  onRenameObject,
  onDeleteObject,
}: Props) {
  const { t } = translations.useTranslations();
  const first = (page - 1) * perPage;
  const visible = columns.slice(first, first + perPage);
  const pagination = { total: columns.length, perPage, page, data: visible };

  return (
    <Card p={0}>
      <Group
        justify='space-between'
        align='flex-start'
        className='border-b border-(--mantine-color-default-border) px-4 py-3'
      >
        <div>
          <Group gap='xs'>
            <Title order={4}>{labels.title}</Title>
            <Badge color='gray'>{columns.length}</Badge>
          </Group>
          <Text size='xs' c='dimmed'>
            {object.namespace ? `${object.namespace}.${object.name}` : object.name} ·{' '}
            {inferred ? labels.inferredDescription : labels.definedDescription}
          </Text>
        </div>
        {!readOnly && (supportsColumnMutations || supportsObjectMutations) && (
          <ServerCan action='databases-everywhere.data-write'>
            <Group gap='xs'>
              {supportsColumnMutations && (
                <Button size='sm' variant='default' onClick={onAdd} leftSection={<FontAwesomeIcon icon={faPlus} />}>
                  {t('server.dataEditor.addColumn', {})}
                </Button>
              )}
              {supportsObjectMutations && (
                <Menu position='bottom-end' withinPortal>
                  <Menu.Target>
                    <ActionIcon variant='default' size='input-sm' aria-label={t('server.dataEditor.details', {})}>
                      <FontAwesomeIcon icon={faEllipsisVertical} />
                    </ActionIcon>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Item leftSection={<FontAwesomeIcon icon={faPen} />} onClick={onRenameObject}>
                      {collections
                        ? t('server.dataEditor.renameCollection', {})
                        : t('server.dataEditor.renameTable', {})}
                    </Menu.Item>
                    <Menu.Item color='red' leftSection={<FontAwesomeIcon icon={faTrash} />} onClick={onDeleteObject}>
                      {collections
                        ? t('server.dataEditor.deleteCollection', {})
                        : t('server.dataEditor.deleteTable', {})}
                    </Menu.Item>
                  </Menu.Dropdown>
                </Menu>
              )}
            </Group>
          </ServerCan>
        )}
      </Group>

      <Table
        flush
        columns={
          inferred
            ? [labels.nameHeader, t('server.dataEditor.observedType', {}), t('server.dataEditor.optionalOrNull', {})]
            : [
                labels.nameHeader,
                t('server.dataEditor.dataType', {}),
                t('server.dataEditor.nullable', {}),
                t('server.dataEditor.key', {}),
                t('server.dataEditor.defaultValue', {}),
                t('server.dataEditor.attributes', {}),
                '',
              ]
        }
        loading={loading}
        error={error}
        pagination={pagination}
      >
        {visible.map((column) => (
          <TableRow key={column.name}>
            <TableData>
              <Text fw={600}>{column.name}</Text>
            </TableData>
            <TableData>
              <Code>{column.data_type}</Code>
            </TableData>
            <TableData>{column.nullable ? t('server.dataEditor.yes', {}) : t('server.dataEditor.no', {})}</TableData>
            {!inferred && (
              <>
                <TableData>
                  {column.primary_key ? <Badge color='blue'>{t('server.dataEditor.primary', {})}</Badge> : '—'}
                </TableData>
                <TableData className='max-w-xs truncate'>
                  {column.default_value ? <Code>{column.default_value}</Code> : '—'}
                </TableData>
                <TableData>{column.extra || '—'}</TableData>
                <TableData className='w-px'>
                  {!readOnly && supportsColumnMutations && (
                    <ServerCan action='databases-everywhere.data-write'>
                      <Menu position='bottom-end' withinPortal>
                        <Menu.Target>
                          <ActionIcon variant='subtle' color='gray' aria-label={t('server.dataEditor.details', {})}>
                            <FontAwesomeIcon icon={faEllipsisVertical} />
                          </ActionIcon>
                        </Menu.Target>
                        <Menu.Dropdown>
                          <Menu.Item
                            leftSection={<FontAwesomeIcon icon={faPen} />}
                            onClick={() => onRenameColumn(column.name)}
                          >
                            {t('server.dataEditor.renameColumn', {})}
                          </Menu.Item>
                          <Menu.Item
                            color='red'
                            leftSection={<FontAwesomeIcon icon={faTrash} />}
                            onClick={() => onDeleteColumn(column.name)}
                          >
                            {t('server.dataEditor.deleteColumn', {})}
                          </Menu.Item>
                        </Menu.Dropdown>
                      </Menu>
                    </ServerCan>
                  )}
                </TableData>
              </>
            )}
          </TableRow>
        ))}
      </Table>
      <Pagination data={pagination} m='xs' onPageSelect={onPage} withShortcuts={false} />
    </Card>
  );
}
