export interface DbevMutationFailure {
  message: string;
  retryable: boolean;
  requiresReconciliation?: boolean;
  status: number | null;
  code: string | null;
  errorId: string | null;
  retryAfterMs?: number;
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

function retryAfterMilliseconds(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const response = (error as { response?: unknown }).response;
  if (!response || typeof response !== 'object') return undefined;
  const headers = (response as { headers?: unknown }).headers;
  let value: unknown;
  if (headers && typeof headers === 'object' && 'get' in headers && typeof headers.get === 'function') {
    value = headers.get('retry-after');
  } else if (headers && typeof headers === 'object') {
    const record = headers as Record<string, unknown>;
    value = record['retry-after'] ?? record['Retry-After'];
  }
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(String(value));
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function canonicalKind(status: number | null, code: string | null): string | null {
  const normalizedCode = code?.trim().toLowerCase() ?? null;
  if (
    normalizedCode &&
    [
      'bad_request',
      'unauthorized',
      'forbidden',
      'not_found',
      'timeout',
      'conflict',
      'payload_too_large',
      'unsupported_media_type',
      'rate_limited',
      'service_unavailable',
      'internal_error',
    ].includes(normalizedCode)
  ) {
    return normalizedCode;
  }
  return (
    (
      {
        400: 'bad_request',
        401: 'unauthorized',
        403: 'forbidden',
        404: 'not_found',
        408: 'timeout',
        409: 'conflict',
        413: 'payload_too_large',
        415: 'unsupported_media_type',
        429: 'rate_limited',
        500: 'internal_error',
        503: 'service_unavailable',
      } as Record<number, string>
    )[status ?? -1] ?? null
  );
}

export function dbevMutationFailure(error: unknown, fallback: string): DbevMutationFailure {
  const details = responseDetails(error);
  const kind = canonicalKind(details.status, details.code);
  if (kind === 'bad_request') {
    return {
      message: details.message ?? fallback,
      retryable: false,
      status: details.status,
      code: details.code ?? kind,
      errorId: details.errorId,
    };
  }
  if (kind === 'unauthorized') {
    return {
      message:
        'DatabasesEverywhere credentials are expired or invalid. Ask an administrator to update the node credentials.',
      retryable: false,
      status: details.status,
      code: details.code ?? kind,
      errorId: details.errorId,
    };
  }
  if (kind === 'forbidden') {
    return {
      message: 'The DatabasesEverywhere token is missing the required scope for this operation.',
      retryable: false,
      status: details.status,
      code: details.code ?? kind,
      errorId: details.errorId,
    };
  }
  if (kind === 'not_found') {
    return {
      message:
        details.message ?? 'The requested DatabasesEverywhere resource was not found. Refresh and reconcile its state.',
      retryable: false,
      requiresReconciliation: true,
      status: details.status,
      code: details.code ?? kind,
      errorId: details.errorId,
    };
  }
  if (kind === 'timeout') {
    return {
      message: details.message ?? 'The DatabasesEverywhere operation timed out.',
      retryable: false,
      requiresReconciliation: true,
      status: details.status,
      code: details.code ?? kind,
      errorId: details.errorId,
    };
  }
  if (kind === 'conflict') {
    return {
      message:
        details.message ?? 'DatabasesEverywhere rejected the operation because the current state conflicts with it.',
      retryable: false,
      requiresReconciliation: true,
      status: details.status,
      code: details.code ?? kind,
      errorId: details.errorId,
    };
  }
  if (kind === 'payload_too_large') {
    return {
      message: 'The request exceeds the upload maximum configured for this DatabasesEverywhere node.',
      retryable: false,
      status: details.status,
      code: details.code ?? kind,
      errorId: details.errorId,
    };
  }
  if (kind === 'unsupported_media_type') {
    return {
      message: 'DatabasesEverywhere expected a JSON or application/octet-stream request.',
      retryable: false,
      status: details.status,
      code: details.code ?? kind,
      errorId: details.errorId,
    };
  }
  if (kind === 'rate_limited') {
    return {
      message: details.message ?? 'The database host is rate limited. Keep the current form and retry shortly.',
      retryable: true,
      status: details.status,
      code: details.code ?? kind,
      errorId: details.errorId,
      retryAfterMs: retryAfterMilliseconds(error),
    };
  }
  if (kind === 'service_unavailable') {
    return {
      message: 'Database agent is restarting or temporarily unavailable.',
      retryable: true,
      status: details.status,
      code: details.code ?? kind,
      errorId: details.errorId,
    };
  }
  if (kind === 'internal_error') {
    return {
      message: details.errorId
        ? `DatabasesEverywhere could not complete the request (error id: ${details.errorId}).`
        : 'DatabasesEverywhere could not complete the request.',
      retryable: false,
      requiresReconciliation: true,
      status: details.status,
      code: details.code ?? kind,
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
