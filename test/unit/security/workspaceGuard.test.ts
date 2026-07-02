/**
 * Unit tests for src/security/workspaceGuard.ts (SEC-4 path traversal defence).
 *
 * The workspace guard is what stops a prompt-injected LLM from running
 * `read_file('../../../etc/passwd')` or `write_file('/tmp/evil.sh', ...)`.
 * Every file-mutating tool routes through assertWithinWorkspace before
 * touching disk.
 *
 * The "H4 fix" mentioned in the source: old code only checked for ".." in
 * the path string, which let absolute paths like /etc/passwd pass through.
 * The new impl resolves + compares against the workspace root.
 */

import { expect } from 'chai';
import * as path from 'path';
import {
        assertWithinWorkspace,
        validateToolName,
        validateMcpMethod,
        IWorkspaceRootsProvider,
} from '../../../src/security/workspaceGuard';

describe('workspaceGuard (SEC-4 path traversal defence)', () => {
        describe('assertWithinWorkspace() — path traversal', () => {
                it('rejects ".." in path', () => {
                        expect(() => assertWithinWorkspace('../../../etc/passwd', '/workspace')).to.throw(/Path traversal/);
                });

                it('rejects intermediate ".." even when final target is inside workspace', () => {
                        // /workspace/../workspace/file — this is technically inside but the
                        // normalised form still contains ".." so we reject defensively.
                        expect(() => assertWithinWorkspace('../workspace/file', '/workspace')).to.throw(/Path traversal/);
                });
        });

        describe('assertWithinWorkspace() — no workspace root', () => {
                it('rejects absolute paths when no workspace root is provided', () => {
                        expect(() => assertWithinWorkspace('/etc/passwd')).to.throw(/Absolute paths require a workspace context/);
                });

                it('allows relative paths when no workspace root is provided', () => {
                        expect(() => assertWithinWorkspace('src/file.ts')).to.not.throw();
                });

                it('allows relative paths with subdirectories when no workspace root', () => {
                        expect(() => assertWithinWorkspace('src/agent/file.ts')).to.not.throw();
                });
        });

        describe('assertWithinWorkspace() — single workspace root (string)', () => {
                const root = process.platform === 'win32' ? 'C:\\workspace' : '/workspace';

                it('allows absolute path inside workspace', () => {
                        const filePath = path.join(root, 'src', 'file.ts');
                        expect(() => assertWithinWorkspace(filePath, root)).to.not.throw();
                });

                it('allows relative path resolved against workspace root', () => {
                        expect(() => assertWithinWorkspace('src/file.ts', root)).to.not.throw();
                });

                it('rejects absolute path outside workspace', () => {
                        const outside = process.platform === 'win32' ? 'C:\\Windows\\System32\\evil.exe' : '/etc/passwd';
                        expect(() => assertWithinWorkspace(outside, root)).to.throw(/outside workspace/);
                });

                it('rejects path that resolves outside via symlinks (resolved absolute path check)', () => {
                        // /workspace-evil/file shares a prefix with /workspace but is a different dir.
                        // The guard's check `resolved.startsWith(root + path.sep)` correctly rejects this.
                        const evil = process.platform === 'win32' ? 'C:\\workspace-evil\\file' : '/workspace-evil/file';
                        expect(() => assertWithinWorkspace(evil, root)).to.throw(/outside workspace/);
                });

                it('allows Windows paths with forward slashes inside workspace (Windows fix)', function() {
                        if (process.platform !== 'win32') this.skip();
                        // LLMs often generate C:/Users/... instead of C:\Users\...
                        expect(() => assertWithinWorkspace('C:/workspace/src/file.ts', root)).to.not.throw();
                });

                it('allows case-insensitive path matching on Windows', function() {
                        if (process.platform !== 'win32') this.skip();
                        expect(() => assertWithinWorkspace('C:\\Workspace\\SRC\\file.ts', root)).to.not.throw();
                });
        });

        describe('assertWithinWorkspace() — multi-root workspace (IWorkspaceRootsProvider)', () => {
                const roots = process.platform === 'win32'
                        ? ['C:\\ws1', 'C:\\ws2']
                        : ['/ws1', '/ws2'];
                const provider: IWorkspaceRootsProvider = { getWorkspaceRoots: () => roots };

                it('allows path inside first root', () => {
                        const filePath = path.join(roots[0], 'file.ts');
                        expect(() => assertWithinWorkspace(filePath, provider)).to.not.throw();
                });

                it('allows path inside second root (multi-root expansion)', () => {
                        const filePath = path.join(roots[1], 'file.ts');
                        expect(() => assertWithinWorkspace(filePath, provider)).to.not.throw();
                });

                it('rejects path outside all roots', () => {
                        const outside = process.platform === 'win32' ? 'C:\\Windows\\evil' : '/etc/passwd';
                        expect(() => assertWithinWorkspace(outside, provider)).to.throw(/outside all workspace roots/);
                });

                it('treats empty provider (no roots) like no-workspace: only relative paths allowed', () => {
                        const emptyProvider: IWorkspaceRootsProvider = { getWorkspaceRoots: () => [] };
                        expect(() => assertWithinWorkspace('relative/file.ts', emptyProvider)).to.not.throw();
                        expect(() => assertWithinWorkspace('/etc/passwd', emptyProvider)).to.throw(/Absolute paths are not allowed/);
                });
        });

        describe('validateToolName()', () => {
                it('returns true for known v0.1 built-in tools', () => {
                        expect(validateToolName('read_file')).to.be.true;
                        expect(validateToolName('write_file')).to.be.true;
                        expect(validateToolName('edit_file')).to.be.true;
                        expect(validateToolName('list_directory')).to.be.true;
                        expect(validateToolName('create_directory')).to.be.true;
                        expect(validateToolName('run_command')).to.be.true;
                        expect(validateToolName('search_code')).to.be.true;
                        expect(validateToolName('web_fetch')).to.be.true;
                });

                it('returns false for dropped / unknown tool names', () => {
                        // These were in the old list but are NOT in v0.1 per 02_ARCHITECTURE.md §4.3
                        // Note: create_directory was re-added as tool #8
                        expect(validateToolName('search_files')).to.be.false;
                        expect(validateToolName('search_codebase')).to.be.false;
                        expect(validateToolName('web_search')).to.be.false;
                        // Arbitrary names
                        expect(validateToolName('rm_rf')).to.be.false;
                        expect(validateToolName('arbitrary_exec')).to.be.false;
                        expect(validateToolName('')).to.be.false;
                });
        });

        describe('validateMcpMethod()', () => {
                it('returns true for allowed MCP methods', () => {
                        expect(validateMcpMethod('initialize')).to.be.true;
                        expect(validateMcpMethod('tools/list')).to.be.true;
                        expect(validateMcpMethod('tools/call')).to.be.true;
                        expect(validateMcpMethod('resources/list')).to.be.true;
                        expect(validateMcpMethod('resources/read')).to.be.true;
                });

                it('returns false for disallowed / arbitrary methods', () => {
                        expect(validateMcpMethod('admin/shutdown')).to.be.false;
                        expect(validateMcpMethod('')).to.be.false;
                        expect(validateMcpMethod('arbitrary')).to.be.false;
                });
        });
});
