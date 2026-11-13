import { afterAll, describe, expect, it } from 'bun:test';
import {
  MacOSKeychainSecretStore,
  runSecurityCli,
  type SecurityCliRunner,
} from './secret-store.ts';

// Round trips against the real macOS Keychain through the real `security` CLI.
// Opt-in: it writes items to the default keychain, so it only runs on macOS
// with SLACKCLI_KEYCHAIN_TESTS=1. CI's macOS job points the default keychain at
// a throwaway one first (.github/workflows/test.yml). Every item uses a
// run-unique account and is deleted afterwards.
const enabled = process.platform === 'darwin' && process.env.SLACKCLI_KEYCHAIN_TESTS === '1';

describe.skipIf(!enabled)('MacOSKeychainSecretStore against the real Keychain', () => {
  const prefix = `slackcli-test-${process.pid}-${Date.now()}`;
  const keys: string[] = [];
  const argvSeen: string[][] = [];

  // The real runner, recording every argv it is handed.
  const recordingRunner: SecurityCliRunner = (args, input) => {
    argvSeen.push(args);
    return runSecurityCli(args, input);
  };
  const store = new MacOSKeychainSecretStore(recordingRunner);

  function key(name: string): string {
    const k = `${prefix} ${name}:token`;
    keys.push(k);
    return k;
  }

  afterAll(async () => {
    for (const k of keys) await store.delete(k);
  });

  it.each([
    // Joined at runtime so secret scanning does not take it for a real token.
    ['an xoxb token', ['xoxb', '1234567890', '0987654321', 'AbCdEfGhIjKlMnOpQrStUvWx'].join('-')],
    ['a URL-encoded xoxd cookie', 'xoxd-AbC%2FdEf%2BgHi%3D%3D'],
    ['a decoded xoxd cookie', 'xoxd-AbC/dEf+gHi=='],
    ['quotes, backslashes and spaces', `a\\b"c d'e\\"f`],
  ])('stores and reads back %s exactly', async (_label, value) => {
    const k = key(_label);
    await store.set(k, value);
    expect(await store.get(k)).toBe(value);
  });

  it('stores under a non-ASCII profile key', async () => {
    const k = key('équipe ✓');
    await store.set(k, 'xoxb-unicode-account');
    expect(await store.get(k)).toBe('xoxb-unicode-account');
  });

  it('updates an existing item in place', async () => {
    const k = key('update');
    await store.set(k, 'xoxb-first');
    await store.set(k, 'xoxb-second');
    expect(await store.get(k)).toBe('xoxb-second');
  });

  it('deletes an item, and reads a missing one as null', async () => {
    const k = key('delete');
    await store.set(k, 'xoxb-gone');
    await store.delete(k);
    expect(await store.get(k)).toBeNull();
    await expect(store.delete(k)).resolves.toBeUndefined();
  });

  it('never handed a secret to security in argv', () => {
    const argv = argvSeen.flat().join('\n');
    for (const marker of ['xoxb-', 'xoxd-', 'a\\b']) {
      expect(argv).not.toContain(marker);
    }
  });
});
