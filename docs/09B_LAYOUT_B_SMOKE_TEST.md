# Layout B Smoke Test

**Branch:** `layout-b/editor-shell`
**Purpose:** Verify the three-pane Layout B UI (file tree + Monaco editor + chat)
works end-to-end on your own machine.

---

## Prerequisites

1. You have an API key set (Anthropic or NVIDIA NIM).
2. You have a workspace folder with at least a few source files in it
   (your Kovix repo itself works great — it has .ts, .js, .md, .json files).

---

## Step-by-step

### 1. Start the app

```bash
cd /path/to/fresh
npm start
```

You should see a window with **three panes**: a narrow file tree on the left,
a wide editor area in the center, and the chat panel on the right.

**Look for:**
- [ ] Window opens without errors
- [ ] Three distinct panes are visible
- [ ] The center pane shows "Select a file to view" placeholder
- [ ] The file tree shows "Open a folder to see files" or your workspace files

### 2. Open a workspace folder

Click the 📂 button in the header bar. Pick a folder (e.g., the Kovix repo
itself or any project folder).

**Look for:**
- [ ] File tree populates with files and folders
- [ ] Common noise directories (node_modules, .git, dist, .vscode) are NOT shown
- [ ] Folders have folder icons, files have appropriate file-type icons
- [ ] Directories are sorted before files, alphabetical within each group
- [ ] The chat panel shows "📂 Opened: /path/to/folder"

### 3. Click a file in the tree

Click any file in the file tree (e.g., `package.json` or `README.md`).

**Look for:**
- [ ] The file opens in the center editor pane
- [ ] Syntax highlighting is correct (JSON for .json, Markdown for .md, etc.)
- [ ] The editor header shows the filename
- [ ] The file is NOT editable (read-only — Monaco should show a cursor but
      typing should not change content)

### 4. Browse around

Click a few different files. Expand and collapse folders.

**Look for:**
- [ ] Clicking a different file replaces the current one in the editor
- [ ] The active file is highlighted in the tree
- [ ] Folders expand/collapse when clicked
- [ ] The chevron arrows rotate when expanded

### 5. Resize the panes

Drag the resize handles between the panes.

**Look for:**
- [ ] Dragging the handle between file tree and editor resizes the tree width
- [ ] Dragging the handle between editor and chat resizes the chat width
- [ ] The editor automatically reflows when the pane width changes
- [ ] Panes respect minimum widths (tree ≥ 160px, chat ≥ 280px)

### 6. Chat with the agent

In the chat panel, send a message like "list the files in this project".

**Look for:**
- [ ] Chat works as before — messages appear, tool calls show up
- [ ] The chat panel scrolls properly within its pane
- [ ] No layout breakage or overflow

### 7. Plan mode — create a file

Switch to Plan mode. Ask the agent to create a simple file, e.g.:
"Create a file called hello.txt with the content 'Hello from Kovix'"

Approve the plan and let it execute.

**Look for:**
- [ ] Plan card appears in the chat
- [ ] After approval, the agent stages the change
- [ ] The pending changes bar appears at the bottom of the chat pane
- [ ] The file appears in the file tree with a yellow dot (pending indicator)

### 8. View the pending change as a diff

Click the pending file in the file tree (the one with the yellow dot).

**Look for:**
- [ ] The editor switches to **diff mode** (side-by-side view)
- [ ] Left side shows the original (empty for new files), right side shows the proposed content
- [ ] Green highlighting on added lines
- [ ] The editor header shows a "Pending Change" badge
- [ ] Accept and Reject buttons appear in the editor header

### 9. Accept the change from the editor

Click the **Accept** button in the editor header.

**Look for:**
- [ ] The diff view switches to a regular (read-only) view of the accepted content
- [ ] The file is written to disk (check in your file explorer or terminal)
- [ ] The pending changes bar in the chat updates (count decreases)
- [ ] The yellow dot disappears from the file tree

### 10. Test Reject

Create another file via the agent, then click it in the tree and click
**Reject** in the editor header.

**Look for:**
- [ ] The diff view reverts to the original content (or "Select a file" if
      it was a new file)
- [ ] The file is NOT written to disk
- [ ] The pending changes bar updates
- [ ] The yellow dot disappears

### 11. Accept/Reject from the chat panel

Create another change, then use the "Accept all" / "Reject all" buttons
in the chat panel's pending changes bar (NOT the editor).

**Look for:**
- [ ] The change is accepted/rejected as expected
- [ ] If the editor was showing the diff for that file, it updates accordingly
- [ ] The file tree pending indicators update

---

## What would indicate something's broken

- ❌ Editor shows a blank white screen (Monaco failed to load)
- ❌ File tree is empty after opening a folder with files
- ❌ Clicking a file doesn't open it in the editor
- ❌ Typing in the editor changes file content (violates the "editor never
     writes directly to disk" constraint)
- ❌ Diff view doesn't show when a pending change exists for the open file
- ❌ Accept/Reject buttons in the editor don't work
- ❌ Chat panel is broken or messages don't appear
- ❌ Layout breaks on window resize
- ❌ Console shows errors in the DevTools (Ctrl+Shift+I)

---

## Quick verification shortcut

If you just want to verify the basics in 60 seconds:

1. `npm start`
2. Open a folder
3. Click a file → see it in the editor
4. Run "Create hello.txt with content 'test'" in Plan mode
5. Approve the plan
6. Click the pending file in the tree → see diff
7. Accept from the editor header → see file written
8. Done ✅
