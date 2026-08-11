export type DataValueKind =
  | 'missing'
  | 'null'
  | 'string'
  | 'number'
  | 'boolean'
  | 'object-id'
  | 'date'
  | 'array'
  | 'object';

export interface DataValueDescription {
  kind: DataValueKind;
  text: string;
  title: string;
  count?: number;
}

const TITLE_LIMIT = 1200;
const PREVIEW_LIMIT = 72;

export default function describeDataValue(value: unknown): DataValueDescription {
  if (value === undefined) return { kind: 'missing', text: '', title: '' };
  if (value === null) return { kind: 'null', text: '', title: 'null' };
  if (typeof value === 'string') return { kind: 'string', text: value, title: value };
  if (typeof value === 'number') return { kind: 'number', text: String(value), title: String(value) };
  if (typeof value === 'boolean') return { kind: 'boolean', text: String(value), title: String(value) };

  if (Array.isArray(value)) {
    return {
      kind: 'array',
      text: collectionPreview(value),
      title: stringifyForTitle(value),
      count: value.length,
    };
  }

  if (isRecord(value)) {
    const objectId = singleStringField(value, '$oid');
    if (objectId !== null) {
      return { kind: 'object-id', text: objectId, title: objectId };
    }

    const extendedDate = dateField(value);
    if (extendedDate !== null) {
      return { kind: 'date', text: extendedDate, title: stringifyForTitle(value) };
    }

    const extendedNumber = extendedNumberField(value);
    if (extendedNumber !== null) {
      return { kind: 'number', text: extendedNumber, title: stringifyForTitle(value) };
    }

    const entries = Object.entries(value);
    return {
      kind: 'object',
      text: objectPreview(entries),
      title: stringifyForTitle(value),
      count: entries.length,
    };
  }

  const text = String(value);
  return { kind: 'string', text, title: text };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function singleStringField(value: Record<string, unknown>, field: string): string | null {
  const entries = Object.entries(value);
  return entries.length === 1 && entries[0][0] === field && typeof entries[0][1] === 'string' ? entries[0][1] : null;
}

function dateField(value: Record<string, unknown>): string | null {
  if (Object.keys(value).length !== 1 || !('$date' in value)) return null;
  const date = value.$date;
  if (typeof date === 'string' || typeof date === 'number') return String(date);
  return isRecord(date) ? singleStringField(date, '$numberLong') : null;
}

function extendedNumberField(value: Record<string, unknown>): string | null {
  for (const key of ['$numberInt', '$numberLong', '$numberDouble', '$numberDecimal']) {
    const number = singleStringField(value, key);
    if (number !== null) return number;
  }
  return null;
}

function collectionPreview(values: readonly unknown[]): string {
  if (!values.length) return '';
  const preview = values.slice(0, 3).map(compactValue).join(', ');
  return truncate(`${preview}${values.length > 3 ? ', …' : ''}`, PREVIEW_LIMIT);
}

function objectPreview(entries: readonly [string, unknown][]): string {
  if (!entries.length) return '';
  const preview = entries
    .slice(0, 3)
    .map(([key, value]) => `${key}: ${compactValue(value)}`)
    .join(' · ');
  return truncate(`${preview}${entries.length > 3 ? ' · …' : ''}`, PREVIEW_LIMIT);
}

function compactValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return '—';
  if (typeof value === 'string') return truncate(JSON.stringify(value), 28);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.length}]`;
  if (isRecord(value)) return `{${Object.keys(value).length}}`;
  return truncate(String(value), 28);
}

function stringifyForTitle(value: unknown): string {
  try {
    return truncate(JSON.stringify(value) ?? String(value), TITLE_LIMIT);
  } catch {
    return truncate(String(value), TITLE_LIMIT);
  }
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}
