/**
 * Retry policy shared by the Messages API wrapper and the OAuth token
 * endpoint. Pure apart from the timer in waitForRetry, so it can be tested
 * without a network.
 */

/** Statuses the bridge retries itself: rate limited, and overloaded. */
export const RETRYABLE_STATUSES = new Set([429, 529]);

/** Retries per request; opencode's own retry loop takes over after these. */
export const MAX_RESPONSE_RETRIES = 2;

/**
 * Longest wait the bridge sits through before retrying. A longer requested
 * wait (a usage limit that resets in hours) is handed straight back to the
 * caller: opencode's retry loop shows the wait and can be cancelled, while a
 * wait inside fetch looks like a hung request.
 */
export const MAX_RETRY_DELAY_MS = 10_000;

function getOverloadedBackoffMs(attempt: number): number {
  return Math.min(2000 * 2 ** attempt, 8000);
}

/** Parse a Retry-After value (delay seconds or an HTTP date) into milliseconds. */
export function parseRetryAfterMs(value: string | null, now = Date.now()): number | null {
  if (!value?.trim()) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : null;
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(date - now, 0);
  return null;
}

/**
 * Delay before retry `attempt` (0-based) of a retryable response, or null
 * when the server asked for a longer wait than the bridge should absorb.
 */
export function getResponseRetryDelayMs(
  headers: Headers,
  attempt: number,
  now = Date.now(),
): number | null {
  const delayMs = parseRetryAfterMs(headers.get("retry-after"), now)
    ?? getOverloadedBackoffMs(attempt);
  return delayMs > MAX_RETRY_DELAY_MS ? null : delayMs;
}

/**
 * Delay before retry `attempt` (0-based) of the token endpoint, which reports
 * its requested wait as `retry_after` seconds in the JSON body. Null when that
 * wait is longer than the bridge should absorb — the token request is a
 * blocking call, so a long sleep would stall opencode entirely.
 */
export function getTokenRetryDelayMs(
  status: number,
  body: string,
  attempt: number,
  random = Math.random(),
): number | null {
  let requestedMs: number | null = null;
  try {
    const parsed = JSON.parse(body) as {
      retry_after?: number | string;
      error?: { retry_after?: number | string };
    };
    const seconds = Number(parsed.retry_after ?? parsed.error?.retry_after);
    if (Number.isFinite(seconds) && seconds >= 0) requestedMs = seconds * 1000;
  } catch {}

  const delayMs = requestedMs
    ?? (status === 529
      ? getOverloadedBackoffMs(attempt)
      : 1000 * 2 ** attempt + random * 1000);
  return delayMs > MAX_RETRY_DELAY_MS ? null : delayMs;
}

/** Wait before a retry, ending early (with the abort reason) when the request is aborted. */
export function waitForRetry(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
