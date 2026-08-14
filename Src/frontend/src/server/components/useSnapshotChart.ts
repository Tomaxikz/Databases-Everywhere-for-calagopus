import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CHART_DELAY,
  CHART_TICK,
  CHART_WINDOW,
  type ChartLegendProps,
  type ChartScale,
  type StreamChartProps,
  type StreamChartSeries,
} from '@/lib/chart.ts';
import type { DatabaseMonitoringChartPoint } from '../monitoringSamples.ts';

interface Options {
  points: DatabaseMonitoringChartPoint[];
  labels: string[];
  values: (point: DatabaseMonitoringChartPoint) => (number | null)[];
  format: (value: number) => string;
  scale?: ChartScale;
  min?: number;
}

const TICK_COUNT = 3;
const COLORS = 4;
const DASHES = [undefined, '6 4', '2 3', '10 4 2 4'];

function niceCeil(value: number, scale: ChartScale): number {
  if (!Number.isFinite(value) || value <= 0) return scale === 'binary' ? 1024 : 1;
  if (scale === 'binary') return 2 ** Math.ceil(Math.log2(value));

  const magnitude = 10 ** Math.floor(Math.log10(value));
  return ([1, 2, 4, 5, 10].find((step) => magnitude * step >= value) ?? 10) * magnitude;
}

export default function useSnapshotChart({
  points,
  labels,
  values: selectValues,
  format,
  scale = 'decimal',
  min = 0,
}: Options) {
  const [end, setEnd] = useState(() => Date.now() - CHART_DELAY);
  const ceiling = useRef(0);

  useEffect(() => {
    const interval = window.setInterval(() => setEnd(Date.now() - CHART_DELAY), CHART_TICK);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (points.length !== 0) return;
    ceiling.current = 0;
    setEnd(Date.now() - CHART_DELAY);
  }, [points.length]);

  const { data, ticks, yMax, latestValues } = useMemo(() => {
    const start = end - CHART_WINDOW;
    const visible = points.filter((point) => point.t >= start - 2 * CHART_TICK);
    let peak = 0;

    for (const point of visible) {
      for (const value of selectValues(point)) {
        if (value !== null && value > peak) peak = value;
      }
    }

    const wanted = niceCeil(Math.max(min, peak * 1.25), scale);
    if (wanted > ceiling.current || wanted <= ceiling.current / 2) ceiling.current = wanted;
    const height = ceiling.current || wanted;

    return {
      data: visible.map((point) => {
        const row: Record<string, number | null> = { t: point.t };
        selectValues(point).forEach((value, index) => {
          row[`v${index}`] = value;
        });
        return row;
      }),
      ticks: Array.from({ length: TICK_COUNT }, (_, index) => (height * index) / (TICK_COUNT - 1)),
      yMax: height,
      latestValues: points.length ? selectValues(points[points.length - 1]) : [],
    };
  }, [end, min, points, scale, selectValues]);

  const series = useMemo<StreamChartSeries[]>(
    () =>
      labels.map((label, index) => {
        const value = latestValues[index] ?? null;
        return {
          key: `v${index}`,
          label,
          color: `var(--chart-series-${(index % COLORS) + 1})`,
          value,
          formatted: value === null ? null : format(value),
          dash: labels.length > 1 ? DASHES[index % DASHES.length] : undefined,
        };
      }),
    [format, labels, latestValues],
  );

  return {
    props: {
      data,
      domain: [end - CHART_WINDOW, end] as [number, number],
      ticks,
      yMax,
      series,
      format,
    } satisfies StreamChartProps,
    legend: { series } satisfies ChartLegendProps,
    value: series.length === 1 ? series[0].formatted : null,
  };
}
