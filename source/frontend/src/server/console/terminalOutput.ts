import type { DatabaseProtocol, QueryOutput } from '../../api/types.ts';

export type TerminalOutputKind = 'empty' | 'table' | 'text';

export interface ParsedTerminalOutput {
  kind: TerminalOutputKind;
  content: string;
  rowCount: number;
  affectedRows: number | null;
  elapsedMs: number;
  truncated: boolean;
}

export function parseTerminalOutput(protocol: DatabaseProtocol, output: QueryOutput): ParsedTerminalOutput {
  const rows = Array.isArray(output.rows) ? output.rows : [];
  const columns = outputColumns(output.columns, rows);
  let kind: TerminalOutputKind = 'empty';
  let content = '';

  if (rows.length > 0 && (protocol === 'redis' || protocol === 'valkey')) {
    const value = rows.length === 1 ? rowValue(rows[0], columns[0] ?? 'result', 0) : rows;
    kind = 'text';
    content = formatRedisValue(value);
  } else if (rows.length > 0 && protocol === 'mongodb') {
    kind = 'text';
    content = prettyJson(rows.length === 1 ? rows[0] : rows);
  } else if (rows.length > 0 && columns.length > 0) {
    kind = 'table';
    content = asciiTable(columns, rows);
  } else if (rows.length > 0) {
    kind = 'text';
    content = prettyJson(rows.length === 1 ? rows[0] : rows);
  }

  return {
    kind,
    content,
    rowCount: rows.length,
    affectedRows: output.affected_rows,
    elapsedMs: output.elapsed_ms,
    truncated: output.truncated,
  };
}

export function terminalPrompt(protocol: DatabaseProtocol, databaseName: string): string {
  const name = compactPromptName(databaseName);
  switch (protocol) {
    case 'postgres':
      return `${name}=#`;
    case 'mysql':
      return `mysql [${name}]>`;
    case 'mariadb':
      return `MariaDB [${name}]>`;
    case 'redis':
      return `redis [${name}]>`;
    case 'valkey':
      return `valkey [${name}]>`;
    case 'mongodb':
      return `${name}>`;
    case 'clickhouse':
      return `${name} :)`;
    case 'qdrant':
      return `qdrant [${name}]>`;
  }
}

/** Prevent database values from injecting terminal control sequences. */
export function safeTerminalText(value: string): string {
  return Array.from(value, (character) => {
    if (character === '\n' || character === '\t') return character;
    const code = character.codePointAt(0) ?? 0;
    return code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f) ? character : '\ufffd';
  }).join('');
}

function outputColumns(columns: string[], rows: unknown[]): string[] {
  if (Array.isArray(columns) && columns.length > 0) return unique(columns);

  const discovered: string[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    for (const key of Object.keys(row)) {
      if (!discovered.includes(key)) discovered.push(key);
    }
  }
  if (discovered.length > 0) return discovered;
  return rows.length > 0 ? ['value'] : [];
}

function asciiTable(columns: string[], rows: unknown[]): string {
  const values = rows.map((row) => columns.map((column, index) => formatCell(rowValue(row, column, index))));
  const widths = columns.map((column, index) =>
    Math.max(column.length, ...values.map((row) => row[index]?.length ?? 0)),
  );
  const border = `+${widths.map((width) => '-'.repeat(width + 2)).join('+')}+`;
  const header = `| ${columns.map((column, index) => column.padEnd(widths[index] ?? column.length)).join(' | ')} |`;
  const body = values.map(
    (row) => `| ${row.map((value, index) => value.padEnd(widths[index] ?? value.length)).join(' | ')} |`,
  );
  return [border, header, border, ...body, border].join('\n');
}

function rowValue(row: unknown, column: string, index: number): unknown {
  if (Array.isArray(row)) return row[index];
  if (!isRecord(row)) return index === 0 ? row : undefined;
  if (Object.hasOwn(row, column)) return row[column];

  const caseInsensitiveKey = Object.keys(row).find((key) => key.toLowerCase() === column.toLowerCase());
  return caseInsensitiveKey ? row[caseInsensitiveKey] : undefined;
}

function formatCell(value: unknown): string {
  if (value === null) return 'NULL';
  if (value === undefined) return '';
  if (typeof value === 'string') return value.replace(/\r\n?/g, '\n').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
  if (typeof value === 'object') return compactJson(value);
  return String(value);
}

function formatRedisValue(value: unknown): string {
  if (value === null || value === undefined) return '(nil)';
  if (typeof value === 'string') return value ? value.replace(/\r\n?/g, '\n') : '(empty string)';
  if (typeof value === 'number') return Number.isInteger(value) ? `(integer) ${value}` : String(value);
  if (typeof value === 'boolean') return value ? '(boolean) true' : '(boolean) false';
  if (!Array.isArray(value)) return prettyJson(value);
  if (value.length === 0) return '(empty array)';

  return value
    .flatMap((item, index) => {
      const prefix = `${index + 1}) `;
      const lines = formatRedisValue(item).split('\n');
      return [`${prefix}${lines[0] ?? ''}`, ...lines.slice(1).map((line) => `${' '.repeat(prefix.length)}${line}`)];
    })
    .join('\n');
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function compactPromptName(value: string): string {
  const compact = value.replace(/[\r\n\t]+/g, ' ').trim() || 'database';
  return compact.length > 40 ? `${compact.slice(0, 37)}…` : compact;
}

function unique(values: string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
