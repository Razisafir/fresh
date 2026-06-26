# 08A — Memory Service Smoke Test (USER task)

> **Prerequisite:** Ollama running locally with the `nomic-embed-text` model
> pulled. If you don't have Ollama, install it from <https://ollama.com> then
> run `ollama pull nomic-embed-text`.

## Setup

1. Ensure Ollama is running: `ollama serve` (or it's already running as a
   background service).
2. Verify the embedding model is available: `ollama pull nomic-embed-text`.
3. In VS Code Settings, verify:
   - `kovix.memory.embedProvider` = `ollama`
   - `kovix.memory.embedModel` = `nomic-embed-text`
   - `kovix.memory.vectorStore` = `in-process`
4. Open the Kovix agent panel.

## Test 1: Store + Recall (basic round-trip)

1. In the Kovix panel, type:
   > Remember this for later: the database connection string is `postgresql://localhost:5432/kovix_test`

2. Wait for the agent to complete the task (it will create a file or just
   acknowledge — either way, the task completion triggers a memory store).

3. Start a NEW task (not a follow-up in the same conversation — close and
   reopen the panel, or click "New Task" if available):
   > What is the database connection string I told you about?

4. **Expected:** The agent's plan should reference the connection string
   from the previous task. The memory context is injected as
   `extraContext` in the system prompt, so the agent "knows" the answer
   even though it's a new conversation.

5. **If it fails:** Check the Kovix output channel (View → Output → select
   "Kovix") for errors. Common failures:
   - "Ollama not reachable" → Ollama isn't running or is on a non-default
     port. Check `kovix.memory.embedProvider` settings.
   - "dimension mismatch" → the embedding model changed between sessions.
     Delete `~/.kovix/memory/` and retry.
   - Empty results → the first task didn't complete successfully (memory
     is only stored on task completion, not on failure).

## Test 2: Cross-project recall (optional)

1. Close the current workspace. Open a DIFFERENT folder in VS Code.
2. In the Kovix panel, type:
   > What is the database connection string?

3. **Expected:** The agent recalls the connection string from the previous
   project. Memory is stored globally in `~/.kovix/memory/` (not
   per-project), so cross-project recall works by design.

## Test 3: Degraded mode (no Ollama)

1. Stop Ollama: `ollama stop` (or kill the process).
2. Set `kovix.memory.embedProvider` = `none` in VS Code Settings.
3. Reload VS Code.
4. Type a task in the Kovix panel.

5. **Expected:** The agent works normally — no errors, no memory context
   injected, but the Plan → Approve → Execute → Verify loop still
   functions. Memory is a context boost, not a dependency.

## What to report back

- Did Test 1 pass? (agent recalled the connection string)
- Did Test 2 pass? (cross-project recall worked)
- Did Test 3 pass? (agent worked fine with memory disabled)
- Any errors in the Kovix output channel?
- How long did the embedding take? (should be <1s on localhost)

## Technical notes

- Memory entries are stored in `~/.kovix/memory/index.bin` (HNSW index) and
  `~/.kovix/memory/entries.json` (text entries). Delete these files to wipe
  all memories.
- The HNSW index uses cosine similarity with M=16, efConstruction=200,
  efSearch=50. Tuned for <10k entries; if memory grows past that, search
  quality degrades but doesn't break.
- All retrieved memory is sanitised via `wrapMemoryContext()` (SEC-6)
  before injection: control chars stripped, injection prefixes filtered,
  wrapped in `<user_provided_context>` XML tag with a comment marking it
  as user-provided (not system instructions).
