import { useCallback, useEffect, useRef, useState } from 'react';
import { getDatabaseRuntime, getDatabaseStatus, mintDatabaseWebSocketToken } from '../api/client.ts';
import { normalizeDatabaseMonitoringInstances, scannerRestartBlockedState } from '../api/normalizers.ts';
import type { DatabaseInstallProgress, DatabaseMonitoringInstance, DatabaseWebSocketChannel } from '../api/types.ts';
import { isDatabaseProgressActive } from './installProgress.ts';
import { isExpectedDaemonRestart, ReconnectController } from './websocketReconnect.ts';

export type LiveConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'unavailable';

export interface MonitoringMessage {
  type?: string;
  instances?: DatabaseMonitoringInstance[];
  install_progress?: DatabaseInstallProgress[];
}

interface LogsMessage {
  type?: string;
  instance_id?: string;
  sequence?: number;
  stdout?: string | null;
  stderr?: string | null;
  error?: unknown;
}

interface ImportExportMessage {
  type?: string;
  jobs?: unknown[];
  job?: unknown;
}

const MAX_LOG_LINES = 2_000;

interface DatabaseSocketMessageAction {
  error?: string;
  reconnect?: boolean;
}

function parseJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function diagnosticMessage(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (!value || typeof value !== 'object') return null;

  const diagnostic = value as Record<string, unknown>;
  const message = diagnostic.message ?? diagnostic.error ?? diagnostic.detail ?? diagnostic.cause;
  const text = diagnosticMessage(message);
  if (!text) return null;

  const code = typeof diagnostic.code === 'string' ? diagnostic.code.trim() : '';
  const errorId = typeof diagnostic.error_id === 'string' ? diagnostic.error_id.trim() : '';
  return `${text}${code ? ` [${code}]` : ''}${errorId ? ` (error id: ${errorId})` : ''}`;
}

function logLines(message: LogsMessage): string[] {
  const lines: string[] = [];
  if (message.stdout) lines.push(...message.stdout.split('\n'));
  if (message.stderr) lines.push(...message.stderr.split('\n').map((line) => (line ? `[stderr] ${line}` : line)));
  return lines.filter((line, index, source) => line || index < source.length - 1);
}

function useDatabaseSocket(
  server: string,
  database: string,
  channel: DatabaseWebSocketChannel,
  enabled: boolean,
  onMessage: (payload: Record<string, unknown>) => DatabaseSocketMessageAction | void,
  instances?: string[],
  reconnectKey = 0,
  onReconnected?: () => void | Promise<void>,
) {
  const [state, setState] = useState<LiveConnectionState>(enabled ? 'connecting' : 'unavailable');
  const [error, setError] = useState<string | null>(null);
  const callback = useRef(onMessage);
  callback.current = onMessage;
  const reconnectedCallback = useRef(onReconnected);
  reconnectedCallback.current = onReconnected;
  const instanceScope = instances ? [...new Set(instances)].sort().join(',') : '';

  useEffect(() => {
    if (!enabled || !server || !database) {
      setState('unavailable');
      setError(null);
      return;
    }

    let disposed = false;
    let socket: WebSocket | null = null;
    let stabilityTimer: number | null = null;
    let reconnects = 0;
    let generation = 0;
    let connectedAttempt = 0;
    const reconnectController = new ReconnectController(
      (callback, delay) => window.setTimeout(callback, delay),
      (timer) => window.clearTimeout(timer),
    );

    const scheduleReconnect = () => {
      if (disposed) return;
      const nextAttempt = reconnects + 1;
      if (
        reconnectController.schedule(nextAttempt, () => {
          void connect();
        })
      ) {
        reconnects = nextAttempt;
        setState('reconnecting');
      }
    };

    const connect = async () => {
      if (disposed) return;
      const attempt = ++generation;
      setState(reconnects ? 'reconnecting' : 'connecting');

      try {
        // Reconnects require a fresh single-use token.
        const details = await mintDatabaseWebSocketToken(
          server,
          database,
          channel,
          instanceScope ? instanceScope.split(',') : undefined,
        );
        if (disposed || attempt !== generation) return;

        socket = new WebSocket(details.url, ['dbe.jwt', details.token]);
        socket.onopen = () => {
          if (disposed || attempt !== generation) return;
          if (stabilityTimer !== null) window.clearTimeout(stabilityTimer);
          stabilityTimer = window.setTimeout(() => {
            if (!disposed && attempt === generation && socket?.readyState === WebSocket.OPEN) reconnects = 0;
            stabilityTimer = null;
          }, 10_000);
          setState(reconnects ? 'reconnecting' : 'connecting');
        };
        socket.onmessage = (event) => {
          const payload = parseJson(event.data);
          if (!payload || disposed || attempt !== generation) return;
          const action = callback.current(payload);
          if (action?.reconnect) {
            setError(action.error || 'The live stream ended and is reconnecting.');
            setState('reconnecting');
            socket?.close();
            return;
          }
          setError(null);
          setState('connected');
          if (connectedAttempt !== attempt) {
            if (connectedAttempt !== 0) {
              void Promise.resolve(reconnectedCallback.current?.()).catch(() => undefined);
            }
            connectedAttempt = attempt;
          }
        };
        socket.onerror = () => {
          if (!disposed && attempt === generation) setError('Live updates could not reach the database host.');
        };
        socket.onclose = (event) => {
          if (disposed || attempt !== generation) return;
          socket = null;
          if (stabilityTimer !== null) window.clearTimeout(stabilityTimer);
          stabilityTimer = null;
          if (isExpectedDaemonRestart(event.code, event.reason)) {
            setError(null);
            setState('reconnecting');
          }
          scheduleReconnect();
        };
      } catch (cause) {
        if (disposed || attempt !== generation) return;
        setError(cause instanceof Error ? cause.message : 'Unable to start live updates.');
        scheduleReconnect();
      }
    };

    void connect();

    return () => {
      disposed = true;
      generation += 1;
      reconnectController.cancel();
      if (stabilityTimer !== null) window.clearTimeout(stabilityTimer);
      socket?.close();
    };
  }, [channel, database, enabled, instanceScope, reconnectKey, server]);

  return { state, error };
}

export function useDatabaseMonitoringEvents({
  server,
  database,
  instances,
  enabled = true,
  onMessage,
  onReconnected,
}: {
  server: string;
  database: string;
  instances?: string[];
  enabled?: boolean;
  onMessage: (message: MonitoringMessage) => void;
  onReconnected?: () => void | Promise<void>;
}) {
  return useDatabaseSocket(
    server,
    database,
    'monitor',
    enabled,
    (raw) =>
      onMessage({
        ...raw,
        ...(Object.hasOwn(raw, 'instances') ? { instances: normalizeDatabaseMonitoringInstances(raw.instances) } : {}),
      } as MonitoringMessage),
    instances,
    0,
    onReconnected,
  );
}

export function useDatabaseLiveOverview({
  server,
  database,
  logsEnabled,
  onStatusChange,
}: {
  server: string;
  database: string;
  logsEnabled: boolean;
  onStatusChange?: (status: string) => void;
}) {
  const [instance, setInstance] = useState<DatabaseMonitoringInstance | null>(null);
  const [progress, setProgress] = useState<DatabaseInstallProgress | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [logReconnectKey, setLogReconnectKey] = useState(0);
  const previousStatus = useRef<string | null>(null);

  useEffect(() => {
    setInstance(null);
    setProgress(null);
    setLogs([]);
    previousStatus.current = null;
  }, [database]);

  const reconnectLogs = useCallback(() => setLogReconnectKey((current) => current + 1), []);
  const refreshAfterReconnect = useCallback(async () => {
    const [status] = await Promise.all([getDatabaseStatus(server, database), getDatabaseRuntime(server, database)]);
    if (status.status) onStatusChange?.(status.status);
  }, [database, onStatusChange, server]);

  const monitoring = useDatabaseMonitoringEvents({
    server,
    database,
    onReconnected: refreshAfterReconnect,
    onMessage: (message) => {
      if (message.type !== 'stats') return;
      const next = message.instances?.find((item) => item.instance_id === database) ?? null;
      if (next) {
        const nextStatus = next.status ?? null;
        if (logsEnabled && nextStatus === 'running' && previousStatus.current && previousStatus.current !== 'running') {
          reconnectLogs();
        }
        if (nextStatus && nextStatus !== previousStatus.current) onStatusChange?.(nextStatus);
        previousStatus.current = nextStatus;
        setInstance((current) => {
          const resources = next.resources;
          if (!resources) return next;
          const disk = resources.disk;
          const blocked = scannerRestartBlockedState(disk, current?.resources?.disk.scanner_restart_blocked);
          if (blocked === undefined || blocked === disk.scanner_restart_blocked) return next;
          return {
            ...next,
            resources: {
              ...resources,
              disk: { ...disk, scanner_restart_blocked: blocked },
            },
          };
        });
      }
      const reportedProgress = message.install_progress?.find((item) => item.instance_id === database) ?? null;
      setProgress(
        reportedProgress && next?.status && !isDatabaseProgressActive(reportedProgress, next.status)
          ? null
          : reportedProgress,
      );
    },
  });

  const logStream = useDatabaseSocket(
    server,
    database,
    'logs',
    logsEnabled,
    (raw) => {
      const message = raw as LogsMessage;
      if (message.type !== 'logs' || message.instance_id !== database) return;

      const streamError = diagnosticMessage(message.error);
      if (streamError) {
        const line = `[stream error] ${streamError}`;
        setLogs((current) => (current.at(-1) === line ? current : [...current, line].slice(-MAX_LOG_LINES)));
        // Attach a new follower after the managed container is replaced.
        return { error: streamError, reconnect: true };
      }

      setLogs(logLines(message).slice(-MAX_LOG_LINES));
    },
    undefined,
    logReconnectKey,
  );

  return { instance, progress, logs, monitoring, logStream, reconnectLogs };
}

export function useImportExportEvents(server: string, database: string, enabled = true) {
  const [jobs, setJobs] = useState<unknown[] | null>(null);
  const socket = useDatabaseSocket(
    server,
    database,
    'import-export',
    enabled,
    (raw) => {
      const message = raw as ImportExportMessage;
      if (message.type === 'import_export_snapshot' && Array.isArray(message.jobs)) {
        setJobs(message.jobs);
      } else if (message.type === 'import_export_job' && message.job) {
        setJobs((current) => {
          const next = [...(current ?? [])];
          const incoming = message.job as Record<string, unknown>;
          const id = String(incoming.job_id ?? incoming.id ?? '');
          const index = next.findIndex((item) => {
            if (typeof item !== 'object' || item === null) return false;
            const record = item as Record<string, unknown>;
            return String(record.job_id ?? record.id ?? '') === id;
          });
          if (index >= 0) next[index] = message.job;
          else next.unshift(message.job);
          return next;
        });
      }
    },
    undefined,
    0,
    async () => {
      await Promise.all([getDatabaseStatus(server, database), getDatabaseRuntime(server, database)]);
    },
  );

  useEffect(() => setJobs(null), [database]);
  return { jobs, ...socket };
}
