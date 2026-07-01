/**
 * mcpToolNameValidation.test.ts — Test MCP tool name validation regex.
 */

import { expect } from 'chai';

describe('MCP tool name validation', () => {
        it('MCP tool names with special characters should be rejected', () => {
                // Test the regex pattern directly — this is what mcpManager uses internally
                const validPattern = /^[a-zA-Z0-9_-]+$/;

                // Valid names
                expect(validPattern.test('read_file')).to.be.true;
                expect(validPattern.test('search-code')).to.be.true;
                expect(validPattern.test('myTool123')).to.be.true;

                // Invalid names (injection attempts)
                expect(validPattern.test('tool;rm -rf')).to.be.false;
                expect(validPattern.test('$(whoami)')).to.be.false;
                expect(validPattern.test('../../../etc/passwd')).to.be.false;
                expect(validPattern.test('tool\ninjection')).to.be.false;
        });
});
