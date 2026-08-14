import { Group, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import Alert from '@/elements/Alert.tsx';
import Badge from '@/elements/Badge.tsx';
import Card from '@/elements/Card.tsx';
import Progress from '@/elements/Progress.tsx';
import { bytesToString } from '@/lib/size.ts';
import type { DatabaseProtocol, DbevNodeResourceSummary, DbevSystemResponse } from '../api/types.ts';
import { formatTimestamp } from '../components/common.tsx';
import { protocolLabels } from '../components/protocols.ts';
import translations from '../translations.ts';

interface Props {
  system: DbevSystemResponse | null;
  resources: DbevNodeResourceSummary | null;
}

type RuntimeTranslation = ReturnType<typeof translations.useTranslations>['t'];

const protocolFlags: Array<[DatabaseProtocol, keyof DbevSystemResponse]> = [
  ['postgres', 'postgres_enabled'],
  ['mysql', 'mysql_enabled'],
  ['mariadb', 'mariadb_enabled'],
  ['redis', 'redis_enabled'],
  ['valkey', 'valkey_enabled'],
  ['mongodb', 'mongodb_enabled'],
  ['clickhouse', 'clickhouse_enabled'],
  ['qdrant', 'qdrant_enabled'],
];

export default function NodeRuntimeOverview({ system, resources }: Props) {
  return (
    <SimpleGrid cols={{ base: 1, xl: 2 }}>
      <DaemonStatusCard system={system} />
      <CapacityCard resources={resources} />
    </SimpleGrid>
  );
}

function DaemonStatusCard({ system }: { system: DbevSystemResponse | null }) {
  const { t } = translations.useTranslations();
  const report = system as Partial<DbevSystemResponse> | null;
  const gateways = report?.gateways;
  const gatewayPercent = percentage(gateways?.ready_listeners, gateways?.expected_listeners);
  const enabledProtocols = protocolFlags.filter(([, flag]) => report?.[flag] === true).map(([protocol]) => protocol);
  const predictiveDiskEnforcement = report?.disk_mode === 'soft_scanner' || report?.disk_mode === 'none';

  return (
    <Card>
      <Group justify='space-between' align='flex-start' mb='lg'>
        <div>
          <Title order={4}>{t('admin.runtimeOverview.daemon', {})}</Title>
          <Text size='xs' c='dimmed'>
            {t('admin.runtimeOverview.daemonDescription', {})}
          </Text>
        </div>
        <Badge color={report?.api_readiness === 'ready' ? 'green' : 'gray'} variant='light'>
          {report?.api_readiness ?? t('admin.notSampled', {})}
        </Badge>
      </Group>

      {!report ? (
        <EmptySample t={t} />
      ) : (
        <Stack gap='lg'>
          {gatewayReadinessMessage(gateways) && (
            <Alert color={gateways?.status === 'failed' ? 'red' : 'yellow'}>{gatewayReadinessMessage(gateways)}</Alert>
          )}
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing='lg'>
            <Metric
              label={t('admin.runtimeOverview.daemonVersion', {})}
              value={report.version ? `v${report.version}` : '—'}
              detail={report.api_version ? `API ${report.api_version}` : undefined}
            />
            <Metric
              label={t('admin.runtimeOverview.containerRuntime', {})}
              value={titleCase(report.daemon_engine)}
              detail={report.database_backend_transport?.replaceAll('_', ' ')}
            />
          </SimpleGrid>

          <StatusRow
            label={t('admin.runtimeOverview.managementApi', {})}
            value={report.api_bind || formatApiBind(report)}
            badge={
              report.api_ssl_enabled
                ? t('admin.runtimeOverview.tlsEnabled', {})
                : t('admin.runtimeOverview.tlsDisabled', {})
            }
            badgeColor={report.api_ssl_enabled ? 'green' : 'yellow'}
          />

          <Stack gap={6}>
            <Group justify='space-between' align='flex-end'>
              <div>
                <Text size='sm' fw={600}>
                  {t('admin.runtimeOverview.gatewayReadiness', {})}
                </Text>
                <Text size='xs' c='dimmed'>
                  {gateways
                    ? t('admin.runtimeOverview.listenersReady', {
                        ready: gateways.ready_listeners,
                        expected: gateways.expected_listeners,
                      })
                    : '—'}
                </Text>
              </div>
              <Badge color={gatewayStatusColor(gateways?.status)} variant='light'>
                {gateways?.status ?? t('admin.notSampled', {})}
              </Badge>
            </Group>
            <Progress
              value={gatewayPercent}
              color={gatewayStatusColor(gateways?.status)}
              hourglass={false}
              withLabel={gateways !== undefined}
            />
            {gateways?.failure && (
              <Text size='xs' c='red'>
                {gateways.failure}
              </Text>
            )}
          </Stack>

          <div>
            <Text size='sm' fw={600} mb={6}>
              {t('admin.runtimeOverview.databaseGateways', {})}
            </Text>
            {enabledProtocols.length ? (
              <Group gap='xs'>
                {enabledProtocols.map((protocol) => (
                  <Badge key={protocol} color='blue' variant='light'>
                    {protocolLabels[protocol]}
                  </Badge>
                ))}
                {report.clickhouse_http_enabled && (
                  <Badge color='cyan' variant='light'>
                    ClickHouse HTTP
                  </Badge>
                )}
              </Group>
            ) : (
              <Text size='xs' c='dimmed'>
                {t('admin.runtimeOverview.noGateways', {})}
              </Text>
            )}
          </div>

          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing='lg'>
            <BooleanMetric
              label={t('admin.runtimeOverview.remoteImports', {})}
              enabled={report.remote_import_enabled === true}
              t={t}
            />
            <BooleanMetric
              label={t('admin.runtimeOverview.diskQuotas', {})}
              enabled={report.daemon_disk_limits_enforced === true || predictiveDiskEnforcement}
              trueLabel={
                predictiveDiskEnforcement
                  ? t('admin.runtimeOverview.predictiveEnforcement', {})
                  : t('admin.runtimeOverview.enforced', {})
              }
              falseLabel={t('admin.runtimeOverview.notEnforced', {})}
              t={t}
              detail={report.disk_mode}
            />
          </SimpleGrid>
          <Text size='xs' c='dimmed'>
            {t('admin.runtimeOverview.instanceDiskAuthority', {})}
          </Text>
        </Stack>
      )}
    </Card>
  );
}

export function gatewayReadinessMessage(gateways: DbevSystemResponse['gateways'] | null | undefined): string | null {
  if (gateways?.status === 'starting') {
    return 'The DBEV management API is ready, but database listeners are still starting.';
  }
  if (gateways?.status === 'failed') {
    const failure = gateways.failure?.trim() || 'the daemon did not report a listener failure reason';
    return `DBEV is running, but one or more database gateways failed: ${failure}`;
  }
  return null;
}

function CapacityCard({ resources }: { resources: DbevNodeResourceSummary | null }) {
  const { t } = translations.useTranslations();
  const report = resources as Partial<DbevNodeResourceSummary> | null;
  const summary = isCompleteResourceSummary(report) ? report : null;

  return (
    <Card>
      <Group justify='space-between' align='flex-start' mb='lg'>
        <div>
          <Title order={4}>{t('admin.runtimeOverview.capacity', {})}</Title>
          <Text size='xs' c='dimmed'>
            {t('admin.runtimeOverview.capacityDescription', {})}
          </Text>
        </div>
        <Text size='xs' c='dimmed'>
          {report?.sampled_at
            ? t('admin.runtimeOverview.sampledAt', { time: formatTimestamp(report.sampled_at) })
            : t('admin.notSampled', {})}
        </Text>
      </Group>

      {!summary ? (
        <EmptySample t={t} />
      ) : (
        <Stack gap='lg'>
          <CapacityBar
            label={t('admin.runtimeOverview.cpuReservations', {})}
            value={summary.cpu.allocated_cores}
            limit={summary.cpu.total_cores}
            valueLabel={t('admin.runtimeOverview.allocatedOf', {
              allocated: t('admin.runtimeOverview.cores', { count: formatNumber(summary.cpu.allocated_cores) }),
              limit: t('admin.runtimeOverview.cores', { count: formatNumber(summary.cpu.total_cores) }),
            })}
            details={[
              t('admin.runtimeOverview.hostCpuUse', { percent: formatNumber(summary.cpu.host_usage_percent) }),
              summary.cpu.managed_usage_cores === null
                ? null
                : t('admin.runtimeOverview.managedUse', {
                    used: t('admin.runtimeOverview.cores', {
                      count: formatNumber(summary.cpu.managed_usage_cores),
                    }),
                  }),
            ]}
          />
          <CapacityBar
            label={t('admin.runtimeOverview.memoryReservations', {})}
            value={summary.memory.allocated_bytes}
            limit={summary.memory.allocation_limit_bytes}
            valueLabel={t('admin.runtimeOverview.allocatedOf', {
              allocated: formatBytes(summary.memory.allocated_bytes),
              limit: formatBytes(summary.memory.allocation_limit_bytes),
            })}
            details={resourceDetails(summary.memory, t)}
          />
          <CapacityBar
            label={t('admin.runtimeOverview.diskReservations', {})}
            value={summary.disk.allocated_bytes}
            limit={summary.disk.allocation_limit_bytes}
            valueLabel={t('admin.runtimeOverview.allocatedOf', {
              allocated: formatBytes(summary.disk.allocated_bytes),
              limit: formatBytes(summary.disk.allocation_limit_bytes),
            })}
            details={resourceDetails(summary.disk, t)}
          />

          <div>
            <Group justify='space-between' mb='xs'>
              <Text size='sm' fw={600}>
                {t('admin.runtimeOverview.instances', {})}
              </Text>
              <Text size='sm' fw={600}>
                {t('admin.runtimeOverview.totalInstances', { count: summary.instances.total })}
              </Text>
            </Group>
            <Group gap='xs'>
              <InstanceBadge
                label={t('admin.runtimeOverview.running', {})}
                count={summary.instances.running}
                color='green'
              />
              <InstanceBadge
                label={t('admin.runtimeOverview.creating', {})}
                count={summary.instances.creating}
                color='blue'
              />
              <InstanceBadge
                label={t('admin.runtimeOverview.booting', {})}
                count={summary.instances.booting}
                color='cyan'
              />
              <InstanceBadge
                label={t('admin.runtimeOverview.stopped', {})}
                count={summary.instances.stopped}
                color='gray'
              />
              <InstanceBadge
                label={t('admin.runtimeOverview.failed', {})}
                count={summary.instances.failed}
                color='red'
              />
              <InstanceBadge
                label={t('admin.runtimeOverview.quarantined', {})}
                count={summary.instances.quarantined}
                color='orange'
              />
              <InstanceBadge
                label={t('admin.runtimeOverview.deleting', {})}
                count={summary.instances.deleting}
                color='yellow'
              />
            </Group>
          </div>
        </Stack>
      )}
    </Card>
  );
}

function CapacityBar({
  label,
  value,
  limit,
  valueLabel,
  details,
}: {
  label: string;
  value: number;
  limit: number;
  valueLabel: string;
  details: Array<string | null>;
}) {
  const percent = percentage(value, limit);
  return (
    <Stack gap={6}>
      <Group justify='space-between' wrap='nowrap'>
        <Text size='sm' fw={600}>
          {label}
        </Text>
        <Text size='sm' ff='monospace' ta='right'>
          {valueLabel}
        </Text>
      </Group>
      <Progress value={percent} color={capacityColor(percent)} hourglass={false} />
      <Group justify='space-between' gap='xs'>
        {details
          .filter((detail): detail is string => Boolean(detail))
          .map((detail) => (
            <Text key={detail} size='xs' c='dimmed'>
              {detail}
            </Text>
          ))}
      </Group>
    </Stack>
  );
}

function Metric({ label, value, detail }: { label: string; value?: string; detail?: string }) {
  return (
    <div>
      <Text size='xs' c='dimmed'>
        {label}
      </Text>
      {value && <Text fw={600}>{value}</Text>}
      {detail && (
        <Text size='xs' c='dimmed' className='break-all'>
          {detail}
        </Text>
      )}
    </div>
  );
}

function BooleanMetric({
  label,
  enabled,
  trueLabel,
  falseLabel,
  detail,
  t,
}: {
  label: string;
  enabled: boolean;
  trueLabel?: string;
  falseLabel?: string;
  detail?: string;
  t: RuntimeTranslation;
}) {
  return (
    <Group justify='space-between' wrap='nowrap'>
      <Metric label={label} value={detail ? titleCase(detail) : ''} />
      <Badge color={enabled ? 'green' : 'gray'} variant='light'>
        {enabled
          ? (trueLabel ?? t('admin.runtimeOverview.enabled', {}))
          : (falseLabel ?? t('admin.runtimeOverview.disabled', {}))}
      </Badge>
    </Group>
  );
}

function StatusRow({
  label,
  value,
  badge,
  badgeColor,
}: {
  label: string;
  value: string;
  badge: string;
  badgeColor: 'green' | 'yellow';
}) {
  return (
    <Group justify='space-between' wrap='nowrap'>
      <Metric label={label} value={value || '—'} />
      <Badge color={badgeColor} variant='light'>
        {badge}
      </Badge>
    </Group>
  );
}

function InstanceBadge({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <Badge color={color} variant='light' size='md'>
      {label} {count}
    </Badge>
  );
}

function EmptySample({ t }: { t: RuntimeTranslation }) {
  return (
    <Stack gap={4} py='xl' align='center'>
      <Text fw={600}>{t('admin.runtimeOverview.noSample', {})}</Text>
      <Text size='xs' c='dimmed' ta='center'>
        {t('admin.runtimeOverview.noSampleDescription', {})}
      </Text>
    </Stack>
  );
}

function resourceDetails(resource: DbevNodeResourceSummary['memory'], t: RuntimeTranslation): Array<string | null> {
  return [
    t('admin.runtimeOverview.hostUse', {
      used: formatBytes(resource.host_used_bytes),
      total: formatBytes(resource.total_bytes),
    }),
    resource.managed_used_bytes === null
      ? null
      : t('admin.runtimeOverview.managedUse', { used: formatBytes(resource.managed_used_bytes) }),
    t('admin.runtimeOverview.reserved', { size: formatBytes(resource.reserved_bytes) }),
    t('admin.runtimeOverview.available', { size: formatBytes(resource.available_bytes) }),
  ];
}

function isCompleteResourceSummary(value: Partial<DbevNodeResourceSummary> | null): value is DbevNodeResourceSummary {
  return Boolean(value?.cpu && value.memory && value.disk && value.instances);
}

function formatApiBind(system: Partial<DbevSystemResponse>): string {
  if (!system.api_host) return '—';
  return `${system.api_ssl_enabled ? 'https' : 'http'}://${system.api_host}${system.api_port ? `:${system.api_port}` : ''}`;
}

function formatBytes(value: number): string {
  return bytesToString(Number.isFinite(value) ? Math.max(0, value) : 0);
}

function formatNumber(value: number | undefined): string {
  return Number.isFinite(value)
    ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value ?? 0)
    : '0';
}

function percentage(value: number | undefined, limit: number | undefined): number {
  if (!Number.isFinite(value) || !Number.isFinite(limit) || !limit || limit <= 0) return 0;
  return Math.max(0, Math.min(100, ((value ?? 0) / limit) * 100));
}

function capacityColor(percent: number): 'blue' | 'orange' | 'red' {
  if (percent >= 90) return 'red';
  if (percent >= 75) return 'orange';
  return 'blue';
}

function gatewayStatusColor(
  status: DbevSystemResponse['gateways']['status'] | undefined,
): 'green' | 'blue' | 'red' | 'gray' {
  if (status === 'ready') return 'green';
  if (status === 'starting' || status === 'stopping') return 'blue';
  if (status === 'failed') return 'red';
  return 'gray';
}

function titleCase(value: string | undefined): string {
  if (!value) return '—';
  return value.replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}
