import { AreaChart, ChartTooltip } from '@mantine/charts';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ResponsiveContainer } from 'recharts';
import { CHART_TICK, CHART_WINDOW, type StreamChartProps } from '@/lib/chart.ts';

const PLOT_INSET = 3;
const EDGE = CHART_TICK * 1.5;

function formatOffset(at: number, end: number): string {
  const seconds = Math.round((at - end) / 1000);
  return seconds >= 0 ? 'now' : `${seconds}s`;
}

/** Avoids the transient negative-size mount produced by responsive Recharts containers. */
export default function StableStreamChart({
  data,
  domain,
  ticks,
  yMax,
  series,
  format,
  highlighted,
}: StreamChartProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const previousEnd = useRef<number | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [start, end] = domain;

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;

    const observer = new ResizeObserver(([entry]) => {
      const width = Math.max(0, entry.contentRect.width);
      const height = Math.max(0, entry.contentRect.height);
      setSize((current) => (current.width === width && current.height === height ? current : { width, height }));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const edgePixels = (size.width * EDGE) / CHART_WINDOW;
  const surfaceWidth = size.width + edgePixels * 2;

  useLayoutEffect(() => {
    const from = previousEnd.current;
    previousEnd.current = end;

    const surface = scroller.current?.querySelector<SVGSVGElement>('.recharts-surface');
    const resting = `inset(-100% ${edgePixels}px -100% ${edgePixels}px)`;
    if (surface) surface.style.clipPath = resting;

    const duration = from === null ? 0 : end - from;
    if (duration <= 0 || duration > EDGE || size.width === 0) return;

    const offset = (size.width * duration) / CHART_WINDOW;
    const timing = { duration, easing: 'linear', fill: 'forwards' } as const;
    scroller.current?.animate([{ transform: `translateX(${offset}px)` }, { transform: 'none' }], timing);
    surface?.animate(
      [{ clipPath: `inset(-100% ${edgePixels + offset}px -100% ${edgePixels - offset}px)` }, { clipPath: resting }],
      timing,
    );
  }, [edgePixels, end, size.width]);

  const chartSeries = useMemo(
    () =>
      series
        .filter((entry) => !entry.hidden)
        .map((entry) => ({
          name: entry.key,
          label: entry.label,
          color: entry.color,
          strokeDasharray: entry.dash,
        })),
    [series],
  );

  const labels = useMemo(() => {
    const seen = new Set<string>();
    return ticks
      .map((value) => ({ value, text: format(value) }))
      .filter((tick) => {
        if (seen.has(tick.text)) return false;
        seen.add(tick.text);
        return true;
      });
  }, [format, ticks]);

  return (
    <div className='flex h-full min-h-0 w-full min-w-0'>
      <div className='relative w-18 shrink-0'>
        {labels.map((tick) => (
          <span
            key={tick.text}
            className='absolute right-2 -translate-y-1/2 whitespace-nowrap text-xs text-(--chart-tick-color) tabular-nums'
            style={{ top: PLOT_INSET + (1 - tick.value / yMax) * Math.max(size.height - PLOT_INSET * 2, 0) }}
          >
            {tick.text}
          </span>
        ))}
      </div>

      <div ref={viewport} className='relative min-h-0 min-w-0 flex-1'>
        {labels.map((tick) => (
          <div
            key={tick.text}
            className='pointer-events-none absolute inset-x-0 border-t border-(--chart-grid-color)'
            style={{ top: PLOT_INSET + (1 - tick.value / yMax) * Math.max(size.height - PLOT_INSET * 2, 0) }}
          />
        ))}

        <div
          ref={scroller}
          className='absolute inset-y-0 will-change-transform'
          style={{ left: -edgePixels, width: surfaceWidth }}
        >
          {surfaceWidth > 0 && size.height > 0 && (
            <ResponsiveContainer width={surfaceWidth} height={size.height}>
              <AreaChart
                h={size.height}
                data={data}
                dataKey='t'
                series={chartSeries}
                curveType='monotone'
                withGradient
                fillOpacity={0.25}
                strokeWidth={2}
                withDots={false}
                withXAxis={false}
                withYAxis={false}
                withTooltip
                tooltipAnimationDuration={0}
                tooltipProps={{
                  isAnimationActive: false,
                  wrapperStyle: { zIndex: 1 },
                  content: ({ label, payload }) => (
                    <ChartTooltip
                      label={typeof label === 'number' ? formatOffset(label, end) : label}
                      payload={payload}
                      series={chartSeries}
                      valueFormatter={format}
                    />
                  ),
                }}
                gridAxis='none'
                connectNulls={false}
                xAxisProps={{ type: 'number', domain: [start - EDGE, end + EDGE], allowDataOverflow: true, hide: true }}
                yAxisProps={{ domain: [0, yMax], allowDataOverflow: true, hide: true }}
                areaProps={(entry) => ({
                  isAnimationActive: false,
                  fillOpacity: highlighted && highlighted !== entry.name ? 0 : 1,
                  strokeOpacity: highlighted && highlighted !== entry.name ? 0.3 : 1,
                })}
                areaChartProps={{ margin: { top: PLOT_INSET, right: 0, bottom: PLOT_INSET, left: 0 } }}
              />
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  );
}
