// Test-only `bun --preload` for subprocess tests: reroutes FAKE_SLACK_ORIGIN to
// the local server named in FAKE_SLACK_SERVER_ENV. Does nothing without it.
import { FAKE_SLACK_SERVER_ENV, fakeSlackFetch } from './fake-slack.ts';

const server = process.env[FAKE_SLACK_SERVER_ENV];
if (server) {
  globalThis.fetch = fakeSlackFetch(server, globalThis.fetch);
}
