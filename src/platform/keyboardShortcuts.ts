/**
 * keyboardShortcuts.ts — Keyboard shortcuts system for the Electron app.
 *
 * Defines all key bindings and their associated command IDs. The command IDs
 * are string identifiers that will be wired to IPC handlers by the Electron
 * main process (or by the renderer's command service) at runtime.
 *
 * This file is intentionally DECLARATIVE — it contains no runtime logic, no
 * IPC calls, and no side effects. The consuming layer (electron/main.ts or
 * the renderer's keyboard service) reads `KEY_BINDINGS` and registers the
 * appropriate accelerator → command-ID mappings.
 *
 * Platform handling:
 *   - `key` is the Windows/Linux binding (uses Ctrl).
 *   - `macKey` is the macOS-specific binding (uses Cmd), if different.
 *   - If `macKey` is omitted, the `key` binding is used on all platforms.
 *   - The Electron accelerator string is derived from `key` (or `macKey`
 *     on macOS) by the consuming layer.
 *
 * Context conditions (`when`):
 *   - An optional string that specifies when the keybinding is active.
 *   - Examples: 'chatFocused', 'editorFocused', 'global'.
 *   - The consuming layer evaluates these conditions against the current
 *     focus state. If `when` is undefined, the binding is always active
 *     (global).
 *
 * Command IDs follow a hierarchical naming convention:
 *   - `kovix.chat.*`     — Chat panel commands
 *   - `kovix.agent.*`    — Agent loop commands
 *   - `kovix.diff.*`     — Pending changes commands
 *   - `kovix.panel.*`    — Panel visibility toggles
 *   - `kovix.sidebar.*`  — Sidebar focus commands
 *   - `kovix.tab.*`      — Tab management commands
 *   - `kovix.editor.*`   — Editor commands
 *   - `kovix.debug.*`    — Debug/run commands
 *
 * Design notes:
 *   - Command IDs are stable strings. Renaming a command ID is a breaking
 *     change — any IPC handler or menu item referencing it must be updated.
 *   - The `/` prefix in slash commands (e.g. Ctrl+/) uses Electron's
 *     accelerator syntax where `/` is the forward-slash key.
 *   - Ctrl+1-9 bindings are represented as individual entries rather than
 *     a range, because Electron's accelerator format requires explicit
 *     key combinations.
 */

// ---------------------------------------------------------------------------
// IKeyBinding
// ---------------------------------------------------------------------------

/**
 * A single key binding definition.
 *
 * Maps a physical key combination to a command ID, optionally scoped to a
 * context condition. The consuming layer reads these definitions and
 * registers them with Electron's globalShortcut or the renderer's
 * keyboard-event listener.
 */
export interface IKeyBinding {
	/** Key combination for Windows/Linux (e.g. 'Ctrl+Enter'). */
	key: string;
	/** Optional macOS-specific binding (e.g. 'Cmd+Enter'). If omitted, `key` is used on macOS. */
	macKey?: string;
	/** Command ID that this binding triggers (e.g. 'kovix.chat.send'). */
	command: string;
	/** Context condition (e.g. 'chatFocused', 'editorFocused'). Undefined = global. */
	when?: string;
	/** Human-readable description of what this binding does. */
	description: string;
}

// ---------------------------------------------------------------------------
// KEY_BINDINGS
// ---------------------------------------------------------------------------

/**
 * All default key bindings for the Kovix Electron app.
 *
 * Ordered by functional group:
 *   1. Chat commands
 *   2. Command palette / slash menu
 *   3. Inline edit
 *   4. Panel toggles
 *   5. Sidebar focus
 *   6. Agent actions (undo, diff accept/reject, cancel)
 *   7. Session / tab management
 *   8. Editor commands
 *   9. Debug / run
 */
export const KEY_BINDINGS: IKeyBinding[] = [
	// --- Chat commands -------------------------------------------------------

	{
		key: 'Ctrl+Enter',
		macKey: 'Cmd+Enter',
		command: 'kovix.chat.send',
		when: 'chatFocused',
		description: 'Send message',
	},

	// --- Command palette / slash menu ----------------------------------------

	{
		key: 'Ctrl+Shift+P',
		macKey: 'Cmd+Shift+P',
		command: 'kovix.commandPalette.open',
		description: 'Open command palette',
	},

	{
		key: 'Ctrl+/',
		macKey: 'Cmd+/',
		command: 'kovix.slashMenu.toggle',
		when: 'chatFocused',
		description: 'Toggle slash command menu',
	},

	// --- Inline edit ---------------------------------------------------------

	{
		key: 'Ctrl+K',
		macKey: 'Cmd+K',
		command: 'kovix.inlineEdit.open',
		when: 'editorFocused',
		description: 'Inline edit (select code + prompt)',
	},

	// --- Panel toggles -------------------------------------------------------

	{
		key: 'Ctrl+I',
		macKey: 'Cmd+I',
		command: 'kovix.panel.agent.toggle',
		description: 'Toggle agent panel',
	},

	{
		key: 'Ctrl+B',
		macKey: 'Cmd+B',
		command: 'kovix.panel.fileTree.toggle',
		description: 'Toggle file tree sidebar',
	},

	{
		key: 'Ctrl+J',
		macKey: 'Cmd+J',
		command: 'kovix.panel.terminal.toggle',
		description: 'Toggle terminal panel',
	},

	// --- Sidebar focus -------------------------------------------------------

	{
		key: 'Ctrl+Shift+E',
		command: 'kovix.sidebar.explorer.focus',
		description: 'Focus file explorer',
	},

	{
		key: 'Ctrl+Shift+F',
		command: 'kovix.sidebar.search.focus',
		description: 'Focus search',
	},

	{
		key: 'Ctrl+Shift+G',
		command: 'kovix.sidebar.git.focus',
		description: 'Focus git panel',
	},

	// --- Agent actions -------------------------------------------------------

	{
		key: 'Ctrl+Z',
		command: 'kovix.agent.undo',
		when: 'chatFocused',
		description: 'Undo last agent action',
	},

	{
		key: 'Ctrl+.',
		command: 'kovix.diff.acceptCurrent',
		when: 'diffFocused',
		description: 'Accept pending change',
	},

	{
		key: 'Ctrl+,',
		command: 'kovix.diff.rejectCurrent',
		when: 'diffFocused',
		description: 'Reject pending change',
	},

	{
		key: 'Escape',
		command: 'kovix.agent.cancel',
		when: 'agentRunning',
		description: 'Cancel current agent run',
	},

	// --- Session / tab management --------------------------------------------

	{
		key: 'Ctrl+N',
		macKey: 'Cmd+N',
		command: 'kovix.chat.newSession',
		description: 'New chat session',
	},

	{
		key: 'Ctrl+W',
		macKey: 'Cmd+W',
		command: 'kovix.tab.close',
		description: 'Close current tab',
	},

	{
		key: 'Ctrl+Tab',
		command: 'kovix.tab.switchNext',
		description: 'Switch to next tab',
	},

	// --- Tab shortcuts (1-9) -------------------------------------------------
	// Each gets its own entry because Electron accelerators are explicit.

	{
		key: 'Ctrl+1',
		command: 'kovix.tab.switchTo1',
		description: 'Switch to tab 1',
	},
	{
		key: 'Ctrl+2',
		command: 'kovix.tab.switchTo2',
		description: 'Switch to tab 2',
	},
	{
		key: 'Ctrl+3',
		command: 'kovix.tab.switchTo3',
		description: 'Switch to tab 3',
	},
	{
		key: 'Ctrl+4',
		command: 'kovix.tab.switchTo4',
		description: 'Switch to tab 4',
	},
	{
		key: 'Ctrl+5',
		command: 'kovix.tab.switchTo5',
		description: 'Switch to tab 5',
	},
	{
		key: 'Ctrl+6',
		command: 'kovix.tab.switchTo6',
		description: 'Switch to tab 6',
	},
	{
		key: 'Ctrl+7',
		command: 'kovix.tab.switchTo7',
		description: 'Switch to tab 7',
	},
	{
		key: 'Ctrl+8',
		command: 'kovix.tab.switchTo8',
		description: 'Switch to tab 8',
	},
	{
		key: 'Ctrl+9',
		command: 'kovix.tab.switchTo9',
		description: 'Switch to tab 9',
	},

	// --- Editor commands -----------------------------------------------------

	{
		key: 'F2',
		command: 'kovix.editor.renameSymbol',
		when: 'editorFocused',
		description: 'Rename symbol',
	},

	// --- Debug / run ---------------------------------------------------------

	{
		key: 'F5',
		command: 'kovix.debug.run',
		description: 'Run/debug',
	},
];
