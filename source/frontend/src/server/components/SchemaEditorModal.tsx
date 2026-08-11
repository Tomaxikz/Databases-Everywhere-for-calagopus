import { faPlus, faTrash } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Checkbox, Group, SimpleGrid, Stack, Text } from '@mantine/core';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import ActionIcon from '@/elements/ActionIcon.tsx';
import Button from '@/elements/Button.tsx';
import Card from '@/elements/Card.tsx';
import Select from '@/elements/input/Select.tsx';
import TextInput from '@/elements/input/TextInput.tsx';
import { Modal, ModalFooter } from '@/elements/modals/Modal.tsx';
import type { DatabaseProtocol, SchemaColumnInput, SchemaColumnType, SchemaMutationInput } from '../../api/types.ts';
import translations from '../../translations.ts';

type Mode = 'create-object' | 'rename-object' | 'add-column' | 'rename-column' | 'delete-column';

const TYPES: { value: SchemaColumnType; label: string }[] = [
  { value: 'bigint', label: 'Big integer' },
  { value: 'integer', label: 'Integer' },
  { value: 'varchar', label: 'Short text (255)' },
  { value: 'text', label: 'Long text' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'decimal', label: 'Decimal' },
  { value: 'json', label: 'JSON' },
  { value: 'uuid', label: 'UUID' },
  { value: 'date', label: 'Date' },
  { value: 'timestamp', label: 'Timestamp' },
];

interface DraftColumn extends SchemaColumnInput {
  id: number;
}

function columnDraft(id: number, primary = false, autoIncrement = false): DraftColumn {
  return {
    id,
    name: primary ? 'id' : '',
    data_type: primary ? 'bigint' : 'varchar',
    nullable: false,
    primary_key: primary,
    auto_increment: autoIncrement,
  };
}

export default function SchemaEditorModal({
  opened,
  onClose,
  mode,
  protocol,
  namespace,
  object,
  columns,
  initialColumn,
  loading,
  onSubmit,
}: {
  opened: boolean;
  onClose: () => void;
  mode: Mode;
  protocol: DatabaseProtocol;
  namespace?: string | null;
  object?: string;
  columns: string[];
  initialColumn?: string | null;
  loading: boolean;
  onSubmit: (input: SchemaMutationInput) => Promise<void>;
}) {
  const { t } = translations.useTranslations();
  const nextColumnId = useRef(2);
  const [objectName, setObjectName] = useState('');
  const [columnName, setColumnName] = useState('id');
  const [newName, setNewName] = useState('');
  const [draftColumns, setDraftColumns] = useState<DraftColumn[]>([columnDraft(1, true, protocol !== 'clickhouse')]);
  const [error, setError] = useState<string | null>(null);
  const mongo = protocol === 'mongodb';
  const editsColumns = !mongo && (mode === 'create-object' || mode === 'add-column');

  useEffect(() => {
    if (!opened) return;
    setObjectName('');
    setColumnName(mode === 'delete-column' || mode === 'rename-column' ? (initialColumn ?? columns[0] ?? '') : 'id');
    setNewName('');
    nextColumnId.current = 2;
    setDraftColumns([columnDraft(1, mode === 'create-object', mode === 'create-object' && protocol !== 'clickhouse')]);
    setError(null);
  }, [columns, initialColumn, mode, opened, protocol]);

  const updateDraft = (id: number, patch: Partial<SchemaColumnInput>) => {
    setDraftColumns((current) =>
      current.map((column) => {
        if (column.id !== id) {
          return {
            ...column,
            ...(patch.primary_key ? { primary_key: false } : {}),
            ...(patch.auto_increment ? { auto_increment: false } : {}),
          };
        }
        const updated = { ...column, ...patch };
        if (patch.data_type && !['integer', 'bigint'].includes(patch.data_type) && updated.auto_increment) {
          updated.auto_increment = false;
        }
        return updated;
      }),
    );
  };

  const addDraft = () => {
    if (draftColumns.length >= 64) return;
    const id = nextColumnId.current++;
    setDraftColumns((current) => [...current, columnDraft(id)]);
  };

  const removeDraft = (id: number) => {
    setDraftColumns((current) => (current.length === 1 ? current : current.filter((column) => column.id !== id)));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const target = mode === 'create-object' ? objectName.trim() : object;
    if (!target) return;
    const submittedColumns = editsColumns
      ? draftColumns.map(({ id: _id, ...column }) => ({ ...column, name: column.name.trim() }))
      : [];
    if (submittedColumns.some((column) => !column.name)) {
      setError(t('server.dataEditor.columnNameRequired', {}));
      return;
    }
    if (new Set(submittedColumns.map((column) => column.name.toLowerCase())).size !== submittedColumns.length) {
      setError(t('server.dataEditor.columnNamesUnique', {}));
      return;
    }
    try {
      const column =
        mongo || mode === 'rename-object' || editsColumns
          ? undefined
          : {
              name: columnName.trim(),
              data_type: 'bigint' as SchemaColumnType,
              nullable: false,
              primary_key: false,
              auto_increment: false,
            };
      await onSubmit({
        operation:
          mode === 'create-object'
            ? 'create_object'
            : mode === 'rename-object'
              ? 'rename_object'
              : mode === 'add-column'
                ? 'add_column'
                : mode === 'rename-column'
                  ? 'rename_column'
                  : 'delete_column',
        namespace,
        object: target,
        column,
        columns: submittedColumns.length ? submittedColumns : undefined,
        new_name: mode === 'rename-object' || mode === 'rename-column' ? newName.trim() : undefined,
        confirm: mode === 'delete-column',
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const title =
    mode === 'create-object'
      ? mongo
        ? t('server.dataEditor.newCollection', {})
        : t('server.dataEditor.newTable', {})
      : mode === 'rename-object'
        ? mongo
          ? t('server.dataEditor.renameCollection', {})
          : t('server.dataEditor.renameTable', {})
        : mode === 'add-column'
          ? 'Add column'
          : mode === 'rename-column'
            ? 'Rename column'
            : 'Delete column';

  return (
    <Modal opened={opened} onClose={onClose} title={title} size='lg'>
      <form onSubmit={submit}>
        <Stack>
          {mode === 'create-object' && (
            <TextInput
              label={mongo ? t('server.dataEditor.collectionName', {}) : t('server.dataEditor.tableName', {})}
              value={objectName}
              onChange={(event) => setObjectName(event.currentTarget.value)}
              required
            />
          )}
          {mode === 'rename-object' && (
            <TextInput
              label={mongo ? t('server.dataEditor.newCollectionName', {}) : t('server.dataEditor.newTableName', {})}
              value={newName}
              onChange={(event) => setNewName(event.currentTarget.value)}
              required
            />
          )}
          {!mongo && (mode === 'delete-column' || mode === 'rename-column') ? (
            <Stack>
              <Select
                label='Column'
                data={columns.map((column) => ({ value: column, label: column }))}
                value={columnName}
                onChange={(value) => setColumnName(value || '')}
                required
              />
              {mode === 'rename-column' && (
                <TextInput
                  label='New column name'
                  value={newName}
                  onChange={(event) => setNewName(event.currentTarget.value)}
                  required
                />
              )}
            </Stack>
          ) : editsColumns ? (
            <Stack gap='sm'>
              <Group justify='space-between' align='center'>
                <div>
                  <Text fw={600}>{t('server.dataEditor.columnDefinitions', {})}</Text>
                  <Text size='xs' c='dimmed'>
                    {t('server.dataEditor.columnDefinitionsDescription', {})}
                  </Text>
                </div>
                <Button
                  type='button'
                  size='compact-sm'
                  variant='default'
                  disabled={draftColumns.length >= 64}
                  leftSection={<FontAwesomeIcon icon={faPlus} />}
                  onClick={addDraft}
                >
                  {t('server.dataEditor.addAnotherColumn', {})}
                </Button>
              </Group>
              <Stack gap='sm' className='max-h-[55vh] overflow-y-auto pr-1'>
                {draftColumns.map((column, index) => (
                  <Card key={column.id} p='sm'>
                    <Stack gap='sm'>
                      <Group justify='space-between'>
                        <Text size='sm' fw={600}>
                          {t('server.dataEditor.columnNumber', { number: index + 1 })}
                        </Text>
                        <ActionIcon
                          type='button'
                          variant='subtle'
                          color='red'
                          disabled={draftColumns.length === 1}
                          aria-label={t('server.dataEditor.removeColumn', { number: index + 1 })}
                          onClick={() => removeDraft(column.id)}
                        >
                          <FontAwesomeIcon icon={faTrash} />
                        </ActionIcon>
                      </Group>
                      <SimpleGrid cols={{ base: 1, sm: 2 }}>
                        <TextInput
                          label={t('server.dataEditor.columnName', {})}
                          value={column.name}
                          onChange={(event) => updateDraft(column.id, { name: event.currentTarget.value })}
                          required
                        />
                        <Select
                          label={t('server.dataEditor.columnType', {})}
                          data={TYPES}
                          value={column.data_type}
                          onChange={(value) =>
                            value && updateDraft(column.id, { data_type: value as SchemaColumnType })
                          }
                          required
                        />
                      </SimpleGrid>
                      <SimpleGrid cols={{ base: 1, sm: 3 }}>
                        <Checkbox
                          checked={column.nullable}
                          onChange={(event) => updateDraft(column.id, { nullable: event.currentTarget.checked })}
                          label={t('server.dataEditor.allowNull', {})}
                        />
                        <Checkbox
                          checked={column.primary_key}
                          onChange={(event) => updateDraft(column.id, { primary_key: event.currentTarget.checked })}
                          label={t('server.dataEditor.primaryKey', {})}
                        />
                        <Checkbox
                          checked={column.auto_increment}
                          disabled={protocol === 'clickhouse' || !['integer', 'bigint'].includes(column.data_type)}
                          onChange={(event) => updateDraft(column.id, { auto_increment: event.currentTarget.checked })}
                          label={t('server.dataEditor.autoIncrement', {})}
                        />
                      </SimpleGrid>
                    </Stack>
                  </Card>
                ))}
              </Stack>
            </Stack>
          ) : null}
          {mode === 'delete-column' && (
            <Text size='sm' c='red'>
              Deleting a column permanently removes all values stored in it.
            </Text>
          )}
          {error && (
            <Text size='sm' c='red'>
              {error}
            </Text>
          )}
        </Stack>
        <ModalFooter>
          <Button
            type='submit'
            color={mode === 'delete-column' ? 'red' : undefined}
            loading={loading}
            disabled={
              mode === 'create-object'
                ? !objectName.trim() || draftColumns.some((column) => !column.name.trim())
                : !object ||
                  (!mongo && mode !== 'rename-object' && !editsColumns && !columnName.trim()) ||
                  (editsColumns && draftColumns.some((column) => !column.name.trim())) ||
                  ((mode === 'rename-object' || mode === 'rename-column') && !newName.trim())
            }
          >
            {title}
          </Button>
          <Button variant='default' onClick={onClose}>
            Cancel
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
