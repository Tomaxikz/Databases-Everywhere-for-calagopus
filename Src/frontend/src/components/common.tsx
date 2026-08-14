import { Table as MantineTable, ScrollArea, Text } from '@mantine/core';
import Badge from '@/elements/Badge.tsx';
import Code from '@/elements/Code.tsx';
import type { QueryOutput } from '../api/types.ts';

export function statusColor(status?: string): string {
  switch ((status || '').toLowerCase()) {
    case 'running':
    case 'succeeded':
    case 'success':
    case 'healthy':
    case 'enabled':
    case 'ready':
      return 'green';
    case 'creating':
    case 'queued':
    case 'starting':
    case 'stopping':
    case 'running_job':
      return 'blue';
    case 'failed':
    case 'error':
    case 'quarantined':
      return 'red';
    case 'stopped':
    case 'offline':
    case 'disabled':
    case 'paused':
      return 'gray';
    default:
      return 'yellow';
  }
}

export function StatusBadge({ status }: { status?: string | null }) {
  return <Badge color={statusColor(status || undefined)}>{status || 'unknown'}</Badge>;
}

export function JsonView({ value, maxHeight = 420 }: { value: unknown; maxHeight?: number }) {
  return (
    <ScrollArea h={maxHeight} type='auto'>
      <Code block className='whitespace-pre-wrap break-all text-xs'>
        {JSON.stringify(value, null, 2)}
      </Code>
    </ScrollArea>
  );
}

export function QueryResultTable({
  output,
  onRowSelect,
  selectedRowIndex,
}: {
  output: QueryOutput;
  onRowSelect?: (row: unknown, index: number) => void;
  selectedRowIndex?: number | null;
}) {
  if (!output.columns.length && !output.rows.length) {
    return <Text c='dimmed'>{output.affected_rows ?? 0} row(s) affected.</Text>;
  }

  return (
    <ScrollArea type='auto' mah={520}>
      <MantineTable striped highlightOnHover withTableBorder withColumnBorders>
        <MantineTable.Thead>
          <MantineTable.Tr>
            {output.columns.map((column) => (
              <MantineTable.Th key={column}>{column}</MantineTable.Th>
            ))}
          </MantineTable.Tr>
        </MantineTable.Thead>
        <MantineTable.Tbody>
          {output.rows.map((row, rowIndex) => {
            const record =
              row && typeof row === 'object' && !Array.isArray(row) ? (row as Record<string, unknown>) : {};
            const values = Array.isArray(row) ? row : output.columns.map((column) => record[column]);
            return (
              <MantineTable.Tr
                key={rowIndex}
                onClick={onRowSelect ? () => onRowSelect(row, rowIndex) : undefined}
                bg={selectedRowIndex === rowIndex ? 'var(--mantine-color-blue-light)' : undefined}
                style={onRowSelect ? { cursor: 'pointer' } : undefined}
                aria-selected={selectedRowIndex === rowIndex}
              >
                {output.columns.map((column, columnIndex) => (
                  <MantineTable.Td key={`${rowIndex}-${column}`}>
                    <Code>{formatCell(values[columnIndex])}</Code>
                  </MantineTable.Td>
                ))}
              </MantineTable.Tr>
            );
          })}
        </MantineTable.Tbody>
      </MantineTable>
    </ScrollArea>
  );
}

function formatCell(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function recordsFromResult(value: unknown, keys: string[]): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];
  for (const key of keys) {
    const nested = value[key];
    if (Array.isArray(nested)) return nested.filter(isRecord);
  }
  return [];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function recordId(record: Record<string, unknown>, keys = ['id', 'job_id', 'artifact_id']): string {
  for (const key of keys) {
    if (typeof record[key] === 'string') return record[key] as string;
  }
  return '';
}

export function formatBytes(value: unknown): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let size = bytes;
  let unit = -1;
  do {
    size /= 1024;
    unit += 1;
  } while (size >= 1024 && unit < units.length - 1);
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unit]}`;
}

export function formatTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

export function logsToText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value))
    return value.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n');
  if (isRecord(value)) {
    for (const key of ['logs', 'lines', 'output']) {
      if (key in value) return logsToText(value[key]);
    }
  }
  return JSON.stringify(value, null, 2);
}
