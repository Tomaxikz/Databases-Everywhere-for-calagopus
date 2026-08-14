import type { DataColumn, QueryOutput } from '../../api/types.ts';

function valueType(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'decimal';
  return typeof value;
}

export default function inferColumns(output?: QueryOutput): DataColumn[] {
  if (!output || !Array.isArray(output.columns) || !Array.isArray(output.rows)) return [];
  const columns = output.columns.filter((name): name is string => typeof name === 'string');
  return columns.map((name) => {
    const values = output.rows.map((row) => {
      if (Array.isArray(row)) return row[columns.indexOf(name)];
      if (row && typeof row === 'object') return (row as Record<string, unknown>)[name];
      return undefined;
    });
    const types = [...new Set(values.map(valueType).filter((type): type is string => Boolean(type)))];
    return {
      name,
      data_type: types.join(' | ') || 'dynamic',
      nullable: values.some((value) => value === null || value === undefined),
      primary_key: false,
      default_value: null,
      extra: null,
    };
  });
}
