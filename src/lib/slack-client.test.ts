import { describe, expect, it, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { SlackClient } from './slack-client';
import type { BrowserAuthConfig, StandardAuthConfig } from '../types/index.ts';

const browserConfig: BrowserAuthConfig = {
  workspace_id: 'T00TEST',
  workspace_name: 'test-workspace',
  workspace_url: 'https://test-workspace.slack.com',
  auth_type: 'browser',
  xoxd_token: 'xoxd-test-token',
  xoxc_token: 'xoxc-test-token',
};

// Helper to create a client with a mocked request method
function createMockClient() {
  const client = new SlackClient(browserConfig);
  const requestMock = mock(() => Promise.resolve({}));
  (client as any).request = requestMock;
  return { client, requestMock };
}

describe('SlackClient upload methods', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('getUploadUrl', () => {
    it('should call files.getUploadURLExternal with filename and length', async () => {
      const { client, requestMock } = createMockClient();
      requestMock.mockResolvedValueOnce({
        ok: true,
        upload_url: 'https://files.slack.com/upload/v1/abc123',
        file_id: 'F01TESTFILE',
      });

      const result = await client.getUploadUrl('test.png', 1024);

      expect(requestMock).toHaveBeenCalledWith('files.getUploadURLExternal', {
        filename: 'test.png',
        length: '1024',
      });
      expect(result.upload_url).toBe('https://files.slack.com/upload/v1/abc123');
      expect(result.file_id).toBe('F01TESTFILE');
    });

    it('should pass length as string', async () => {
      const { client, requestMock } = createMockClient();
      requestMock.mockResolvedValueOnce({ ok: true, upload_url: '', file_id: '' });

      await client.getUploadUrl('file.jpg', 999999);

      const callArgs = requestMock.mock.calls[0][1] as Record<string, any>;
      expect(typeof callArgs.length).toBe('string');
      expect(callArgs.length).toBe('999999');
    });
  });

  describe('uploadToUrl', () => {
    it('should POST file content as FormData to the upload URL', async () => {
      const { client } = createMockClient();
      const capturedArgs: { url: string; options: any }[] = [];

      globalThis.fetch = mock(async (url: any, options: any) => {
        capturedArgs.push({ url: url as string, options });
        return new Response(null, { status: 200 });
      }) as any;

      const content = new Uint8Array([1, 2, 3, 4]);
      await client.uploadToUrl('https://files.slack.com/upload/v1/abc', content, 'test.png');

      expect(capturedArgs).toHaveLength(1);
      expect(capturedArgs[0].url).toBe('https://files.slack.com/upload/v1/abc');
      expect(capturedArgs[0].options.method).toBe('POST');
      expect(capturedArgs[0].options.body).toBeInstanceOf(FormData);
    });

    it('should include file with correct filename in FormData', async () => {
      const { client } = createMockClient();
      let capturedBody: FormData | null = null;

      globalThis.fetch = mock(async (_url: any, options: any) => {
        capturedBody = options.body as FormData;
        return new Response(null, { status: 200 });
      }) as any;

      const content = new Uint8Array([10, 20, 30]);
      await client.uploadToUrl('https://example.com/upload', content, 'diagram.png');

      expect(capturedBody).not.toBeNull();
      const file = capturedBody!.get('file') as File;
      expect(file).toBeInstanceOf(File);
      expect(file.name).toBe('diagram.png');
      expect(file.size).toBe(3);
    });

    it('should throw on non-OK response', async () => {
      const { client } = createMockClient();

      globalThis.fetch = mock(async () => {
        return new Response('Server Error', { status: 500 });
      }) as any;

      const content = new Uint8Array([1]);
      await expect(
        client.uploadToUrl('https://example.com/upload', content, 'file.txt')
      ).rejects.toThrow('File upload failed: HTTP 500');
    });
  });

  describe('completeUpload', () => {
    it('should call files.completeUploadExternal with JSON-stringified files', async () => {
      const { client, requestMock } = createMockClient();
      requestMock.mockResolvedValueOnce({ ok: true, files: [{ id: 'F01' }] });

      const files = [{ id: 'F01', title: 'Panel 1' }];
      await client.completeUpload(files, { channel_id: 'C123' });

      expect(requestMock).toHaveBeenCalledWith('files.completeUploadExternal', {
        files: JSON.stringify(files),
        channel_id: 'C123',
      });
    });

    it('should include thread_ts when provided', async () => {
      const { client, requestMock } = createMockClient();
      requestMock.mockResolvedValueOnce({ ok: true, files: [] });

      await client.completeUpload(
        [{ id: 'F01' }],
        { channel_id: 'C123', thread_ts: '1234.5678' }
      );

      const callArgs = requestMock.mock.calls[0][1] as Record<string, any>;
      expect(callArgs.thread_ts).toBe('1234.5678');
    });

    it('should include initial_comment when provided', async () => {
      const { client, requestMock } = createMockClient();
      requestMock.mockResolvedValueOnce({ ok: true, files: [] });

      await client.completeUpload(
        [{ id: 'F01' }],
        { channel_id: 'C123', initial_comment: 'Here are the diagrams' }
      );

      const callArgs = requestMock.mock.calls[0][1] as Record<string, any>;
      expect(callArgs.initial_comment).toBe('Here are the diagrams');
    });

    it('should omit optional params when not provided', async () => {
      const { client, requestMock } = createMockClient();
      requestMock.mockResolvedValueOnce({ ok: true, files: [] });

      await client.completeUpload([{ id: 'F01' }]);

      const callArgs = requestMock.mock.calls[0][1] as Record<string, any>;
      expect(callArgs).not.toHaveProperty('channel_id');
      expect(callArgs).not.toHaveProperty('thread_ts');
      expect(callArgs).not.toHaveProperty('initial_comment');
    });

    it('should handle multiple files in a single complete call', async () => {
      const { client, requestMock } = createMockClient();
      requestMock.mockResolvedValueOnce({
        ok: true,
        files: [{ id: 'F01' }, { id: 'F02' }, { id: 'F03' }],
      });

      const files = [
        { id: 'F01', title: 'Panel 1' },
        { id: 'F02', title: 'Panel 2' },
        { id: 'F03', title: 'Panel 3' },
      ];
      const result = await client.completeUpload(files, { channel_id: 'C123' });

      const callArgs = requestMock.mock.calls[0][1] as Record<string, any>;
      expect(JSON.parse(callArgs.files)).toEqual(files);
      expect(result.files).toHaveLength(3);
    });
  });

  describe('uploadFiles', () => {
    it('should upload each file and call completeUpload once', async () => {
      const { client } = createMockClient();

      // Track calls to individual methods
      const getUploadUrlCalls: any[] = [];
      const uploadToUrlCalls: any[] = [];
      const completeUploadCalls: any[] = [];

      let fileCounter = 0;
      (client as any).getUploadUrl = mock(async (filename: string, length: number) => {
        fileCounter++;
        getUploadUrlCalls.push({ filename, length });
        return { upload_url: `https://upload.example.com/${fileCounter}`, file_id: `F0${fileCounter}` };
      });

      (client as any).uploadToUrl = mock(async (url: string, content: Uint8Array, filename: string) => {
        uploadToUrlCalls.push({ url, filename, size: content.byteLength });
      });

      (client as any).completeUpload = mock(async (files: any[], options: any) => {
        completeUploadCalls.push({ files, options });
        return { ok: true, files: files.map((f: any) => ({ id: f.id })) };
      });

      // Create temp test files
      const tmpDir = '/private/tmp/claude-501/-Users-dweb-repos-lifeos/efcbb41e-e378-42f5-af8b-58eddcec9999/scratchpad';
      await Bun.write(`${tmpDir}/test1.txt`, 'hello');
      await Bun.write(`${tmpDir}/test2.txt`, 'world!');

      const result = await client.uploadFiles(
        [`${tmpDir}/test1.txt`, `${tmpDir}/test2.txt`],
        {
          channel_id: 'C123',
          thread_ts: '1234.5678',
          titles: ['File One', 'File Two'],
        }
      );

      // Should have called getUploadUrl + uploadToUrl for each file
      expect(getUploadUrlCalls).toHaveLength(2);
      expect(uploadToUrlCalls).toHaveLength(2);
      // Should have called completeUpload exactly once with both file IDs
      expect(completeUploadCalls).toHaveLength(1);
      expect(completeUploadCalls[0].files).toEqual([
        { id: 'F01', title: 'File One' },
        { id: 'F02', title: 'File Two' },
      ]);
      expect(completeUploadCalls[0].options.channel_id).toBe('C123');
      expect(completeUploadCalls[0].options.thread_ts).toBe('1234.5678');
    });

    it('should call onProgress for each file and finalization', async () => {
      const { client } = createMockClient();
      const progressMessages: string[] = [];

      (client as any).getUploadUrl = mock(async () => ({
        upload_url: 'https://upload.example.com/1',
        file_id: 'F01',
      }));
      (client as any).uploadToUrl = mock(async () => {});
      (client as any).completeUpload = mock(async (files: any[]) => ({
        ok: true,
        files: files.map((f: any) => ({ id: f.id })),
      }));

      const tmpDir = '/private/tmp/claude-501/-Users-dweb-repos-lifeos/efcbb41e-e378-42f5-af8b-58eddcec9999/scratchpad';
      await Bun.write(`${tmpDir}/progress-test.txt`, 'data');

      await client.uploadFiles([`${tmpDir}/progress-test.txt`], {
        onProgress: (step) => progressMessages.push(step),
      });

      expect(progressMessages).toHaveLength(2);
      expect(progressMessages[0]).toContain('Uploading file 1/1');
      expect(progressMessages[1]).toBe('Finalizing upload...');
    });

    it('should handle files without titles', async () => {
      const { client } = createMockClient();
      let capturedFiles: any[] = [];

      (client as any).getUploadUrl = mock(async () => ({
        upload_url: 'https://upload.example.com/1',
        file_id: 'F01',
      }));
      (client as any).uploadToUrl = mock(async () => {});
      (client as any).completeUpload = mock(async (files: any[], _options: any) => {
        capturedFiles = files;
        return { ok: true, files };
      });

      const tmpDir = '/private/tmp/claude-501/-Users-dweb-repos-lifeos/efcbb41e-e378-42f5-af8b-58eddcec9999/scratchpad';
      await Bun.write(`${tmpDir}/no-title.txt`, 'data');

      await client.uploadFiles([`${tmpDir}/no-title.txt`]);

      expect(capturedFiles).toEqual([{ id: 'F01' }]);
      // No title property should exist
      expect(capturedFiles[0]).not.toHaveProperty('title');
    });

    it('should propagate errors from getUploadUrl', async () => {
      const { client } = createMockClient();

      (client as any).getUploadUrl = mock(async () => {
        throw new Error('Slack API error: not_authed');
      });

      const tmpDir = '/private/tmp/claude-501/-Users-dweb-repos-lifeos/efcbb41e-e378-42f5-af8b-58eddcec9999/scratchpad';
      await Bun.write(`${tmpDir}/error-test.txt`, 'data');

      await expect(
        client.uploadFiles([`${tmpDir}/error-test.txt`], { channel_id: 'C123' })
      ).rejects.toThrow('not_authed');
    });
  });
});
