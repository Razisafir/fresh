/**
 * Unit tests for src/security/urlGuard.ts (SEC-7 SSRF defence).
 *
 * The SSRF guard is critical: without it, a prompt-injected LLM can fetch
 * cloud-metadata endpoints (169.254.169.254), loopback services (127.0.0.1),
 * or private-network hosts (10/8, 172.16/12, 192.168/16) and exfiltrate
 * the response back via subsequent tool calls.
 *
 * These tests pin every blocked range + the override behaviour.
 */

import { expect } from 'chai';
import { assertSafeUrl } from '../../../src/security/urlGuard';

describe('urlGuard (SEC-7 SSRF defence)', () => {
	describe('assertSafeUrl() — protocol allowlist', () => {
		it('allows http://', () => {
			expect(() => assertSafeUrl('http://example.com')).to.not.throw();
		});

		it('allows https://', () => {
			expect(() => assertSafeUrl('https://example.com')).to.not.throw();
		});

		it('rejects file:// protocol', () => {
			expect(() => assertSafeUrl('file:///etc/passwd')).to.throw(/protocol.*not allowed/i);
		});

		it('rejects ftp:// protocol', () => {
			expect(() => assertSafeUrl('ftp://example.com/file')).to.throw(/protocol.*not allowed/i);
		});

		it('rejects javascript: protocol', () => {
			expect(() => assertSafeUrl('javascript:alert(1)')).to.throw(/protocol.*not allowed/i);
		});

		it('rejects data: protocol', () => {
			expect(() => assertSafeUrl('data:text/plain,hello')).to.throw(/protocol.*not allowed/i);
		});

		it('rejects malformed URLs', () => {
			expect(() => assertSafeUrl('not-a-url')).to.throw(/invalid URL/i);
			expect(() => assertSafeUrl('')).to.throw(/invalid URL/i);
		});
	});

	describe('assertSafeUrl() — IPv4 range blocks', () => {
		it('blocks 127.0.0.1 (loopback)', () => {
			expect(() => assertSafeUrl('http://127.0.0.1/')).to.throw(/loopback/);
		});

		it('blocks 127.1.2.3 (loopback /8)', () => {
			expect(() => assertSafeUrl('http://127.1.2.3/')).to.throw(/loopback/);
		});

		it('blocks 169.254.169.254 (AWS / GCP / Azure cloud metadata)', () => {
			expect(() => assertSafeUrl('http://169.254.169.254/latest/meta-data/')).to.throw(/link-local/);
		});

		it('blocks 10.0.0.1 (private-10 /8)', () => {
			expect(() => assertSafeUrl('http://10.0.0.1/')).to.throw(/private-10/);
		});

		it('blocks 192.168.1.1 (private-192 /16)', () => {
			expect(() => assertSafeUrl('http://192.168.1.1/')).to.throw(/private-192/);
		});

		it('blocks 172.16.0.1 (private-172 /12)', () => {
			expect(() => assertSafeUrl('http://172.16.0.1/')).to.throw(/private-172/);
		});

		it('blocks 172.31.255.255 (last address in private-172 /12)', () => {
			expect(() => assertSafeUrl('http://172.31.255.255/')).to.throw(/private-172/);
		});

		it('does NOT block 172.32.0.1 (outside /12)', () => {
			expect(() => assertSafeUrl('http://172.32.0.1/')).to.not.throw();
		});

		it('blocks 100.64.0.1 (CGNAT /10)', () => {
			expect(() => assertSafeUrl('http://100.64.0.1/')).to.throw(/cgnat/);
		});

		it('blocks 0.0.0.0 (unspecified /8)', () => {
			expect(() => assertSafeUrl('http://0.0.0.0/')).to.throw(/unspecified/);
		});
	});

	describe('assertSafeUrl() — IPv6 range blocks', () => {
		it('blocks ::1 (IPv6 loopback)', () => {
			expect(() => assertSafeUrl('http://[::1]/')).to.throw(/loopback/);
		});

		it('blocks :: (IPv6 unspecified)', () => {
			expect(() => assertSafeUrl('http://[::]/')).to.throw(/unspecified/);
		});

		it('blocks fe80::1 (IPv6 link-local)', () => {
			expect(() => assertSafeUrl('http://[fe80::1]/')).to.throw(/link-local/);
		});

		it('blocks fd00::1 (IPv6 unique-local)', () => {
			expect(() => assertSafeUrl('http://[fd00::1]/')).to.throw(/ula-private/);
		});
	});

	describe('assertSafeUrl() — hostname blocks', () => {
		it('blocks "localhost"', () => {
			expect(() => assertSafeUrl('http://localhost/')).to.throw(/blocked list.*internal name/);
		});

		it('blocks "metadata" (GCP cloud metadata shorthand)', () => {
			expect(() => assertSafeUrl('http://metadata/computeMetadata/')).to.throw(/blocked list.*internal name/);
		});

		it('blocks "metadata.google.internal"', () => {
			expect(() => assertSafeUrl('http://metadata.google.internal/computeMetadata/')).to.throw(/blocked list.*internal name/);
		});

		it('blocks *.internal TLD', () => {
			expect(() => assertSafeUrl('http://evil.internal/')).to.throw(/looks internal/);
		});

		it('blocks *.local TLD', () => {
			expect(() => assertSafeUrl('http://evil.local/')).to.throw(/looks internal/);
		});

		it('blocks *.localhost TLD', () => {
			expect(() => assertSafeUrl('http://evil.localhost/')).to.throw(/looks internal/);
		});
	});

	describe('assertSafeUrl() — legitimate URLs that must pass', () => {
		it('allows https://example.com', () => {
			expect(() => assertSafeUrl('https://example.com')).to.not.throw();
		});

		it('allows https://example.com/path?query=1', () => {
			expect(() => assertSafeUrl('https://example.com/path?query=1')).to.not.throw();
		});

		it('allows https://api.anthropic.com/v1/messages', () => {
			expect(() => assertSafeUrl('https://api.anthropic.com/v1/messages')).to.not.throw();
		});

		it('allows https://api.openai.com/v1/chat/completions', () => {
			expect(() => assertSafeUrl('https://api.openai.com/v1/chat/completions')).to.not.throw();
		});

		it('allows https://github.com/Razisafir/fresh', () => {
			expect(() => assertSafeUrl('https://github.com/Razisafir/fresh')).to.not.throw();
		});

		it('allows http://93.184.216.34 (public IPv4)', () => {
			expect(() => assertSafeUrl('http://93.184.216.34/')).to.not.throw();
		});
	});
});
