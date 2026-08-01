/**
 * Minimal Chrome DevTools Protocol (CDP) client.
 *
 * Speaks CDP over a WebSocket so `auth login-auto` can drive a locally
 * launched browser with zero runtime dependencies. Playwright would be the
 * obvious alternative, but slackcli ships as a `bun build --compile` binary:
 * a bundled Playwright blows the 150MB CI budget, and an external one cannot
 * be resolved at all from a downloaded binary (no node_modules). CDP over
 * Bun's built-in WebSocket has neither problem.
 *
 * The protocol itself is tiny for our purposes: send `{id, method, params}`,
 * match the reply by `id`, and treat any message carrying `method` as an
 * event. `createCdpSession` holds that logic and is driven through the
 * `CdpSocket` seam so it unit-tests without a browser; `connectCdpSocket` is
 * the untestable transport edge and is deliberately kept to a few lines.
 */

/** Transport seam. Mirrors the slice of WebSocket this client actually uses. */
export interface CdpSocket {
  send(data: string): void;
  close(): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: () => void): void;
}

export interface CdpSession {
  /** Issue a CDP command and resolve with its result. */
  send<T = Record<string, any>>(
    method: string,
    params?: Record<string, unknown>
  ): Promise<T>;
  /** Subscribe to a CDP event (e.g. `Network.requestWillBeSent`). */
  on(method: string, handler: (params: any) => void): void;
  /** Reject every in-flight command and close the socket. Idempotent. */
  close(): void;
}

/** A CDP command that failed, either protocol-side or by timing out. */
export class CdpError extends Error {
  public method: string;

  constructor(method: string, message: string) {
    super(`CDP ${method} failed: ${message}`);
    this.name = 'CdpError';
    this.method = method;
  }
}

/** Ceiling on a single command. Upgrade to per-method budgets if a slow
 *  domain (e.g. Page.captureScreenshot) ever gets used here. */
const COMMAND_TIMEOUT_MS = 30_000;

/**
 * Build a session over an established socket.
 *
 * Every pending command is tracked so a socket close rejects all of them —
 * without that, a browser the user quits mid-capture leaves promises that
 * never settle and the CLI hangs instead of reporting a clear failure.
 */
export function createCdpSession(
  socket: CdpSocket,
  options: { commandTimeoutMs?: number } = {}
): CdpSession {
  const commandTimeoutMs = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;

  interface Pending {
    resolve: (value: any) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    method: string;
  }

  const pending = new Map<number, Pending>();
  const listeners = new Map<string, Array<(params: any) => void>>();
  let nextId = 1;
  let closed = false;

  const settle = (id: number): Pending | undefined => {
    const entry = pending.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      pending.delete(id);
    }
    return entry;
  };

  socket.onMessage((data) => {
    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      return; // A frame we can't parse is not worth tearing the session down.
    }

    if (typeof msg.id === 'number') {
      const entry = settle(msg.id);
      if (!entry) return;
      if (msg.error) {
        entry.reject(new CdpError(entry.method, msg.error.message ?? 'unknown error'));
      } else {
        entry.resolve(msg.result ?? {});
      }
      return;
    }

    if (typeof msg.method === 'string') {
      const handlers = listeners.get(msg.method);
      if (!handlers) return;
      for (const handler of handlers) {
        try {
          handler(msg.params ?? {});
        } catch {
          // A throwing listener must not kill the message pump or stop the
          // remaining handlers; capture is best-effort by design.
        }
      }
    }
  });

  const rejectAll = (reason: string): void => {
    for (const [id, entry] of [...pending]) {
      settle(id);
      entry.reject(new CdpError(entry.method, reason));
    }
  };

  socket.onClose(() => {
    closed = true;
    rejectAll('socket closed');
  });

  return {
    send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      if (closed) {
        return Promise.reject(new CdpError(method, 'session is closed'));
      }
      return new Promise<T>((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          settle(id);
          reject(new CdpError(method, `timed out after ${commandTimeoutMs}ms`));
        }, commandTimeoutMs);
        pending.set(id, { resolve, reject, timer, method });
        try {
          socket.send(JSON.stringify({ id, method, params }));
        } catch (err: any) {
          settle(id);
          reject(new CdpError(method, err?.message ?? 'send failed'));
        }
      });
    },

    on(method: string, handler: (params: any) => void): void {
      const existing = listeners.get(method);
      if (existing) {
        existing.push(handler);
      } else {
        listeners.set(method, [handler]);
      }
    },

    close(): void {
      if (closed) return;
      closed = true;
      rejectAll('session closed');
      try {
        socket.close();
      } catch {
        // Already gone; nothing to release.
      }
    },
  };
}

/**
 * Connect to a CDP WebSocket endpoint.
 *
 * The transport edge — it cannot be exercised without a live browser, so it
 * stays thin and every decision above it lives in `createCdpSession`.
 */
export function connectCdpSocket(url: string, timeoutMs = 10_000): Promise<CdpSocket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(url);

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // nothing to release
      }
      reject(new Error(`WebSocket connection to the browser timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    ws.onopen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        send: (data) => ws.send(data),
        close: () => ws.close(),
        onMessage: (handler) => {
          ws.onmessage = (ev) => handler(String(ev.data));
        },
        onClose: (handler) => {
          ws.onclose = () => handler();
        },
      });
    };

    ws.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('Could not connect to the browser DevTools endpoint'));
    };
  });
}
