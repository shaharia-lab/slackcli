import { describe, expect, it } from 'bun:test';
import { createCdpSession, CdpError, type CdpSocket } from './cdp-client';

interface FakeSocket extends CdpSocket {
  sent: string[];
  emit: (message: unknown) => void;
  fireClose: () => void;
  closed: boolean;
}

function makeFakeSocket(): FakeSocket {
  let onMessage: (data: string) => void = () => {};
  let onClose: () => void = () => {};
  const socket: FakeSocket = {
    sent: [],
    closed: false,
    send(data) {
      socket.sent.push(data);
    },
    close() {
      socket.closed = true;
    },
    onMessage(handler) {
      onMessage = handler;
    },
    onClose(handler) {
      onClose = handler;
    },
    emit(message) {
      onMessage(typeof message === 'string' ? message : JSON.stringify(message));
    },
    fireClose() {
      onClose();
    },
  };
  return socket;
}

describe('createCdpSession', () => {
  it('correlates a reply to its command by id', async () => {
    const socket = makeFakeSocket();
    const session = createCdpSession(socket);

    const pending = session.send('Network.getCookies');
    const sent = JSON.parse(socket.sent[0]);
    expect(sent.method).toBe('Network.getCookies');

    socket.emit({ id: sent.id, result: { cookies: [{ name: 'd' }] } });
    await expect(pending).resolves.toEqual({ cookies: [{ name: 'd' }] });
  });

  it('resolves concurrent commands to their own replies', async () => {
    const socket = makeFakeSocket();
    const session = createCdpSession(socket);

    const first = session.send('A');
    const second = session.send('B');
    const [idA, idB] = socket.sent.map((s) => JSON.parse(s).id);

    // Replied out of order on purpose — correlation must be by id, not arrival.
    socket.emit({ id: idB, result: { which: 'B' } });
    socket.emit({ id: idA, result: { which: 'A' } });

    await expect(first).resolves.toEqual({ which: 'A' });
    await expect(second).resolves.toEqual({ which: 'B' });
  });

  it('rejects with CdpError when the protocol reports an error', async () => {
    const socket = makeFakeSocket();
    const session = createCdpSession(socket);

    const pending = session.send('Bad.method');
    const { id } = JSON.parse(socket.sent[0]);
    socket.emit({ id, error: { code: -32601, message: 'not found' } });

    await expect(pending).rejects.toThrow(CdpError);
  });

  it('dispatches events to subscribers', () => {
    const socket = makeFakeSocket();
    const session = createCdpSession(socket);

    const seen: any[] = [];
    session.on('Network.requestWillBeSent', (params) => seen.push(params));
    socket.emit({ method: 'Network.requestWillBeSent', params: { request: { url: 'x' } } });

    expect(seen).toEqual([{ request: { url: 'x' } }]);
  });

  it('delivers an event to every subscriber', () => {
    const socket = makeFakeSocket();
    const session = createCdpSession(socket);

    let count = 0;
    session.on('E', () => count++);
    session.on('E', () => count++);
    socket.emit({ method: 'E', params: {} });

    expect(count).toBe(2);
  });

  it('keeps dispatching after a listener throws', () => {
    const socket = makeFakeSocket();
    const session = createCdpSession(socket);

    let reached = false;
    session.on('E', () => {
      throw new Error('listener blew up');
    });
    session.on('E', () => {
      reached = true;
    });
    socket.emit({ method: 'E', params: {} });

    expect(reached).toBe(true);
  });

  it('ignores unparseable frames', () => {
    const socket = makeFakeSocket();
    createCdpSession(socket);
    expect(() => socket.emit('<<<not json>>>')).not.toThrow();
  });

  it('rejects in-flight commands when the socket closes', async () => {
    const socket = makeFakeSocket();
    const session = createCdpSession(socket);

    const pending = session.send('Never.answered');
    socket.fireClose();

    await expect(pending).rejects.toThrow(/socket closed/);
  });

  it('rejects commands issued after close', async () => {
    const socket = makeFakeSocket();
    const session = createCdpSession(socket);

    session.close();
    await expect(session.send('Anything')).rejects.toThrow(/closed/);
  });

  it('closes the underlying socket, and close is idempotent', () => {
    const socket = makeFakeSocket();
    const session = createCdpSession(socket);

    session.close();
    session.close();
    expect(socket.closed).toBe(true);
  });

  it('times out a command that is never answered', async () => {
    const socket = makeFakeSocket();
    const session = createCdpSession(socket, { commandTimeoutMs: 10 });

    await expect(session.send('Slow.method')).rejects.toThrow(/timed out/);
  });
});
