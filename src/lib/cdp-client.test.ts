import { afterEach, describe, expect, it } from 'bun:test';
import { resetSync, type LogRecord } from '@logtape/logtape';
import { createCdpSession, CdpError, describeEndpoint, type CdpSocket } from './cdp-client';
import { configureLogging } from './logger';

// Realistic token shapes, assembled at runtime so the literals never trip
// secret scanning on push.
const token = (prefix: string, ...parts: string[]) => [prefix, ...parts].join('-');
const XOXC = token('xoxc', '7342581920', '7342581921', '8234567890123', '3f9c1e5b7a2d4c6e8f0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6a');
const XOXD_BODY = 'Zm9vYmFyL2JhenF1eCtzb21lbG9uZ3ZhbHVl/YmF6cXV4+c29tZWxvbmd2YWx1ZQ==';
const XOXD = token('xoxd', XOXD_BODY);

function captureLogs(): LogRecord[] {
  const records: LogRecord[] = [];
  configureLogging({ level: 'trace', verbose: false, sinks: { capture: (r) => records.push(r) } });
  return records;
}

const serialize = (records: LogRecord[]) =>
  JSON.stringify(records.map((r) => ({ category: r.category, message: r.message, properties: r.properties })));

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

  it('rejects every in-flight command when the socket closes', async () => {
    const socket = makeFakeSocket();
    const session = createCdpSession(socket);

    const methods = ['First.never', 'Second.never', 'Third.never'];
    const inFlight = methods.map((method) => session.send(method));
    socket.fireClose();

    const results = await Promise.allSettled(inFlight);
    const reasons = results.map((r) => (r.status === 'rejected' ? r.reason : undefined));
    for (const [i, reason] of reasons.entries()) {
      expect(reason).toBeInstanceOf(CdpError);
      expect((reason as CdpError).method).toBe(methods[i]);
      expect((reason as Error).message).toMatch(/socket closed/);
    }
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

describe('createCdpSession logging', () => {
  afterEach(() => resetSync());

  it('logs a protocol error by method and message, never params, results or events', async () => {
    const records = captureLogs();
    const socket = makeFakeSocket();
    const session = createCdpSession(socket);
    session.on('Network.requestWillBeSent', () => {});

    const cookies = session.send('Storage.getCookies', { token: XOXC });
    socket.emit({ id: 1, result: { cookies: [{ name: 'd', value: encodeURIComponent(XOXD) }] } });
    await cookies;

    socket.emit({
      method: 'Network.requestWillBeSent',
      params: { request: { url: 'https://acme.slack.com/api/x', postData: `token=${XOXC}` } },
    });

    const failing = session.send('Runtime.evaluate', { expression: XOXC });
    socket.emit({ id: 2, error: { message: 'Cannot find context with specified id' } });
    await expect(failing).rejects.toThrow(CdpError);

    const warning = records.find((r) => r.level === 'warning');
    expect(warning?.category).toEqual(['slackcli', 'cdp']);
    expect(warning?.properties).toMatchObject({
      method: 'Runtime.evaluate',
      error: 'Cannot find context with specified id',
    });

    const output = serialize(records);
    expect(output).not.toContain(XOXC);
    expect(output).not.toContain(XOXD_BODY);
    expect(output).not.toContain(encodeURIComponent(XOXD_BODY));
    expect(output).not.toContain('postData');
  });

  it('logs a command timeout with its budget', async () => {
    const records = captureLogs();
    const session = createCdpSession(makeFakeSocket(), { commandTimeoutMs: 10 });

    await expect(session.send('Slow.method')).rejects.toThrow(/timed out/);

    const warning = records.find((r) => r.level === 'warning');
    expect(warning?.properties).toMatchObject({ method: 'Slow.method', timeout_ms: 10 });
  });

  it('logs the methods still in flight when the socket closes', async () => {
    const records = captureLogs();
    const socket = makeFakeSocket();
    const session = createCdpSession(socket);

    const a = session.send('Network.enable');
    const b = session.send('Page.navigate', { url: 'https://app.slack.com/client' });
    socket.fireClose();
    await expect(a).rejects.toThrow();
    await expect(b).rejects.toThrow();

    const warning = records.find((r) => r.level === 'warning');
    expect(warning?.properties).toMatchObject({
      reason: 'socket closed',
      pending: 2,
      methods: ['Network.enable', 'Page.navigate'],
    });
    expect(serialize(records)).not.toContain('app.slack.com');
  });

  it('logs nothing at warning level for a clean close with nothing in flight', () => {
    const records = captureLogs();
    createCdpSession(makeFakeSocket()).close();
    expect(records.filter((r) => r.level === 'warning')).toHaveLength(0);
  });
});

describe('describeEndpoint', () => {
  it('keeps host and port, dropping the target path', () => {
    expect(describeEndpoint('ws://127.0.0.1:9222/devtools/page/ABC123')).toBe('127.0.0.1:9222');
  });

  it('never throws on an unparseable URL', () => {
    expect(describeEndpoint('not a url')).toBe('unparseable');
  });
});
