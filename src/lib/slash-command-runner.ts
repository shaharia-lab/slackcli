import type { SlackMessage } from '../types/index.ts';
import { matchesEphemeral, payloadToMessage, syncResponseToMessage } from './ephemeral-capture.ts';

// Slack MS-socket connection details from SlackClient.rtmConnect.
export interface RtmConnection {
  url: string;
  headers: Record<string, string>;
  selfUserId?: string;
}

// Minimal WebSocket surface — the runner only listens and closes.
export interface SocketLike {
  addEventListener(type: 'open' | 'message' | 'error', cb: (ev: any) => void): void;
  close(): void;
}

export type SocketFactory = (url: string, headers: Record<string, string>) => SocketLike;

export interface SlashCommandRunOptions {
  rtm: RtmConnection;
  channelId: string;
  clientToken: string;
  invokeCommand: () => Promise<unknown>;
  timeoutMs: number;
  socketFactory?: SocketFactory;
  // Optional early-exit cap: stop after this many matching ephemeral
  // frames have been captured. Sync HTTP response bodies do not count
  // toward this cap. When unset, the runner waits the full timeoutMs
  // window and returns every ephemeral that arrived in it.
  maxEvents?: number;
}

export interface SlashCommandRunResult {
  messages: SlackMessage[];
  timedOut: boolean;
}

const defaultSocketFactory: SocketFactory = (url, headers) =>
  new WebSocket(url, { headers } as any) as unknown as SocketLike;

// Drives the chat.command + ephemeral-capture flow. Slack does not send a
// terminator frame for slash commands, so timeoutMs doubles as the
// collection window:
//   1. Open socket; arm a `timeoutMs` connection timeout immediately so we
//      do not hang if Slack never sends a `hello` frame.
//   2. On `hello`, invoke the slash command; capture any synchronous reply
//      body, then re-arm the timer for the full post-invocation window.
//   3. Append every matching ephemeral to `captured` and keep listening.
//   4. Settle when the timer fires, OR — if maxEvents is set — early-exit
//      after that many ephemerals.
//   5. timedOut is true only when zero ephemerals arrived. Sync-only
//      replies still count as a successful capture in `messages`, but
//      timedOut reflects the ephemeral stream specifically.
// Every settle path runs cleanup() exactly once: clear timer, close socket.
export async function runSlashCommand(opts: SlashCommandRunOptions): Promise<SlashCommandRunResult> {
  const factory = opts.socketFactory || defaultSocketFactory;
  const captured: SlackMessage[] = [];
  const maxEvents = opts.maxEvents !== undefined ? Math.max(1, opts.maxEvents) : Infinity;
  let ephemeralMatches = 0;

  return new Promise<SlashCommandRunResult>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let invoked = false;
    let settled = false;
    const socket = factory(opts.rtm.url, opts.rtm.headers);

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      try { socket.close(); } catch { /* ignore */ }
    };

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const armTimeout = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(
        () => settle(() => resolve({ messages: captured, timedOut: ephemeralMatches === 0 })),
        opts.timeoutMs,
      );
    };

    // Pre-hello safety net: bound the wait for a `hello` frame.
    armTimeout();

    socket.addEventListener('error', (ev: any) => {
      if (ephemeralMatches > 0) {
        settle(() => resolve({ messages: captured, timedOut: false }));
      } else {
        settle(() => reject(new Error(`WebSocket error: ${ev?.message || 'unknown'}`)));
      }
    });

    socket.addEventListener('message', async (ev: any) => {
      let payload: any;
      try {
        payload = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      } catch {
        return;
      }

      if (payload.type === 'hello' && !invoked) {
        invoked = true;
        try {
          const syncResp = await opts.invokeCommand();
          const synthetic = syncResponseToMessage(syncResp, opts.channelId);
          if (synthetic) captured.push(synthetic);
        } catch (e: any) {
          settle(() => reject(e));
          return;
        }
        // Reset the clock so the post-invocation window is exactly timeoutMs.
        armTimeout();
        return;
      }

      if (matchesEphemeral(payload, opts.channelId, opts.clientToken, opts.rtm.selfUserId)) {
        captured.push(payloadToMessage(payload));
        ephemeralMatches++;
        if (ephemeralMatches >= maxEvents) {
          settle(() => resolve({ messages: captured, timedOut: false }));
        }
      }
    });
  });
}
