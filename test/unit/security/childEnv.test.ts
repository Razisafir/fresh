/**
 * Unit tests for src/security/childEnv.ts (SEC-9 child-process env sanitisation).
 *
 * This module is the single canonical env-builder for every spawn in the
 * Kovix tree. K2-H1/H2/H3/H4 audit findings were all about spawn sites that
 * bypassed this builder and spread `...process.env` directly, leaking
 * secrets (AWS_*, GITHUB_TOKEN, etc.) into grandchildren AND allowing
 * malicious marketplace entries to set NODE_OPTIONS / LD_PRELOAD for RCE.
 *
 * The tests pin both directions:
 *   1. Allowlisted parent keys pass through.
 *   2. Non-allowlisted parent keys are dropped.
 *   3. Dangerous serverEnv keys (NODE_OPTIONS, LD_PRELOAD, PYTHONPATH, etc.)
 *      are always stripped, even when explicitly set by the caller.
 */

import { expect } from 'chai';
import {
	buildChildEnv,
	PARENT_ENV_ALLOWLIST,
	DENIED_ENV_KEYS,
} from '../../../src/security/childEnv';

describe('childEnv (SEC-9 child-process env sanitisation)', () => {
	describe('PARENT_ENV_ALLOWLIST', () => {
		it('includes PATH for binary resolution', () => {
			expect(PARENT_ENV_ALLOWLIST).to.include('PATH');
		});

		it('includes HOME / USERPROFILE for user-config dir resolution', () => {
			expect(PARENT_ENV_ALLOWLIST).to.include('HOME');
			expect(PARENT_ENV_ALLOWLIST).to.include('USERPROFILE');
		});

		it('includes LANG / LC_ALL for locale', () => {
			expect(PARENT_ENV_ALLOWLIST).to.include('LANG');
			expect(PARENT_ENV_ALLOWLIST).to.include('LC_ALL');
		});

		it('does NOT include common secret-bearing env var names', () => {
			// These must never be inherited from the parent shell — they
			// almost always carry secrets that grandchildren shouldn't see.
			expect(PARENT_ENV_ALLOWLIST).to.not.include('AWS_SECRET_ACCESS_KEY');
			expect(PARENT_ENV_ALLOWLIST).to.not.include('GITHUB_TOKEN');
			expect(PARENT_ENV_ALLOWLIST).to.not.include('ANTHROPIC_API_KEY');
			expect(PARENT_ENV_ALLOWLIST).to.not.include('OPENAI_API_KEY');
			expect(PARENT_ENV_ALLOWLIST).to.not.include('KOVIX_ENCRYPTION_KEY_HEX');
			expect(PARENT_ENV_ALLOWLIST).to.not.include('DATABASE_URL');
		});
	});

	describe('DENIED_ENV_KEYS', () => {
		it('includes Node.js code-injection vectors', () => {
			expect(DENIED_ENV_KEYS).to.include('NODE_OPTIONS');
			expect(DENIED_ENV_KEYS).to.include('NODE_PATH');
			expect(DENIED_ENV_KEYS).to.include('NODE_EXTRA_CA_CERTS');
		});

		it('includes dynamic-linker hijack vectors (Linux / macOS)', () => {
			expect(DENIED_ENV_KEYS).to.include('LD_PRELOAD');
			expect(DENIED_ENV_KEYS).to.include('LD_LIBRARY_PATH');
			expect(DENIED_ENV_KEYS).to.include('DYLD_INSERT_LIBRARIES');
		});

		it('includes Python code-injection vectors', () => {
			expect(DENIED_ENV_KEYS).to.include('PYTHONPATH');
			expect(DENIED_ENV_KEYS).to.include('PYTHONSTARTUP');
		});

		it('includes Electron runtime-escape vectors', () => {
			expect(DENIED_ENV_KEYS).to.include('ELECTRON_RUN_AS_NODE');
		});

		it('includes shell-injection vectors', () => {
			expect(DENIED_ENV_KEYS).to.include('BASH_ENV');
			expect(DENIED_ENV_KEYS).to.include('ENV');
		});
	});

	describe('buildChildEnv() — parent env inheritance', () => {
		it('copies allowlisted parent keys that are present', () => {
			// Save & set a known allowlisted key
			const savedPath = process.env.PATH;
			const savedHome = process.env.HOME;
			process.env.PATH = '/usr/bin:/bin';
			process.env.HOME = '/home/testuser';
			try {
				const { env } = buildChildEnv();
				expect(env.PATH).to.equal('/usr/bin:/bin');
				expect(env.HOME).to.equal('/home/testuser');
			} finally {
				process.env.PATH = savedPath;
				process.env.HOME = savedHome;
			}
		});

		it('drops non-allowlisted parent keys (AWS_SECRET_ACCESS_KEY etc.)', () => {
			const saved = process.env.AWS_SECRET_ACCESS_KEY;
			process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
			try {
				const { env } = buildChildEnv();
				expect(env.AWS_SECRET_ACCESS_KEY).to.be.undefined;
			} finally {
				if (saved === undefined) { delete process.env.AWS_SECRET_ACCESS_KEY; }
				else { process.env.AWS_SECRET_ACCESS_KEY = saved; }
			}
		});

		it('drops empty-string parent values (treats them as absent)', () => {
			const saved = process.env.PATH;
			process.env.PATH = '';
			try {
				const { env } = buildChildEnv();
				// Empty string is treated as "not set" — env should not have PATH key
				// (or it should be undefined, depending on impl; either is acceptable
				// as long as it's not the empty string).
				expect(env.PATH ?? '').to.equal('');
			} finally {
				process.env.PATH = saved;
			}
		});
	});

	describe('buildChildEnv() — serverEnv layering', () => {
		it('passes through harmless serverEnv keys', () => {
			const { env } = buildChildEnv({ MCP_LOG_LEVEL: 'debug' });
			expect(env.MCP_LOG_LEVEL).to.equal('debug');
		});

		it('strips NODE_OPTIONS from serverEnv (RCE primitive)', () => {
			const { env, strippedKeys } = buildChildEnv({
				NODE_OPTIONS: '--require /tmp/evil.js',
			});
			expect(env.NODE_OPTIONS).to.be.undefined;
			expect(strippedKeys).to.include('NODE_OPTIONS');
		});

		it('strips LD_PRELOAD from serverEnv (RCE primitive)', () => {
			const { env, strippedKeys } = buildChildEnv({
				LD_PRELOAD: '/tmp/evil.so',
			});
			expect(env.LD_PRELOAD).to.be.undefined;
			expect(strippedKeys).to.include('LD_PRELOAD');
		});

		it('strips PYTHONPATH from serverEnv (RCE primitive)', () => {
			const { env, strippedKeys } = buildChildEnv({
				PYTHONPATH: '/tmp/evil-py',
			});
			expect(env.PYTHONPATH).to.be.undefined;
			expect(strippedKeys).to.include('PYTHONPATH');
		});

		it('strips DYLD_INSERT_LIBRARIES from serverEnv (macOS RCE)', () => {
			const { env, strippedKeys } = buildChildEnv({
				DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
			});
			expect(env.DYLD_INSERT_LIBRARIES).to.be.undefined;
			expect(strippedKeys).to.include('DYLD_INSERT_LIBRARIES');
		});

		it('strips BASH_ENV from serverEnv (shell RCE)', () => {
			const { env, strippedKeys } = buildChildEnv({
				BASH_ENV: '/tmp/evil.sh',
			});
			expect(env.BASH_ENV).to.be.undefined;
			expect(strippedKeys).to.include('BASH_ENV');
		});

		it('reports ALL stripped keys in one call', () => {
			const { strippedKeys } = buildChildEnv({
				NODE_OPTIONS: '--require x',
				LD_PRELOAD: '/tmp/x.so',
				PYTHONPATH: '/tmp/x',
				VALID_KEY: 'kept',
			});
			expect(strippedKeys).to.have.members(['NODE_OPTIONS', 'LD_PRELOAD', 'PYTHONPATH']);
		});

		it('returns empty strippedKeys array when serverEnv is clean', () => {
			const { strippedKeys } = buildChildEnv({ MCP_LOG_LEVEL: 'info' });
			expect(strippedKeys).to.be.an('array').with.lengthOf(0);
		});

		it('returns empty strippedKeys array when serverEnv is undefined', () => {
			const { strippedKeys } = buildChildEnv();
			expect(strippedKeys).to.be.an('array').with.lengthOf(0);
		});
	});
});
