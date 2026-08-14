import { faCloudDownload, faHardDrive, faMemory, faMicrochip, faPowerOff } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { useMemo } from 'react';
import ChartBlock from '@/elements/ChartBlock.tsx';
import ChartLegend from '@/elements/ChartLegend.tsx';
import { formatBytes, formatBytesRate, formatPercent } from '@/lib/chart.ts';
import { mbToBytes } from '@/lib/size.ts';
import type { DatabaseMonitoringInstance, ResourceLimits } from '../../api/types.ts';
import {
  type DatabaseMonitoringChartPoint,
  type DatabaseMonitoringSample,
  monitoringChartPoints,
} from '../monitoringSamples.ts';
import StableStreamChart from './StableStreamChart.tsx';
import useSnapshotChart from './useSnapshotChart.ts';

const CPU_SERIES = ['CPU load'];
const MEMORY_SERIES = ['Memory usage'];
const DISK_SERIES = ['Disk usage'];
const NETWORK_SERIES = ['Outbound', 'Inbound'];

const cpuValues = (point: DatabaseMonitoringChartPoint) => [point.cpuPercent];
const memoryValues = (point: DatabaseMonitoringChartPoint) => [point.memoryBytes];
const diskValues = (point: DatabaseMonitoringChartPoint) => [point.diskBytes];
const networkValues = (point: DatabaseMonitoringChartPoint) => [
  point.networkTxBytesPerSecond,
  point.networkRxBytesPerSecond,
];

function formatMemoryMiB(bytes: number): string {
  return `${Number((bytes / 1024 ** 2).toFixed(2))} MiB`;
}

function finiteOr(value: number | null | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export default function DatabaseLiveStats({
  instance,
  samples,
  limits,
}: {
  instance: DatabaseMonitoringInstance | null;
  samples: DatabaseMonitoringSample[];
  limits: ResourceLimits;
}) {
  const points = useMemo(() => monitoringChartPoints(samples), [samples]);
  const cpuLimit = finiteOr(instance?.cpu_limit_cores ?? instance?.cpu_cores, limits.cpu_cores);
  const memoryLimit = finiteOr(
    instance?.resources?.memory.limit_bytes ?? instance?.memory_limit_bytes,
    mbToBytes(limits.memory_mib),
  );
  const diskLimit = finiteOr(
    instance?.resources?.disk.limit_bytes ?? instance?.disk_limit_bytes,
    mbToBytes(limits.disk_mib),
  );
  const cpu = useSnapshotChart({
    points,
    labels: CPU_SERIES,
    values: cpuValues,
    format: formatPercent,
    min: Math.max(100, cpuLimit * 100),
  });
  const memory = useSnapshotChart({
    points,
    labels: MEMORY_SERIES,
    values: memoryValues,
    format: formatMemoryMiB,
    scale: 'binary',
    min: memoryLimit,
  });
  const disk = useSnapshotChart({
    points,
    labels: DISK_SERIES,
    values: diskValues,
    format: formatBytes,
    scale: 'binary',
    min: diskLimit,
  });
  const network = useSnapshotChart({
    points,
    labels: NETWORK_SERIES,
    values: networkValues,
    format: formatBytesRate,
    scale: 'binary',
  });

  const latestSample = samples.at(-1);
  const reconnecting = latestSample?.kind === 'gap';
  const waiting = samples.length === 0;
  const unavailable = !waiting && !reconnecting && !latestSample?.instance;
  const offline = Boolean(instance && instance.status !== 'running');
  const overlayIcon = <FontAwesomeIcon icon={faPowerOff} className='text-2xl' />;
  const overlayLabel = waiting
    ? 'Waiting for live data'
    : reconnecting
      ? 'Live metrics are reconnecting'
      : unavailable
        ? 'Metrics are temporarily unavailable'
        : offline
          ? `Database is ${instance?.status ?? 'offline'}`
          : undefined;

  return (
    <div className='grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4'>
      <ChartBlock
        icon={<FontAwesomeIcon icon={faMicrochip} />}
        title='CPU load'
        value={cpu.value}
        overlayIcon={overlayIcon}
        overlayLabel={overlayLabel}
      >
        <StableStreamChart {...cpu.props} />
      </ChartBlock>
      <ChartBlock
        icon={<FontAwesomeIcon icon={faMemory} />}
        title='Memory usage'
        value={memory.value}
        overlayIcon={overlayIcon}
        overlayLabel={overlayLabel}
      >
        <StableStreamChart {...memory.props} />
      </ChartBlock>
      <ChartBlock
        icon={<FontAwesomeIcon icon={faHardDrive} />}
        title='Disk usage'
        value={disk.value}
        overlayIcon={overlayIcon}
        overlayLabel={overlayLabel}
      >
        <StableStreamChart {...disk.props} />
      </ChartBlock>
      <ChartBlock
        icon={<FontAwesomeIcon icon={faCloudDownload} />}
        title='Network traffic'
        legend={<ChartLegend {...network.legend} />}
        overlayIcon={overlayIcon}
        overlayLabel={overlayLabel}
      >
        <StableStreamChart {...network.props} />
      </ChartBlock>
    </div>
  );
}
