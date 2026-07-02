# 15 — Snapshot/Undo Scope (Incremental Extension of pendingChangesService)

**Date:** 2026-06-29
**Branch:** `harvest/full-run`
**Purpose:** Scoped follow-up plan for snapshot/undo built on the existing pendingChangesService.ts, per Step 5's recommendation to extend rather than replace. No implementation in this step — scoping only.

---

## 1. Goal

Add snapshot and undo capabilities to fresh's existing Approve-gate infrastructure without replacing it. This gives users git-like undo without requiring git to be initialised, and provides the foundation for multi-agent conflict resolution when swarm mode ships.

---

## 2. Scope

### In scope (v1.0-rc)

| Feature | Description | Priority |
|---------|-------------|----------|
| Pre-accept checksums | Compute SHA-256 of file content before and after accept. Store in PendingChangeEntry. Detects corruption from concurrent writes or disk errors. | High |
| Accept-time rollback log | On accept, store original content + checksum in a rollback log (`~/.kovix/rollback/`). Enables programmatic undo of the N most recent accepted changes. | High |
| Source tagging | Add `source` field to PendingChangeEntry (agent name, tool name, milestone ID). Enables debugging which agent/tool produced a change. | Medium (v1.1 prerequisite) |

### Out of scope (deferred to v1.1+)

| Feature | Why deferred |
|---------|-------------|
| File-level locking | Only needed when multiple agents write concurrently (swarm mode). Single-agent loop doesn't produce conflicts. |
| Conflict detection | Requires file-level locking as prerequisite. |
| DAG integration | Requires execution graph engine — not yet ported. |
| Selective undo (undo individual changes from a batch) | Requires DAG integration to know which changes are safe to undo independently. |

---

## 3. Interface changes

### PendingChangeEntry (extended)

```typescript
export interface PendingChangeEntry {
    uri: SimpleUri;
    originalContent: string;
    proposedContent: string;
    isNewFile: boolean;
    accepted: boolean | undefined;

    // --- NEW (snapshot/undo extension) ---
    /** SHA-256 of original content (before accept). Computed on stage. */
    originalChecksum?: string;
    /** SHA-256 of proposed content. Computed on stage. */
    proposedChecksum?: string;
    /** Source of this change (agent name, tool, milestone). */
    source?: {
        agentName: string;
        toolName: string;
        milestoneId?: string;
    };
}
```

### IPendingChangesService (extended)

```typescript
export interface IPendingChangesService {
    // ... existing methods ...

    /** Undo the N most recently accepted changes. Returns the URIs that were undone. */
    undoRecent(count: number): Promise<SimpleUri[]>;

    /** Get the rollback log (most recent first). */
    getRollbackLog(limit?: number): ReadonlyArray<RollbackEntry>;
}

export interface RollbackEntry {
    uri: SimpleUri;
    originalContent: string;
    originalChecksum: string;
    acceptedAt: string; // ISO 8601
    source?: { agentName: string; toolName: string; milestoneId?: string };
}
```

---

## 4. Implementation plan (for when this is prioritized)

### Phase A: Checksums (~4 hours)
1. Add `originalChecksum` and `proposedChecksum` fields to PendingChangeEntry
2. Compute SHA-256 in `stageFile()` and `stageEdit()`
3. Verify checksum matches on `accept()` (detect concurrent modification)
4. Test: stage a file, modify it externally, accept → should detect mismatch

### Phase B: Rollback log (~1 day)
1. Create `RollbackLog` class that writes to `~/.kovix/rollback/`
2. On `accept()`: write original content + checksum + timestamp to rollback log
3. Implement `undoRecent(N)`: read rollback log, restore original content, remove log entries
4. Implement `getRollbackLog()`: read and return entries
5. Test: accept 3 changes, undo 2, verify files are restored

### Phase C: Source tagging (~2 hours)
1. Add `source` field to PendingChangeEntry
2. Update callers (agentLoop.ts, tool handlers) to pass source info
3. Test: verify source info appears in rollback log

### Phase D: UI integration (~1 day)
1. Add "Undo" button to the pending changes panel
2. Show rollback history in settings
3. Display source info on pending change cards (useful for swarm mode)

**Total estimated effort: ~3.5 days**

---

## 5. Storage format

Rollback entries are stored as JSONL in `~/.kovix/rollback/<session-id>.jsonl`:

```json
{"uri":"file:///path/to/file.ts","originalContent":"...","originalChecksum":"sha256-abc123","acceptedAt":"2026-07-01T10:30:00Z","source":{"agentName":"kovix-agent","toolName":"write_file","milestoneId":"m1"}}
```

Rotation: files are rotated when they exceed 5MB. Oldest rotation is deleted after 7 days.

---

## 6. Security considerations

- Rollback log contains file content (potentially sensitive). Stored in user's home directory with 0600 permissions.
- No remote transmission — rollback data stays local.
- Checksums use SHA-256 for integrity verification, not for security (collision resistance is sufficient for this use case).

---

## 7. Relationship to swarm design (v1.1)

When swarm mode ships, this infrastructure provides:
- Source tagging that identifies which worker agent produced each change
- Checksums that detect concurrent modification conflicts
- Rollback that can undo a specific worker's changes if needed
- Foundation for the file-level locking described in 08_SWARM_DESIGN.md §3.2

The swarm orchestrator can use `source.milestoneId` to group changes by worker and undo an entire worker's output if it fails or conflicts.
