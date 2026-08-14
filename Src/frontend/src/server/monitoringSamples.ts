import type { DatabaseMonitoringInstance } from '../api/types.ts';

const MAX_MONITORING_SAMPLES = 180;

export interface DatabaseMonitoringSample {
  kind: 'stats' | 'gap';
  receivedAt: number;
  instance: DatabaseMonitoringInstance | null;
}

export interface DatabaseMonitoringChartPoint {
  t: number;
  cpuPercent: number | null;
  memoryBytes: number | null;
  diskBytes: number | null;
  networkRxBytesPerSecond: number | null;
  networkTxBytesPerSecond: number | null;
}

function finiteMetric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function preferredMetric(primary: unknown, fallback: unknown): number | null {
  return finiteMetric(primary === undefined ? fallback : primary);
}

export function appendMonitoringSample(
  samples: DatabaseMonitoringSample[],
  sample: DatabaseMonitoringSample,
): DatabaseMonitoringSample[] {
  const next = [...samples, sample];
  return next.length > MAX_MONITORING_SAMPLES ? next.slice(-MAX_MONITORING_SAMPLES) : next;
}

export function monitoringChartPoints(samples: DatabaseMonitoringSample[]): DatabaseMonitoringChartPoint[] {
  let previousNetwork: { rx: number; tx: number; at: number } | null = null;

  return samples.map((sample) => {
    const instance = sample.kind === 'stats' ? sample.instance : null;
    const rx = finiteMetric(instance?.network_rx_bytes);
    const tx = finiteMetric(instance?.network_tx_bytes);
    let networkRxBytesPerSecond: number | null = null;
    let networkTxBytesPerSecond: number | null = null;

    if (instance && rx !== null && tx !== null) {
      if (previousNetwork) {
        const elapsedSeconds = (sample.receivedAt - previousNetwork.at) / 1_000;
        const restarted = rx < previousNetwork.rx || tx < previousNetwork.tx;
        if (!restarted && elapsedSeconds > 0) {
          networkRxBytesPerSecond = (rx - previousNetwork.rx) / elapsedSeconds;
          networkTxBytesPerSecond = (tx - previousNetwork.tx) / elapsedSeconds;
        }
      }
      previousNetwork = { rx, tx, at: sample.receivedAt };
    } else {
      previousNetwork = null;
    }

    return {
      t: sample.receivedAt,
      cpuPercent: finiteMetric(instance?.cpu_usage_percent),
      memoryBytes: preferredMetric(instance?.resources?.memory.usage_bytes, instance?.memory_usage_bytes),
      diskBytes: preferredMetric(instance?.resources?.disk.used_bytes, instance?.disk_used_bytes),
      networkRxBytesPerSecond,
      networkTxBytesPerSecond,
    };
  });
}
