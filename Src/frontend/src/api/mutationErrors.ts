export interface DbevMutationFailure {
  message: string;
  retryable: boolean;
  requiresReconciliation?: boolean;
  status: number | null;
  code: string | null;
  errorId: string | null;
}

export function responseStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const response = (error as { response?: unknown }).response;
  if (!response || typeof response !== 'object') return null;
  const status = (response as { status?: unknown }).status;
  return typeof status === 'number' ? status : null;
}

function embeddedErrorDetails(message: string | null): {
  message: string | null;
  code: string | null;
  errorId: string | null;
} {
  if (!message) return { message: null, code: null, errorId: null };
  const errorId = message.match(/\s*\(error id:\s*([^\s)]+)\)\s*$/iu)?.[1] ?? null;
  const withoutId = message.replace(/\s*\(error id:\s*[^\s)]+\)\s*$/iu, '').trim();
  const code = withoutId.match(/\s*\[([^\]]+)\]\s*$/u)?.[1] ?? null;
  const clean = withoutId.replace(/\s*\[[^\]]+\]\s*$/u, '').trim();
  return { message: clean || message, code, errorId };
}

function responseDetails(error: unknown): {
  status: number | null;
  message: string | null;
  code: string | null;
  errorId: string | null;
} {
  if (!error || typeof error !== 'object') return { status: null, message: null, code: null, errorId: null };
  const response = (error as { response?: unknown }).response;
  if (!response || typeof response !== 'object') return { status: null, message: null, code: null, errorId: null };
  const status =
    typeof (response as { status?: unknown }).status === 'number' ? (response as { status: number }).status : null;
  const data = (response as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return { status, message: null, code: null, errorId: null };
  const record = data as Record<string, unknown>;
  const firstError = Array.isArray(record.errors) ? record.errors[0] : null;
  const nested = firstError && typeof firstError === 'object' ? (firstError as Record<string, unknown>) : null;
  const candidate =
    record.error ??
    record.message ??
    record.detail ??
    nested?.detail ??
    nested?.message ??
    (Array.isArray(record.errors) ? record.errors.find((item) => typeof item === 'string') : null);
  const code = record.code ?? nested?.code;
  const errorId = record.error_id ?? nested?.error_id;
  const embedded = embeddedErrorDetails(typeof candidate === 'string' ? candidate.trim() : null);
  return {
    status,
    message: embedded.message,
    code: typeof code === 'string' && code.trim() ? code.trim() : embedded.code,
    errorId: typeof errorId === 'string' && errorId.trim() ? errorId.trim() : embedded.errorId,
  };
}

export function dbevMutationFailure(error: unknown, fallback: string): DbevMutationFailure {
  const details = responseDetails(error);
  if (details.status === 429) {
    return {
      message: details.message ?? 'The database host is rate limited. Keep the current form and retry shortly.',
      retryable: true,
      status: details.status,
      code: details.code ?? 'rate_limited',
      errorId: details.errorId,
    };
  }
  if (details.status === 503) {
    const unavailable = 'Database agent is restarting or temporarily unavailable.';
    const normalized = details.message?.toLowerCase().replaceAll('_', ' ') ?? '';
    return {
      message:
        details.message && !normalized.includes('service unavailable')
          ? `${unavailable} ${details.message}`
          : unavailable,
      retryable: true,
      status: details.status,
      code: details.code,
      errorId: details.errorId,
    };
  }
  if (details.status === null) {
    return {
      message: `${details.message ?? fallback} Check the current database and transfer state before submitting again.`,
      retryable: false,
      requiresReconciliation: true,
      status: null,
      code: details.code,
      errorId: details.errorId,
    };
  }
  return {
    message: details.message ?? fallback,
    retryable: false,
    status: details.status,
    code: details.code,
    errorId: details.errorId,
  };
}
