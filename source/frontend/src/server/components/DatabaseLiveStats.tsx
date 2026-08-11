import { faCloudDownload, faHardDrive, faMemory, faMicrochip, faPowerOff } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { useEffect, useMemo, useRef } from 'react';
import ChartBlock from '@/elements/ChartBlock.tsx';
import ChartLegend from '@/elements/ChartLegend.tsx';
import { formatBytes, formatBytesRate, formatPercent, useStreamChart } from '@/lib/chart.ts';
import { mbToBytes } from '@/lib/size.ts';
import type { DatabaseMonitoringInstance, ResourceLimits } from '../../api/types.ts';
import StableStreamChart from './StableStreamChart.tsx';

export default function DatabaseLiveStats({
  instance,
  limits,
}: {
  instance: DatabaseMonitoringInstance | null;
  limits: ResourceLimits;
}) {
  const previousNetwork = useRef({ rx: -1, tx: -1, at: 0 });
  const cpu = useStreamChart({ series: useMemo(() => ['CPU load'], []), format: formatPercent, min: 10 });
  const memory = useStreamChart({
    series: useMemo(() => ['Memory usage'], []),
    format: formatBytes,
    scale: 'binary',
    min: Number(
      instance?.resources?.memory.limit_bytes ?? instance?.memory_limit_bytes ?? mbToBytes(limits.memory_mib),
    ),
  });
  const disk = useStreamChart({
    series: useMemo(() => ['Disk usage'], []),
    format: formatBytes,
    scale: 'binary',
    min: Number(instance?.resources?.disk.limit_bytes ?? instance?.disk_limit_bytes ?? mbToBytes(limits.disk_mib)),
  });
  const network = useStreamChart({
    series: useMemo(() => ['Outbound', 'Inbound'], []),
    format: formatBytesRate,
    scale: 'binary',
  });

  useEffect(() => {
    if (!instance) return;
    cpu.push(Number.isFinite(instance.cpu_usage_percent) ? (instance.cpu_usage_percent as number) : null);
    const memoryUsage = instance.resources?.memory.usage_bytes ?? instance.memory_usage_bytes;
    const diskUsage = instance.resources?.disk.used_bytes ?? instance.disk_used_bytes;
    memory.push(Number.isFinite(memoryUsage) ? (memoryUsage as number) : null);
    disk.push(Number.isFinite(diskUsage) ? (diskUsage as number) : null);

    const now = Date.now();
    const rx = Number(instance.network_rx_bytes ?? 0);
    const tx = Number(instance.network_tx_bytes ?? 0);
    const elapsed = previousNetwork.current.at ? Math.max((now - previousNetwork.current.at) / 1_000, 0.1) : 0;
    network.push(
      elapsed
        ? [
            Math.max(0, tx - previousNetwork.current.tx) / elapsed,
            Math.max(0, rx - previousNetwork.current.rx) / elapsed,
          ]
        : [0, 0],
    );
    previousNetwork.current = { rx, tx, at: now };
  }, [instance]);

  const waiting = !instance;
  const offline = Boolean(instance && instance.status !== 'running');
  const overlayIcon = <FontAwesomeIcon icon={faPowerOff} className='text-2xl' />;
  const overlayLabel = waiting
    ? 'Waiting for live data'
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
