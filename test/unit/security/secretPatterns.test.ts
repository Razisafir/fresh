/**
 * Unit tests for src/security/secretPatterns.ts (canonical secret redaction).
 *
 * SEC-7 L3 fix: this is the single source of truth shared by both the
 * agentLoop path (promptSanitiser) and the tool-registry path (secretRedactor).
 * Drift between the two paths was the K2-M4 audit finding; these tests
 * pin the canonical behaviour.
 */

import { expect } from 'chai';
import {
        redactSecrets,
        resetSecretPatterns,
        listSecretPatternNames,
        SECRET_PATTERNS,
} from '../../../src/security/secretPatterns';

describe('secretPatterns (SEC-7 L3 — canonical secret redaction)', () => {
        describe('SECRET_PATTERNS registry', () => {
                it('is a non-empty readonly array', () => {
                        expect(SECRET_PATTERNS).to.be.an('array');
                        expect(SECRET_PATTERNS.length).to.be.greaterThan(10);
                });

                it('every pattern has the global flag (required for shared regex use)', () => {
                        for (const sp of SECRET_PATTERNS) {
                                expect(sp.pattern.global, `pattern ${sp.name} must have /g flag`).to.be.true;
                        }
                });

                it('every pattern has a unique name', () => {
                        const names = SECRET_PATTERNS.map(sp => sp.name);
                        const unique = new Set(names);
                        expect(unique.size).to.equal(names.length, 'pattern names must be unique');
                });
        });

        describe('listSecretPatternNames()', () => {
                it('returns the list of pattern names', () => {
                        const names = listSecretPatternNames();
                        expect(names).to.include('anthropic');
                        expect(names).to.include('openai');
                        expect(names).to.include('github_pat');
                        expect(names).to.include('gitlab_pat');
                        expect(names).to.include('slack_token');
                });
        });

        describe('redactSecrets()', () => {
                it('returns falsy input as-is', () => {
                        expect(redactSecrets('')).to.equal('');
                        // @ts-expect-error testing defensive behaviour
                        expect(redactSecrets(null)).to.equal(null);
                        // @ts-expect-error testing defensive behaviour
                        expect(redactSecrets(undefined)).to.equal(undefined);
                });

                it('redacts Anthropic key (sk-ant-...)', () => {
                        const input = 'Calling Anthropic with key sk-ant-api03-1234567890abcdefghijklmnopqrstuv';
                        const result = redactSecrets(input);
                        expect(result).to.not.contain('sk-ant-api03-1234567890abcdefghijklmnopqrstuv');
                        expect(result).to.contain('[REDACTED:anthropic]');
                });

                it('redacts OpenAI key (sk-proj-...)', () => {
                        // Use a bare key (no env-name prefix) so the `upper_env_secret`
                        // pattern doesn't match the whole assignment and shadow the
                        // `openai` pattern's marker.
                        const input = 'the key is sk-proj-1234567890abcdefghijklmnopqrstuv';
                        const result = redactSecrets(input);
                        expect(result).to.not.contain('sk-proj-1234567890abcdefghijklmnopqrstuv');
                        expect(result).to.contain('[REDACTED:openai]');
                });

                it('redacts NVIDIA NIM key (nvapi-...)', () => {
                        const input = 'NVIDIA key: nvapi-1234567890abcdefghijklmnopqrstuv';
                        const result = redactSecrets(input);
                        expect(result).to.contain('[REDACTED:nvidia_nim]');
                });

                it('redacts Groq key (gsk_...)', () => {
                        const input = 'gsk_1234567890abcdefghijklmnopqrstuv';
                        const result = redactSecrets(input);
                        expect(result).to.contain('[REDACTED:groq]');
                });

                it('redacts GitHub PAT (ghp_...)', () => {
                        // Use a bare PAT (no env-name prefix) so the `upper_env_secret`
                        // pattern doesn't shadow the `github_pat` pattern's marker.
                        const input = 'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789AB';
                        const result = redactSecrets(input);
                        expect(result).to.contain('[REDACTED:github_pat]');
                });

                it('redacts GitLab PAT (glpat-...)', () => {
                        const input = 'glpat-1234567890abcdefghijklmnopqrst';
                        const result = redactSecrets(input);
                        expect(result).to.contain('[REDACTED:gitlab_pat]');
                });

                it('redacts Slack token (xox[abprs]-...)', () => {
                        // Use a bare token (no env-name prefix) so the env-assignment
                        // patterns don't shadow the `slack_token` pattern's marker.
                        const input = 'token: xoxb-1234567890123-1234567890123-abcdef';
                        const result = redactSecrets(input);
                        expect(result).to.contain('[REDACTED:slack_token]');
                });

                it('redacts Bearer token', () => {
                        const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature';
                        const result = redactSecrets(input);
                        expect(result).to.contain('[REDACTED:authorization_bearer]');
                });

                it('redacts HTTP Basic auth header', () => {
                        const input = 'Authorization: Basic dXNlcjpwYXNzd29yZA==';
                        const result = redactSecrets(input);
                        expect(result).to.contain('[REDACTED:authorization_basic]');
                        expect(result).to.not.contain('dXNlcjpwYXNzd29yZA==');
                });

                it('redacts ?password= query parameter', () => {
                        const input = 'https://example.com/login?password=hunter2&user=bob';
                        const result = redactSecrets(input);
                        expect(result).to.not.contain('password=hunter2');
                        expect(result).to.contain('[REDACTED:qs_password]');
                });

                it('redacts ?api_key= query parameter', () => {
                        const input = 'https://api.example.com/?api_key=secret123';
                        const result = redactSecrets(input);
                        expect(result).to.contain('[REDACTED:qs_api_key]');
                });

                it('redacts UPPER_CASE env-style secret', () => {
                        const input = 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
                        const result = redactSecrets(input);
                        expect(result).to.contain('[REDACTED:upper_env_secret]');
                        expect(result).to.not.contain('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
                });

                it('redacts 32+ hex chars (catches MD5/SHA prefixes)', () => {
                        const input = 'token: 5d41402abc4b2a76b9719d911017c592';
                        const result = redactSecrets(input);
                        expect(result).to.contain('[REDACTED:hex_32plus]');
                        expect(result).to.not.contain('5d41402abc4b2a76b9719d911017c592');
                });

                it('redacts multiple secrets in one pass', () => {
                        const input = 'ANTHROPIC=sk-ant-api03-1234567890abcdefghijklmnopqrstuv OPENAI=sk-proj-1234567890abcdefghijklmnopqrstuv';
                        const result = redactSecrets(input);
                        expect(result).to.contain('[REDACTED:anthropic]');
                        expect(result).to.contain('[REDACTED:openai]');
                });

                it('is idempotent (calling twice gives same result)', () => {
                        const input = 'sk-ant-api03-1234567890abcdefghijklmnopqrstuv';
                        const once = redactSecrets(input);
                        const twice = redactSecrets(once);
                        expect(twice).to.equal(once);
                });

                it('resetSecretPatterns() resets lastIndex on all patterns (allows safe reuse)', () => {
                        // Run redact once — global regexes advance their lastIndex
                        redactSecrets('sk-ant-api03-1234567890abcdefghijklmnopqrstuv');
                        // Without reset, a second call with the SAME regex object could skip matches
                        // (the bug K2-M4 fix guards against).
                        resetSecretPatterns();
                        const result = redactSecrets('sk-ant-api03-1234567890abcdefghijklmnopqrstuv');
                        expect(result).to.contain('[REDACTED:anthropic]');
                });

                it('preserves normal text', () => {
                        const input = 'function add(a, b) { return a + b; } // returns the sum';
                        expect(redactSecrets(input)).to.equal(input);
                });
        });
});
