# 08B — MCP Server Host Smoke Test (USER task)

> **Prerequisite:** Node.js installed (for npx). This test uses the official
> `@modelcontextprotocol/server-filesystem` MCP server, which is a simple,
> well-known reference implementation.

## Setup

1. In VS Code, open Settings (JSON): Ctrl+Shift+P → "Preferences: Open
   User Settings (JSON)".

2. Add an MCP server configuration under `kovix.mcp.servers`:

```json
"kovix.mcp.servers": [
  {
    "name": "filesystem",
    "command": "npx",
    "args": [
      "-y",
      "@modelcontextprotocol/server-filesystem",
      "/tmp/kovix-mcp-test"
    ]
  }
]
```

   (Replace `/tmp/kovix-mcp-test` with any directory you want to expose to
   the MCP server. Create it first: `mkdir -p /tmp/kovix-mcp-test`.)

3. Reload VS Code: Ctrl+Shift+P → "Developer: Reload Window".

4. Open the Kovix output channel: View → Output → select "Kovix" from the
   dropdown.

5. Verify the MCP server connected. You should see in the output channel:
   ```
   [MCP filesystem] Connecting: npx -y @modelcontextprotocol/server-filesystem /tmp/kovix-mcp-test
   [MCP filesystem] Discovered 8 tools
   [MCP filesystem] Registered tool: read_file → filesystem__read_file
   ...
   [MCP] Started: 1 servers, 8 tools registered
   ```

   (The filesystem MCP server exposes ~8 tools: read_file, write_file,
   create_directory, list_directory, move_file, search_files, get_file_info,
   list_allowed_directories.)

## Test 1: List MCP tools

1. Open the Kovix agent panel.
2. Type a task that asks the agent to list available tools:
   > What tools do you have available? List them all.

3. **Expected:** The agent's response should include the MCP-prefixed tools
   (e.g. `filesystem__read_file`, `filesystem__write_file`) alongside the 7
   built-in tools (`read_file`, `write_file`, `edit_file`, `list_directory`,
   `run_command`, `search_code`, `web_fetch`).

## Test 2: Call an MCP tool

1. Create a test file: `echo "hello from MCP" > /tmp/kovix-mcp-test/test.txt`

2. In the Kovix panel, type:
   > Read the file /tmp/kovix-mcp-test/test.txt using the filesystem MCP tool

3. **Expected:** The agent should call `filesystem__read_file` with the path
   `/tmp/kovix-mcp-test/test.txt` and return the content "hello from MCP".

4. The tool-call card in the panel should show:
   - Tool name: `filesystem__read_file`
   - Status: success (green dot)
   - Output: the file content, sanitised + secrets redacted

## Test 3: SEC-6/SEC-7 sanitisation

1. Create a file with a fake secret:
   ```
   echo "API_KEY=sk-ant-api03-fake1234567890abcdefghijklmnopqrstuv" > /tmp/kovix-mcp-test/secret.txt
   ```

2. In the Kovix panel, type:
   > Read the file /tmp/kovix-mcp-test/secret.txt using the filesystem MCP tool

3. **Expected:** The agent's tool result should show the file content with
   the API key REDACTED. You should see `[REDACTED:anthropic]` or similar
   instead of the actual key. This confirms SEC-7 (secret redaction) is
   applied to MCP tool outputs.

4. The tool output should also be wrapped in `BEGIN ... END` delimiters
   (SEC-6 prompt-injection defence).

## Test 4: Degraded mode (no servers configured)

1. Remove the `kovix.mcp.servers` entry from settings.json (or set it to
   `[]`).
2. Reload VS Code.
3. Type a task in the Kovix panel.

4. **Expected:** The agent works normally with only the 7 built-in tools.
   The output channel should show `[MCP] No servers configured.` MCP is
   a zero-cost no-op when unconfigured.

## Test 5: Server failure doesn't break the extension

1. Configure a server with a bad command:
   ```json
   "kovix.mcp.servers": [
     { "name": "bad", "command": "nonexistent-binary", "args": [] },
     { "name": "filesystem", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] }
   ]
   ```
2. Reload VS Code.
3. **Expected:** The "bad" server fails to connect (error in output channel),
   but the "filesystem" server connects and its tools are available. One
   server failure does NOT break the others.

## What to report back

- Did Test 1 pass? (MCP tools listed alongside built-ins)
- Did Test 2 pass? (MCP tool call succeeded)
- Did Test 3 pass? (secrets redacted in MCP output)
- Did Test 4 pass? (extension works with no MCP servers)
- Did Test 5 pass? (one server failure didn't break others)
- Any errors in the Kovix output channel?
- How long did the MCP server take to connect? (should be <5s for npx-based servers)

## Security notes (read before testing)

- **SEC-4 (workspace boundary) is NOT enforced on MCP tools.** The MCP
  server can access ANY file its `args` allow, not just files in your VS
  Code workspace. The filesystem MCP server in this test is configured
  with `/tmp/kovix-mcp-test` as its allowed directory — it can read/write
  anything in that directory, but nothing outside it (the MCP server
  enforces its own boundary). Other MCP servers may not be as careful.
  **Only configure MCP servers you trust.**

- **SEC-6 (prompt injection) IS enforced.** All MCP tool outputs are
  sanitised before being returned to the LLM.

- **SEC-7 (secret redaction) IS enforced.** All MCP tool outputs have
  secrets redacted via the same pattern set used for built-in tools.

- **SEC-9 (env sanitisation) IS enforced.** The MCP server child process
  has a sanitised environment (no `NODE_OPTIONS`, `LD_PRELOAD`,
  `PYTHONPATH`, etc.) via `buildChildEnv()`.
