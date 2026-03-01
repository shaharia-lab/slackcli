import { describe, expect, it } from 'bun:test';
import { parseCurlCommand, CurlParseError, looksLikeCurlCommand, extractSlackWorkspaceName } from './curl-parser';

// Sample cURL command with anonymized tokens (based on real Slack API request format)
const SAMPLE_CURL_COMMAND = `curl 'https://myworkspace.slack.com/api/conversations.view?_x_id=noversion-1770041775.173&_x_version_ts=1770035254&_x_frontend_build_type=current&_x_desktop_ia=4&_x_gantry=true&fp=66&_x_num_retries=0' \\
  -H 'accept: */*' \\
  -H 'accept-language: en-US,en-GB;q=0.9,en;q=0.8,de-DE;q=0.7,de;q=0.6' \\
  -H 'content-type: multipart/form-data; boundary=----WebKitFormBoundaryBPkbAXdra05yI37u' \\
  -b 'cjConsent=MHxZfDB8Tnww; ssb_instance_id=53f4c0a9-f40a-4a88-9324-d24baa3bff28; d=xoxd-XXXXXXXXXXXXXXXX-XXXXXXXXXXXXXXXX-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX; lc=1770041685' \\
  -H 'origin: https://app.slack.com' \\
  -H 'user-agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36' \\
  --data-raw $'------WebKitFormBoundaryBPkbAXdra05yI37u\\r\\nContent-Disposition: form-data; name="token"\\r\\n\\r\\nxoxc-XXXXXXXXXX-XXXXXXXXXX-XXXXXXXXXXXXXXXXXX-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX\\r\\n------WebKitFormBoundaryBPkbAXdra05yI37u\\r\\nContent-Disposition: form-data; name="channel"\\r\\n\\r\\nC038K56TGNB\\r\\n------WebKitFormBoundaryBPkbAXdra05yI37u--\\r\\n'`;

// Alternative format with -H 'Cookie:' header instead of -b
const CURL_WITH_COOKIE_HEADER = `curl 'https://testteam.slack.com/api/users.list' \\
  -H 'Cookie: d=xoxd-AAAABBBBCCCCDDDD-1234567890' \\
  --data-raw $'------WebKitFormBoundary\\r\\nContent-Disposition: form-data; name="token"\\r\\n\\r\\nxoxc-111222333-444555666-abcdefghij\\r\\n------WebKitFormBoundary--\\r\\n'`;

// Format with --cookie flag
const CURL_WITH_COOKIE_FLAG = `curl 'https://anotherteam.slack.com/api/channels.list' \\
  --cookie 'd=xoxd-TESTTOKEN-12345; other=value' \\
  --data $'------Boundary\\r\\nContent-Disposition: form-data; name="token"\\r\\n\\r\\nxoxc-test-token-123\\r\\n------Boundary--\\r\\n'`;

// URL-encoded xoxd token (common in real requests)
const CURL_WITH_ENCODED_TOKEN = `curl 'https://encoded.slack.com/api/test' \\
  -b 'd=xoxd-encoded%2Btoken%2Fwith%3Dspecial' \\
  --data-raw $'------Boundary\\r\\nContent-Disposition: form-data; name="token"\\r\\n\\r\\nxoxc-encoded-test\\r\\n------Boundary--\\r\\n'`;

// Enterprise workspace URL format
const CURL_ENTERPRISE = `curl 'https://myorg.enterprise.slack.com/api/conversations.suggestions?_x_id=475c2359-1772039256.240' \\
  -b 'd=xoxd-enterprise-test-token; other=value' \\
  --data-raw $'------Boundary\\r\\nContent-Disposition: form-data; name="token"\\r\\n\\r\\nxoxc-enterprise-test\\r\\n------Boundary--\\r\\n'`;

// Single line format (no backslashes)
const CURL_SINGLE_LINE = `curl 'https://singleline.slack.com/api/test' -b 'd=xoxd-single-line-token' --data-raw $'------Boundary\\r\\nContent-Disposition: form-data; name="token"\\r\\n\\r\\nxoxc-single-line\\r\\n------Boundary--\\r\\n'`;

describe('parseCurlCommand', () => {
  describe('workspace extraction', () => {
    it('should extract workspace name and URL from standard curl command', () => {
      const result = parseCurlCommand(SAMPLE_CURL_COMMAND);
      expect(result.workspaceName).toBe('myworkspace');
      expect(result.workspaceUrl).toBe('https://myworkspace.slack.com');
    });

    it('should extract workspace from different team URLs', () => {
      const result = parseCurlCommand(CURL_WITH_COOKIE_HEADER);
      expect(result.workspaceName).toBe('testteam');
      expect(result.workspaceUrl).toBe('https://testteam.slack.com');
    });

    it('should extract workspace from enterprise URLs', () => {
      const result = parseCurlCommand(CURL_ENTERPRISE);
      expect(result.workspaceName).toBe('myorg');
      expect(result.workspaceUrl).toBe('https://myorg.enterprise.slack.com');
    });

    it('should handle single-line curl commands', () => {
      const result = parseCurlCommand(CURL_SINGLE_LINE);
      expect(result.workspaceName).toBe('singleline');
    });

    it('should throw CurlParseError for missing workspace URL', () => {
      const invalidCurl = `curl 'https://example.com/api/test' -b 'd=xoxd-token'`;
      expect(() => parseCurlCommand(invalidCurl)).toThrow(CurlParseError);
      try {
        parseCurlCommand(invalidCurl);
      } catch (e) {
        expect((e as CurlParseError).field).toBe('workspace');
      }
    });
  });

  describe('xoxd token extraction', () => {
    it('should extract xoxd token from -b flag', () => {
      const result = parseCurlCommand(SAMPLE_CURL_COMMAND);
      expect(result.xoxd).toMatch(/^xoxd-/);
    });

    it('should extract xoxd token from -H Cookie header', () => {
      const result = parseCurlCommand(CURL_WITH_COOKIE_HEADER);
      expect(result.xoxd).toBe('xoxd-AAAABBBBCCCCDDDD-1234567890');
    });

    it('should extract xoxd token from --cookie flag', () => {
      const result = parseCurlCommand(CURL_WITH_COOKIE_FLAG);
      expect(result.xoxd).toBe('xoxd-TESTTOKEN-12345');
    });

    it('should decode URL-encoded xoxd tokens', () => {
      const result = parseCurlCommand(CURL_WITH_ENCODED_TOKEN);
      expect(result.xoxd).toBe('xoxd-encoded+token/with=special');
    });

    it('should throw CurlParseError for missing xoxd token', () => {
      const curlWithoutXoxd = `curl 'https://test.slack.com/api/test' -b 'other=value' --data-raw $'------Boundary\\r\\nContent-Disposition: form-data; name="token"\\r\\n\\r\\nxoxc-test\\r\\n------Boundary--\\r\\n'`;
      expect(() => parseCurlCommand(curlWithoutXoxd)).toThrow(CurlParseError);
      try {
        parseCurlCommand(curlWithoutXoxd);
      } catch (e) {
        expect((e as CurlParseError).field).toBe('xoxd');
      }
    });
  });

  describe('xoxc token extraction', () => {
    it('should extract xoxc token from --data-raw', () => {
      const result = parseCurlCommand(SAMPLE_CURL_COMMAND);
      expect(result.xoxc).toMatch(/^xoxc-/);
    });

    it('should extract xoxc token from --data flag', () => {
      const result = parseCurlCommand(CURL_WITH_COOKIE_FLAG);
      expect(result.xoxc).toBe('xoxc-test-token-123');
    });

    it('should handle different token formats', () => {
      const result = parseCurlCommand(CURL_WITH_COOKIE_HEADER);
      expect(result.xoxc).toBe('xoxc-111222333-444555666-abcdefghij');
    });

    it('should throw CurlParseError for missing xoxc token', () => {
      const curlWithoutXoxc = `curl 'https://test.slack.com/api/test' -b 'd=xoxd-test' --data-raw $'------Boundary\\r\\nContent-Disposition: form-data; name="other"\\r\\n\\r\\nvalue\\r\\n------Boundary--\\r\\n'`;
      expect(() => parseCurlCommand(curlWithoutXoxc)).toThrow(CurlParseError);
      try {
        parseCurlCommand(curlWithoutXoxc);
      } catch (e) {
        expect((e as CurlParseError).field).toBe('xoxc');
      }
    });
  });

  describe('complete parsing', () => {
    it('should parse all tokens from a complete curl command', () => {
      const result = parseCurlCommand(SAMPLE_CURL_COMMAND);

      expect(result).toHaveProperty('workspaceName');
      expect(result).toHaveProperty('workspaceUrl');
      expect(result).toHaveProperty('xoxd');
      expect(result).toHaveProperty('xoxc');

      expect(result.workspaceName).toBeTruthy();
      expect(result.workspaceUrl).toContain('slack.com');
      expect(result.xoxd).toMatch(/^xoxd-/);
      expect(result.xoxc).toMatch(/^xoxc-/);
    });

    it('should handle real-world curl command formats', () => {
      // Test with various real-world formats
      const formats = [
        SAMPLE_CURL_COMMAND,
        CURL_WITH_COOKIE_HEADER,
        CURL_WITH_COOKIE_FLAG,
        CURL_SINGLE_LINE,
        CURL_ENTERPRISE,
      ];

      for (const curl of formats) {
        const result = parseCurlCommand(curl);
        expect(result.xoxd).toMatch(/^xoxd-/);
        expect(result.xoxc).toMatch(/^xoxc-/);
      }
    });
  });
});

describe('CurlParseError', () => {
  it('should have correct name and field properties', () => {
    const error = new CurlParseError('workspace', 'Test error');
    expect(error.name).toBe('CurlParseError');
    expect(error.field).toBe('workspace');
    expect(error.message).toBe('Test error');
  });

  it('should be an instance of Error', () => {
    const error = new CurlParseError('xoxd', 'Test');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(CurlParseError);
  });
});

describe('extractSlackWorkspaceName', () => {
  it('should extract name from standard URL', () => {
    expect(extractSlackWorkspaceName('https://myorg.slack.com')).toBe('myorg');
  });

  it('should extract first segment from enterprise URL', () => {
    expect(extractSlackWorkspaceName('https://myorg.enterprise.slack.com')).toBe('myorg');
  });

  it('should return workspace for non-matching URL', () => {
    expect(extractSlackWorkspaceName('https://example.com')).toBe('workspace');
  });

  it('should handle URLs with paths', () => {
    expect(extractSlackWorkspaceName('https://myorg.slack.com/api/test')).toBe('myorg');
  });
});

describe('looksLikeCurlCommand', () => {
  it('should return true for valid curl commands', () => {
    expect(looksLikeCurlCommand("curl 'https://example.com'")).toBe(true);
    expect(looksLikeCurlCommand('curl "https://example.com"')).toBe(true);
    expect(looksLikeCurlCommand('curl https://example.com')).toBe(true);
    expect(looksLikeCurlCommand('  curl https://example.com')).toBe(true);
    expect(looksLikeCurlCommand('\ncurl https://example.com')).toBe(true);
  });

  it('should return false for non-curl content', () => {
    expect(looksLikeCurlCommand('https://example.com')).toBe(false);
    expect(looksLikeCurlCommand('wget https://example.com')).toBe(false);
    expect(looksLikeCurlCommand('some random text')).toBe(false);
    expect(looksLikeCurlCommand('')).toBe(false);
    expect(looksLikeCurlCommand('curlhttps://example.com')).toBe(false);
  });

  it('should handle curl with tab separator', () => {
    expect(looksLikeCurlCommand('curl\thttps://example.com')).toBe(true);
  });
});
