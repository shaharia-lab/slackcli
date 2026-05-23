import { describe, expect, it } from 'bun:test';
import { runSlashCommand } from './slash-command-runner.ts';
import type { SocketLike, SocketFactory } from './slash-command-runner.ts';

const CH = 'C123';
const TOKEN = 'tok-abc';

type Listener = (ev: any) => void;

interface FakeSocket extends SocketLike {
  emit(type: 'open' | 'message' | 'error', ev: any): void;
  emitFrame(payload: any): void;
  closed: boolean;
}

function makeFakeFactory(): { factory: SocketFactory; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  const factory: SocketFactory = () => {
    const listeners: Record<string, Listener[]> = { open: [], message: [], error: [] };
    const sock: FakeSocket = {
      addEventListener: (type, cb) => { listeners[type].push(cb); },
      close: () => { sock.closed = true; },
      emit: (type, ev) => { listeners[type].forEach(l => l(ev)); },
      emitFrame: (payload) => { listeners.message.forEach(l => l({ data: JSON.stringify(payload) })); },
      closed: false,
    };
    sockets.push(sock);
    return sock;
  };
  return { factory, sockets };
}

const tick = () => new Promise(r => setTimeout(r, 0));

describe('runSlashCommand', () => {
  it('invokes command on hello and captures matching ephemeral frame', async () => {
    const { factory, sockets } = makeFakeFactory();
    let invoked = 0;

    const promise = runSlashCommand({
      rtm: { url: 'ws://x', headers: {} },
      channelId: CH,
      clientToken: TOKEN,
      timeoutMs: 5000,
      socketFactory: factory,
      invokeCommand: async () => { invoked++; return { ok: true }; },
    });

    await tick();
    sockets[0].emitFrame({ type: 'hello' });
    await tick();
    expect(invoked).toBe(1);

    sockets[0].emitFrame({
      type: 'message', channel: CH, is_ephemeral: true, text: 'eph', ts: '1.1',
    });

    const result = await promise;
    expect(result.timedOut).toBe(false);
    expect(result.messages.length).toBe(1);
    expect(result.messages[0].text).toBe('eph');
    expect(sockets[0].closed).toBe(true);
  });

  it('captures synchronous response body alongside ephemeral frame', async () => {
    const { factory, sockets } = makeFakeFactory();

    const promise = runSlashCommand({
      rtm: { url: 'ws://x', headers: {} },
      channelId: CH,
      clientToken: TOKEN,
      timeoutMs: 5000,
      socketFactory: factory,
      invokeCommand: async () => ({ response: { text: 'sync hi' } }),
    });

    await tick();
    sockets[0].emitFrame({ type: 'hello' });
    await tick();
    sockets[0].emitFrame({
      type: 'message', channel: CH, subtype: 'ephemeral', text: 'late', ts: '1.2',
    });

    const result = await promise;
    expect(result.messages.map(m => m.text)).toEqual(['sync hi', 'late']);
  });

  it('resolves with timedOut=true when no ephemeral arrives, returning sync-only messages', async () => {
    const { factory, sockets } = makeFakeFactory();

    const promise = runSlashCommand({
      rtm: { url: 'ws://x', headers: {} },
      channelId: CH,
      clientToken: TOKEN,
      timeoutMs: 5,
      socketFactory: factory,
      invokeCommand: async () => ({ response: { text: 'sync only' } }),
    });

    await tick();
    sockets[0].emitFrame({ type: 'hello' });

    const result = await promise;
    expect(result.timedOut).toBe(true);
    expect(result.messages.map(m => m.text)).toEqual(['sync only']);
    expect(sockets[0].closed).toBe(true);
  });

  it('rejects and cleans up when invokeCommand throws', async () => {
    const { factory, sockets } = makeFakeFactory();
    const boom = new Error('invoke failed');

    const promise = runSlashCommand({
      rtm: { url: 'ws://x', headers: {} },
      channelId: CH,
      clientToken: TOKEN,
      timeoutMs: 5000,
      socketFactory: factory,
      invokeCommand: async () => { throw boom; },
    });

    await tick();
    sockets[0].emitFrame({ type: 'hello' });

    await expect(promise).rejects.toBe(boom);
    expect(sockets[0].closed).toBe(true);
  });

  it('rejects on socket error and closes the socket', async () => {
    const { factory, sockets } = makeFakeFactory();

    const promise = runSlashCommand({
      rtm: { url: 'ws://x', headers: {} },
      channelId: CH,
      clientToken: TOKEN,
      timeoutMs: 5000,
      socketFactory: factory,
      invokeCommand: async () => ({}),
    });

    await tick();
    sockets[0].emit('error', { message: 'kaput' });

    await expect(promise).rejects.toThrow('WebSocket error: kaput');
    expect(sockets[0].closed).toBe(true);
  });

  it('ignores unrelated frames (different channel, non-message types)', async () => {
    const { factory, sockets } = makeFakeFactory();

    const promise = runSlashCommand({
      rtm: { url: 'ws://x', headers: {} },
      channelId: CH,
      clientToken: TOKEN,
      timeoutMs: 20,
      socketFactory: factory,
      invokeCommand: async () => ({}),
    });

    await tick();
    sockets[0].emitFrame({ type: 'hello' });
    sockets[0].emitFrame({ type: 'presence_change', user: 'U1' });
    sockets[0].emitFrame({ type: 'message', channel: 'C_OTHER', is_ephemeral: true, text: 'x' });
    sockets[0].emitFrame({ type: 'message', channel: CH, text: 'normal post' });

    const result = await promise;
    expect(result.timedOut).toBe(true);
    expect(result.messages).toEqual([]);
  });

  it('only invokes the command on the first hello', async () => {
    const { factory, sockets } = makeFakeFactory();
    let invoked = 0;

    const promise = runSlashCommand({
      rtm: { url: 'ws://x', headers: {} },
      channelId: CH,
      clientToken: TOKEN,
      timeoutMs: 5,
      socketFactory: factory,
      invokeCommand: async () => { invoked++; return {}; },
    });

    await tick();
    sockets[0].emitFrame({ type: 'hello' });
    sockets[0].emitFrame({ type: 'hello' });
    sockets[0].emitFrame({ type: 'hello' });

    await promise;
    expect(invoked).toBe(1);
  });

  it('skips frames with non-string data without throwing', async () => {
    const { factory, sockets } = makeFakeFactory();

    const promise = runSlashCommand({
      rtm: { url: 'ws://x', headers: {} },
      channelId: CH,
      clientToken: TOKEN,
      timeoutMs: 10,
      socketFactory: factory,
      invokeCommand: async () => ({}),
    });

    await tick();
    sockets[0].emit('message', { data: 0 });          // non-string, JSON.parse('') throws → swallowed
    sockets[0].emit('message', { data: '{not json' });
    sockets[0].emitFrame({ type: 'hello' });

    const result = await promise;
    expect(result.timedOut).toBe(true);
  });
});
