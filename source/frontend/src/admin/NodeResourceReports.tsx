import { Stack, Text } from '@mantine/core';
import Badge from '@/elements/Badge.tsx';
import Table, { TableData, TableRow } from '@/elements/Table.tsx';
import { formatBytes, formatBytesRate } from '@/lib/chart.ts';
import { diskEnforcementStrength } from '../api/normalizers.ts';
import type { DbevResourceReport } from '../api/types.ts';
import translations from '../translations.ts';

export default function NodeResourceReports({ reports }: { reports: DbevResourceReport[] }) {
  const { t } = translations.useTranslations();

  return (
    <Table
      columns={[
        t('admin.resourceReports.instance', {}),
        t('admin.resourceReports.status', {}),
        t('admin.resourceReports.diskUsage', {}),
        t('admin.resourceReports.enforcement', {}),
        t('admin.resourceReports.scanner', {}),
      ]}
    >
      {reports.map((report) => {
        const disk = report.disk;
        const strength = diskEnforcementStrength(disk);
        const blocked = disk.scanner_restart_blocked === true;
        return (
          <TableRow key={report.instance_id}>
            <TableData>
              <Text fw={600}>{report.instance_id}</Text>
              <Text size='xs' c='dimmed'>
                {report.protocol}
              </Text>
            </TableData>
            <TableData>
              <Badge color={report.status === 'running' ? 'green' : report.status === 'quarantined' ? 'red' : 'gray'}>
                {report.status}
              </Badge>
            </TableData>
            <TableData>
              {formatBytes(disk.used_bytes)} / {formatBytes(disk.limit_bytes)}
            </TableData>
            <TableData>
              <Badge color={blocked ? 'red' : strength === 'hard' ? 'green' : strength === 'soft' ? 'blue' : 'gray'}>
                {blocked
                  ? t('admin.resourceReports.restartBlocked', {})
                  : strength === 'hard'
                    ? t('server.diskEnforcement.hard', {})
                    : strength === 'soft'
                      ? t('server.diskEnforcement.soft', {})
                      : t('server.diskEnforcement.none', {})}
              </Badge>
            </TableData>
            <TableData>
              {strength === 'soft' ? (
                <Stack gap={2}>
                  <OptionalMetric
                    label={t('server.diskEnforcement.physicalUsage', {})}
                    value={optionalFormat(disk.scanner_physical_bytes, formatBytes)}
                  />
                  <OptionalMetric
                    label={t('server.diskEnforcement.currentGrowth', {})}
                    value={optionalFormat(disk.scanner_growth_bytes_per_second, formatBytesRate)}
                  />
                </Stack>
              ) : (
                '—'
              )}
            </TableData>
          </TableRow>
        );
      })}
    </Table>
  );
}

function optionalFormat(value: unknown, formatter: (value: number) => string): string {
  return typeof value === 'number' && Number.isFinite(value) ? formatter(value) : '—';
}

function OptionalMetric({ label, value }: { label: string; value: string }) {
  return (
    <Text size='xs'>
      <Text component='span' c='dimmed'>
        {label}:{' '}
      </Text>
      {value}
    </Text>
  );
}
