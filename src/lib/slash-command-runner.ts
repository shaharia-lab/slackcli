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
}

export interface SlashCommandRunResult {
  messages: SlackMessage[];
  timedOut: boolean;
}

const defaultSocketFactory: SocketFactory = (url, headers) =>
  new WebSocket(url, { headers } as any) as unknown as SocketLike;

// Drives the chat.command + ephemeral-capture flow:
//   1. Open socket, wait for "hello".
//   2. Invoke the slash command; capture any synchronous reply body.
//   3. Watch incoming frames; the first frame matching matchesEphemeral
//      resolves the run.
//   4. If no ephemeral arrives within timeoutMs, resolve with timedOut=true.
// Every settle path runs cleanup() exactly once: clear timer, close socket.
export async function runSlashCommand(opts: SlashCommandRunOptions): Promise<SlashCommandRunResult> {
  const factory = opts.socketFactory || defaultSocketFactory;
  const captured: SlackMessage[] = [];

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

    socket.addEventListener('error', (ev: any) => {
      settle(() => reject(new Error(`WebSocket error: ${ev?.message || 'unknown'}`)));
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
        timer = setTimeout(
          () => settle(() => resolve({ messages: captured, timedOut: true })),
          opts.timeoutMs,
        );
        return;
      }

      if (matchesEphemeral(payload, opts.channelId, opts.clientToken, opts.rtm.selfUserId)) {
        captured.push(payloadToMessage(payload));
        settle(() => resolve({ messages: captured, timedOut: false }));
      }
    });
  });
}
