import { SimpleGrid, Stack, Text } from '@mantine/core';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import Button from '@/elements/Button.tsx';
import TextInput from '@/elements/input/TextInput.tsx';
import { Modal, ModalFooter } from '@/elements/modals/Modal.tsx';
import type { DatabaseProtocol } from '../../api/types.ts';
import translations from '../../translations.ts';
import type { DataRecordLabels } from '../data-editor/terminology.ts';
import {
  type VisualValueNode,
  VisualValueValidationError,
  visualValueRoot,
  visualValueToJson,
} from '../data-editor/valueBuilder.ts';
import VisualObjectBuilder from './VisualObjectBuilder.tsx';

const structuredProtocols: DatabaseProtocol[] = ['postgres', 'mysql', 'mariadb', 'clickhouse'];

export default function RecordEditorModal({
  opened,
  onClose,
  protocol,
  labels,
  columns,
  value,
  mode,
  loading,
  onSave,
}: {
  opened: boolean;
  onClose: () => void;
  protocol: DatabaseProtocol;
  labels: DataRecordLabels;
  columns: string[];
  value: unknown;
  mode: 'insert' | 'update';
  loading: boolean;
  onSave: (value: unknown) => Promise<void>;
}) {
  const { t } = translations.useTranslations();
  const structured = structuredProtocols.includes(protocol);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [visualValue, setVisualValue] = useState<VisualValueNode>(() => visualValueRoot({}));
  const [error, setError] = useState<string | null>(null);

  const normalizedColumns = useMemo(() => {
    if (columns.length) return columns;
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.keys(value) : [];
  }, [columns, value]);

  useEffect(() => {
    if (!opened) return;
    const record =
      typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    setFields(
      Object.fromEntries(
        normalizedColumns.map((column) => [
          column,
          record[column] === null || record[column] === undefined
            ? ''
            : typeof record[column] === 'string'
              ? String(record[column])
              : JSON.stringify(record[column]),
        ]),
      ),
    );
    const source = mode === 'insert' ? { ...defaultVisualValue(protocol), ...record } : record;
    setVisualValue(visualValueRoot(source, lockedIdentityKeys(protocol, mode)));
    setError(null);
  }, [mode, normalizedColumns, opened, protocol, value]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const next = structured
        ? Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, parseField(field)]))
        : visualValueToJson(visualValue);
      setError(null);
      await onSave(next);
    } catch (cause) {
      if (cause instanceof VisualValueValidationError) {
        switch (cause.code) {
          case 'field-name-required':
            setError(t('server.dataEditor.valueBuilder.errors.fieldNameRequired', { path: cause.path }));
            break;
          case 'duplicate-field':
            setError(
              t('server.dataEditor.valueBuilder.errors.duplicateField', {
                field: cause.field ?? '',
                path: cause.path,
              }),
            );
            break;
          case 'invalid-number':
            setError(t('server.dataEditor.valueBuilder.errors.invalidNumber', { path: cause.path }));
            break;
        }
      } else {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title={mode === 'insert' ? labels.createTitle : labels.edit} size='xl'>
      <form onSubmit={submit}>
        <Stack>
          {structured ? (
            <SimpleGrid cols={{ base: 1, md: 2 }}>
              {normalizedColumns.map((column) => (
                <TextInput
                  key={column}
                  label={column}
                  value={fields[column] ?? ''}
                  onChange={(event) => {
                    const nextValue = event.currentTarget.value;
                    setFields((current) => ({ ...current, [column]: nextValue }));
                  }}
                  placeholder='NULL'
                />
              ))}
            </SimpleGrid>
          ) : (
            <VisualObjectBuilder root={visualValue} onChange={setVisualValue} />
          )}
          {error && (
            <Text size='sm' c='red'>
              {error}
            </Text>
          )}
        </Stack>
        <ModalFooter>
          <Button type='submit' loading={loading}>
            {labels.save}
          </Button>
          <Button variant='default' onClick={onClose}>
            {t('common.cancel', {})}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

function defaultVisualValue(protocol: DatabaseProtocol): Record<string, unknown> {
  if (protocol === 'qdrant') return { id: '', vector: [], payload: {} };
  if (protocol === 'redis' || protocol === 'valkey') return { type: 'string', value: '' };
  return {};
}

function lockedIdentityKeys(protocol: DatabaseProtocol, mode: 'insert' | 'update'): string[] {
  if (mode !== 'update') return [];
  if (protocol === 'mongodb') return ['_id'];
  if (protocol === 'qdrant') return ['id'];
  return [];
}

function parseField(value: string): unknown {
  if (!value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
