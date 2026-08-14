import { faBroom, faClockRotateLeft, faPlay, faTerminal } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Group, Stack, Text } from '@mantine/core';
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { httpErrorToHuman } from '@/api/axios.ts';
import Button from '@/elements/Button.tsx';
import Card from '@/elements/Card.tsx';
import Autocomplete from '@/elements/input/Autocomplete.tsx';
import Menu from '@/elements/Menu.tsx';
import { executeCommand } from '../../api/client.ts';
import type { DatabaseRecord } from '../../api/types.ts';
import { protocolConsoleExamples } from '../../components/protocols.ts';
import translations from '../../translations.ts';
import DatabaseTerminal, { type ConsoleEntry } from '../console/DatabaseTerminal.tsx';
import { terminalPrompt } from '../console/terminalOutput.ts';

interface HistoryEntry {
  command: string;
  executedAt: number;
}

const HISTORY_LIMIT = 50;
const SESSION_LIMIT = 100;

export default function ConsoleTab({ server, database }: { server: string; database: DatabaseRecord }) {
  const { t } = translations.useTranslations();
  const storageKey = `dbev-console-history:${database.uuid}`;
  const prompt = terminalPrompt(database.protocol, database.display_name);
  const inputRef = useRef<HTMLInputElement>(null);
  const entryId = useRef(0);
  const historyDraft = useRef('');
  const [command, setCommand] = useState('');
  const [entries, setEntries] = useState<ConsoleEntry[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setCommand('');
    setEntries([]);
    setHistoryIndex(null);
    historyDraft.current = '';
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) || '[]');
      setHistory(Array.isArray(parsed) ? parsed.filter(isHistoryEntry).slice(0, HISTORY_LIMIT) : []);
    } catch {
      setHistory([]);
    }
  }, [storageKey]);

  const remember = (nextCommand: string) => {
    setHistory((current) => {
      const next = [
        { command: nextCommand, executedAt: Date.now() },
        ...current.filter((entry) => entry.command !== nextCommand),
      ].slice(0, HISTORY_LIMIT);
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // The in-memory terminal history remains usable when browser storage
        // is disabled or full.
      }
      return next;
    });
  };

  const execute = async () => {
    const submitted = command.trim();
    if (!submitted || loading) return;

    const id = ++entryId.current;
    const runningEntry: ConsoleEntry = {
      id,
      command: submitted,
      executedAt: Date.now(),
      state: 'running',
    };
    setEntries((current) => [...current.slice(-(SESSION_LIMIT - 1)), runningEntry]);
    setCommand('');
    setHistoryIndex(null);
    historyDraft.current = '';
    setLoading(true);
    remember(submitted);

    try {
      const output = await executeCommand(server, database.uuid, submitted);
      setEntries((current) =>
        current.map((entry) => (entry.id === id ? { ...entry, state: 'success', output } : entry)),
      );
    } catch (cause) {
      const error = httpErrorToHuman(cause);
      setEntries((current) => current.map((entry) => (entry.id === id ? { ...entry, state: 'error', error } : entry)));
    } finally {
      setLoading(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  };

  const focusAtEnd = (value: string) => {
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(value.length, value.length);
    });
  };

  const chooseHistory = (index: number) => {
    const selected = history[index];
    if (!selected) return;
    if (historyIndex === null) historyDraft.current = command;
    setHistoryIndex(index);
    setCommand(selected.command);
    focusAtEnd(selected.command);
  };

  const stepHistory = (direction: 'older' | 'newer') => {
    if (!history.length) return;
    if (direction === 'older') {
      const nextIndex = historyIndex === null ? 0 : Math.min(historyIndex + 1, history.length - 1);
      chooseHistory(nextIndex);
      return;
    }
    if (historyIndex === null) return;
    if (historyIndex === 0) {
      const draft = historyDraft.current;
      setHistoryIndex(null);
      setCommand(draft);
      focusAtEnd(draft);
      return;
    }
    chooseHistory(historyIndex - 1);
  };

  const updateCommand = (value: string) => {
    setCommand(value);
    setHistoryIndex(null);
    historyDraft.current = value;
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const value = input.value;
    const selectionStart = input.selectionStart ?? value.length;
    const selectionEnd = input.selectionEnd ?? value.length;
    const modifier = event.ctrlKey || event.metaKey;

    if (modifier && event.key.toLowerCase() === 'l') {
      event.preventDefault();
      if (!loading) setEntries([]);
      return;
    }

    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void execute();
      return;
    }

    if (event.key === 'ArrowUp' && !value.slice(0, selectionStart).includes('\n')) {
      event.preventDefault();
      stepHistory('older');
      return;
    }

    if (event.key === 'ArrowDown' && !value.slice(selectionEnd).includes('\n')) {
      event.preventDefault();
      stepHistory('newer');
    }
  };

  const presets = useMemo(() => consolePresets(database), [database.database_name, database.protocol]);
  const suggestions = useMemo(
    () => Array.from(new Set([...presets.map((preset) => preset.command), ...history.map((entry) => entry.command)])),
    [history, presets],
  );

  return (
    <Stack mt='md'>
      <Card p={0} className='overflow-hidden'>
        <Group
          justify='space-between'
          align='flex-start'
          className='border-b border-(--mantine-color-default-border) px-4 py-3'
        >
          <div>
            <Group gap='xs'>
              <FontAwesomeIcon icon={faTerminal} />
              <Text fw={600}>{t('server.consoleTerminal.title', { protocol: database.protocol_label })}</Text>
            </Group>
            <Text size='xs' c='dimmed'>
              {t('server.consoleTerminal.description', {})}
            </Text>
          </div>
          <Group gap='xs'>
            <Menu position='bottom-end' width={380} shadow='md' withinPortal>
              <Menu.Target>
                <Button size='sm' variant='default' leftSection={<FontAwesomeIcon icon={faClockRotateLeft} />}>
                  {t('server.consoleTerminal.history', {})}
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                {history.length ? (
                  history.map((entry, index) => (
                    <Menu.Item key={`${entry.executedAt}:${entry.command}`} onClick={() => chooseHistory(index)}>
                      <Text size='xs' ff='monospace' truncate>
                        {entry.command.replace(/\s+/g, ' ')}
                      </Text>
                      <Text size='xs' c='dimmed'>
                        {new Date(entry.executedAt).toLocaleString()}
                      </Text>
                    </Menu.Item>
                  ))
                ) : (
                  <Menu.Label>{t('server.consoleTerminal.noHistory', {})}</Menu.Label>
                )}
              </Menu.Dropdown>
            </Menu>
            <Button
              size='sm'
              variant='default'
              disabled={loading || entries.length === 0}
              leftSection={<FontAwesomeIcon icon={faBroom} />}
              onClick={() => setEntries([])}
            >
              {t('server.consoleTerminal.clear', {})}
            </Button>
          </Group>
        </Group>

        <Group gap='xs' className='border-b border-(--mantine-color-default-border) px-4 py-2'>
          {presets.map((preset) => (
            <Button
              key={preset.label}
              size='compact-sm'
              variant='subtle'
              disabled={loading}
              onClick={() => {
                updateCommand(preset.command);
                focusAtEnd(preset.command);
              }}
            >
              {preset.label}
            </Button>
          ))}
        </Group>

        <div className='bg-(--mantine-color-body)'>
          <DatabaseTerminal
            entries={entries}
            prompt={prompt}
            protocol={database.protocol}
            protocolLabel={database.protocol_label}
            databaseName={database.display_name}
          />

          <div
            className='border-t border-(--mantine-color-default-border) bg-(--mantine-color-default-hover) px-4 py-3'
            onClick={() => inputRef.current?.focus()}
          >
            <Group gap='sm' align='center' wrap='nowrap'>
              <Text ff='monospace' size='sm' fw={600} c='var(--mantine-primary-color-filled)' className='shrink-0'>
                {prompt}
              </Text>
              <Autocomplete
                ref={inputRef}
                value={command}
                onChange={updateCommand}
                onKeyDown={handleKeyDown}
                disabled={loading}
                data={suggestions}
                limit={8}
                maxDropdownHeight={260}
                onOptionSubmit={(value) => {
                  updateCommand(value);
                  focusAtEnd(value);
                }}
                aria-label={t('server.consoleTerminal.commandInput', {})}
                placeholder={t('server.consoleTerminal.placeholder', {
                  example: protocolConsoleExamples[database.protocol],
                })}
                autoCorrect='off'
                autoCapitalize='none'
                spellCheck={false}
                className='min-w-0 flex-1'
              />
              <Button
                size='sm'
                loading={loading}
                disabled={!command.trim()}
                leftSection={<FontAwesomeIcon icon={faPlay} />}
                onClick={() => void execute()}
              >
                {t('server.consoleTerminal.run', {})}
              </Button>
            </Group>
            <Text size='xs' c='dimmed' mt='xs'>
              {t('server.consoleTerminal.shortcuts', {})}
            </Text>
          </div>
        </div>
      </Card>
    </Stack>
  );
}

function isHistoryEntry(value: unknown): value is HistoryEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.command === 'string' && typeof entry.executedAt === 'number';
}

function consolePresets(database: DatabaseRecord): { label: string; command: string }[] {
  const name = database.database_name.replace(/'/g, "''");
  switch (database.protocol) {
    case 'postgres':
      return [
        {
          label: 'Tables',
          command:
            "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY 1, 2;",
        },
        { label: 'Activity', command: 'SELECT pid, usename, state, query FROM pg_stat_activity LIMIT 100;' },
        { label: 'Database size', command: `SELECT pg_size_pretty(pg_database_size('${name}')) AS size;` },
      ];
    case 'mysql':
    case 'mariadb':
      return [
        { label: 'Tables', command: 'SHOW TABLES;' },
        { label: 'Processes', command: 'SHOW PROCESSLIST;' },
        {
          label: 'Database size',
          command: `SELECT SUM(data_length + index_length) AS bytes FROM information_schema.tables WHERE table_schema = '${name}';`,
        },
      ];
    case 'clickhouse':
      return [
        { label: 'Tables', command: 'SHOW TABLES;' },
        { label: 'Processes', command: 'SELECT * FROM system.processes LIMIT 100;' },
        {
          label: 'Parts',
          command:
            'SELECT database, table, sum(bytes_on_disk) AS bytes FROM system.parts WHERE active GROUP BY database, table ORDER BY bytes DESC LIMIT 100;',
        },
      ];
    default:
      return [{ label: 'Example', command: protocolConsoleExamples[database.protocol] }];
  }
}
