import { Group, Text } from '@mantine/core';
import Code from '@/elements/Code.tsx';
import { TableData, TableRow } from '@/elements/Table.tsx';
import TableLink from '@/elements/TableLink.tsx';
import type { NodeRecord } from '../api/types.ts';
import { formatTimestamp, StatusBadge } from '../components/common.tsx';
import translations from '../translations.ts';

export default function NodeTableRow({ node }: { node: NodeRecord }) {
  const { t } = translations.useTranslations();
  const status = !node.enabled ? 'disabled' : node.last_error ? 'failed' : 'healthy';

  return (
    <TableRow>
      <TableData>
        <TableLink to={`?node=${node.uuid}`}>
          <Group gap={4} wrap='nowrap'>
            <Text fw={500}>{node.name}</Text>
          </Group>
        </TableLink>
        <Text size='xs' c='dimmed'>
          {node.api_url}
        </Text>
      </TableData>
      <TableData>
        <Code>{node.uuid}</Code>
      </TableData>
      <TableData>
        <StatusBadge status={status} />
        {node.last_error && (
          <Text c='red' size='xs' maw={260} lineClamp={1} mt={4}>
            {node.last_error}
          </Text>
        )}
      </TableData>
      <TableData>
        {node.default_cpu_cores} CPU · {node.default_memory_mib} MiB · {node.default_disk_mib} MiB
      </TableData>
      <TableData>{node.last_seen ? formatTimestamp(node.last_seen) : t('admin.never', {})}</TableData>
    </TableRow>
  );
}
