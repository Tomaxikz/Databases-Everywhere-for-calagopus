import { useComputedColorScheme } from '@mantine/core';
import { FitAddon } from '@xterm/addon-fit';
import { type ITerminalInitOnlyOptions, type ITerminalOptions, Terminal as XTerm } from '@xterm/xterm';
import { useEffect, useRef } from 'react';
import { getXtermTheme } from '@/lib/xterm.ts';
import type { DatabaseProtocol, QueryOutput } from '../../api/types.ts';
import translations from '../../translations.ts';
import { parseTerminalOutput, safeTerminalText } from './terminalOutput.ts';

import '@xterm/xterm/css/xterm.css';
import '@/lib/xterm.css';

export interface ConsoleEntry {
  id: number;
  command: string;
  executedAt: number;
  state: 'running' | 'success' | 'error';
  output?: QueryOutput;
  error?: string;
}

interface DatabaseTerminalProps {
  entries: ConsoleEntry[];
  prompt: string;
  protocol: DatabaseProtocol;
  protocolLabel: string;
  databaseName: string;
}

const ANSI = {
  reset: '\x1b[0m',
  boldPrimary: '\x1b[1;35m',
  dim: '\x1b[2m',
  error: '\x1b[31m',
  success: '\x1b[32m',
  warning: '\x1b[33m',
} as const;

export default function DatabaseTerminal({
  entries,
  prompt,
  protocol,
  protocolLabel,
  databaseName,
}: DatabaseTerminalProps) {
  const { t } = translations.useTranslations();
  const colorScheme = useComputedColorScheme('dark');
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const options: ITerminalOptions & ITerminalInitOnlyOptions = {
      fontSize: 14,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      theme: getXtermTheme(colorScheme === 'dark'),
      allowTransparency: true,
      convertEol: true,
      cursorBlink: false,
      disableStdin: true,
      lineHeight: 1.25,
      screenReaderMode: true,
      scrollback: 5000,
      smoothScrollDuration: 0,
    };
    const terminal = new XTerm(options);
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    terminal.write('\x1b[?25l');
    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    let frame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        fitAddon.fit();
      });
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = getXtermTheme(colorScheme === 'dark');
    }
  }, [colorScheme]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    terminal.reset();
    terminal.write('\x1b[?25l');
    writeLine(
      terminal,
      `${ANSI.boldPrimary}${safeTerminalText(
        t('server.consoleTerminal.welcome', { protocol: protocolLabel, database: databaseName }),
      )}${ANSI.reset}`,
    );
    writeLine(terminal, `${ANSI.dim}${safeTerminalText(t('server.consoleTerminal.ready', {}))}${ANSI.reset}`);

    for (const entry of entries) {
      writeLine(terminal, '');
      writeCommand(terminal, prompt, entry.command);

      if (entry.state === 'running') {
        writeLine(
          terminal,
          `${ANSI.warning}${safeTerminalText(t('server.consoleTerminal.executing', {}))}${ANSI.reset}`,
        );
        continue;
      }

      if (entry.state === 'error') {
        const error = entry.error ?? t('server.consoleTerminal.unknownError', {});
        writeLine(
          terminal,
          `${ANSI.error}${safeTerminalText(t('server.consoleTerminal.error', { error }))}${ANSI.reset}`,
        );
        continue;
      }

      if (!entry.output) continue;
      const parsed = parseTerminalOutput(protocol, entry.output);
      if (parsed.content) {
        for (const line of safeTerminalText(parsed.content).split('\n')) writeLine(terminal, line);
      }

      const summary =
        parsed.rowCount > 0
          ? t('server.consoleTerminal.rowsInSet', { count: parsed.rowCount, elapsed: parsed.elapsedMs })
          : parsed.affectedRows !== null
            ? t('server.consoleTerminal.queryOk', { count: parsed.affectedRows, elapsed: parsed.elapsedMs })
            : t('server.consoleTerminal.emptySet', { elapsed: parsed.elapsedMs });
      writeLine(terminal, `${ANSI.success}${safeTerminalText(summary)}${ANSI.reset}`);
      if (parsed.truncated) {
        writeLine(
          terminal,
          `${ANSI.warning}${safeTerminalText(t('server.consoleTerminal.truncated', {}))}${ANSI.reset}`,
        );
      }
    }

    terminal.scrollToBottom();
    const frame = requestAnimationFrame(() => fitAddonRef.current?.fit());
    return () => cancelAnimationFrame(frame);
  }, [databaseName, entries, prompt, protocol, protocolLabel, t]);

  return (
    <div
      className='relative min-h-0 min-w-0 overflow-hidden bg-(--mantine-color-body) p-2'
      style={{ height: 'clamp(420px, calc(100dvh - 420px), 720px)' }}
      role='log'
      aria-live='polite'
    >
      <div ref={containerRef} className='absolute inset-2' />
    </div>
  );
}

function writeLine(terminal: XTerm, text: string) {
  terminal.write(`${text}\r\n`);
}

function writeCommand(terminal: XTerm, prompt: string, command: string) {
  const lines = safeTerminalText(command).split('\n');
  writeLine(terminal, `${ANSI.boldPrimary}${safeTerminalText(prompt)}${ANSI.reset} ${lines[0] ?? ''}`);
  const continuation = `${' '.repeat(Math.max(0, prompt.length - 3))}... `;
  for (const line of lines.slice(1)) {
    writeLine(terminal, `${ANSI.dim}${continuation}${ANSI.reset}${line}`);
  }
}
