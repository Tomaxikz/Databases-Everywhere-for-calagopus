import { ScrollArea, Text } from '@mantine/core';
import { Fragment, useLayoutEffect, useRef } from 'react';
import Badge from '@/elements/Badge.tsx';
import Code from '@/elements/Code.tsx';
import translations from '../../translations.ts';
import type { LiveConnectionState } from '../useDatabaseWebSockets.ts';
import SectionCard from './SectionCard.tsx';

const TOKEN_PATTERN =
  /(\[[^\]]+\]|\b(?:ERROR|FATAL|PANIC|WARN(?:ING)?|INFO|DEBUG|TRACE|READY|STARTED|RUNNING|CONNECTED)\b|\d{4}-\d{2}-\d{2}[T ][0-9:.+-]+Z?)/gi;

function tokenColor(token: string): string | undefined {
  const normalized = token.toUpperCase();
  if (/ERROR|FATAL|PANIC|STDERR|STREAM ERROR/.test(normalized)) return 'var(--mantine-color-red-4)';
  if (/WARN/.test(normalized)) return 'var(--mantine-color-yellow-4)';
  if (/READY|STARTED|RUNNING|CONNECTED/.test(normalized)) return 'var(--mantine-color-green-4)';
  if (/INFO|SYSTEM|SERVER/.test(normalized)) return 'var(--mantine-color-blue-3)';
  if (/DEBUG|TRACE/.test(normalized)) return 'var(--mantine-color-violet-3)';
  if (/^\d{4}-\d{2}-\d{2}/.test(normalized)) return 'var(--mantine-color-dimmed)';
  return undefined;
}

function HighlightedLine({ line }: { line: string }) {
  const parts = line.split(TOKEN_PATTERN);
  const lineColor = /\b(?:ERROR|FATAL|PANIC)\b|^\[(?:stderr|stream error)\]/i.test(line)
    ? 'var(--mantine-color-red-3)'
    : /\bWARN(?:ING)?\b/i.test(line)
      ? 'var(--mantine-color-yellow-3)'
      : undefined;

  return (
    <span className='block min-h-[1.25em]' style={{ color: lineColor }}>
      {parts.map((part, index) => {
        const color = tokenColor(part);
        return color ? (
          <span key={`${index}:${part}`} style={{ color, fontWeight: 600 }}>
            {part}
          </span>
        ) : (
          <Fragment key={`${index}:${part}`}>{part}</Fragment>
        );
      })}
    </span>
  );
}

export default function DatabaseLiveLogs({
  lines,
  state,
  error,
}: {
  lines: string[];
  state: LiveConnectionState;
  error: string | null;
}) {
  const { t } = translations.useTranslations();
  const viewport = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (element && followOutput.current) element.scrollTop = element.scrollHeight;
  }, [error, lines]);

  const updateFollowOutput = () => {
    const element = viewport.current;
    if (!element) return;
    followOutput.current = element.scrollHeight - element.scrollTop - element.clientHeight < 32;
  };

  const displayState = error && state === 'connected' ? 'reconnecting' : state;

  return (
    <SectionCard
      heading={
        <div>
          <Text fw={600}>{t('server.databaseLogs', {})}</Text>
          <Text size='xs' c='dimmed'>
            {t('server.databaseLogsDescription', {})}
          </Text>
        </div>
      }
      headerRight={
        <Badge color={displayState === 'connected' ? 'green' : displayState === 'unavailable' ? 'red' : 'yellow'}>
          {displayState}
        </Badge>
      }
      bodyPadded={false}
    >
      <ScrollArea h={360} type='auto' viewportRef={viewport} onScrollPositionChange={updateFollowOutput}>
        <Code block className='min-h-[22rem] whitespace-pre-wrap break-all rounded-none border-0 p-4 text-xs'>
          {lines.length ? (
            lines.map((line, index) => <HighlightedLine key={`${index}:${line}`} line={line} />)
          ) : (
            <HighlightedLine line={error || t('server.waitingForLogs', {})} />
          )}
        </Code>
      </ScrollArea>
    </SectionCard>
  );
}
