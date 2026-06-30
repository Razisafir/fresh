/**
 * editor.js — Monaco editor wrapper for Kovix Layout B.
 *
 * Provides:
 *   - Syntax-highlighted file viewing (read from IPC)
 *   - Diff view for pending changes (original vs proposed)
 *   - Accept/Reject actions that go through pendingChangesService
 *
 * CRITICAL CONSTRAINT: The editor NEVER writes directly to disk.
 * Monaco's onDidChangeModelContent only updates an in-memory model.
 * The only path to disk is still pendingChangesService.accept().
 */

// ---------------------------------------------------------------------------
// Language detection from file extension
// ---------------------------------------------------------------------------

const LANG_MAP = {
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.json': 'json',
  '.md': 'markdown',
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'c',
  '.cs': 'csharp',
  '.sh': 'shell',
  '.bash': 'shell',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.xml': 'xml',
  '.sql': 'sql',
  '.graphql': 'graphql',
  '.vue': 'html',
  '.dockerfile': 'dockerfile',
};

function getLanguageId(filePath) {
  if (!filePath) return 'plaintext';
  const basename = filePath.split('/').pop() || filePath.split('\\').pop() || '';
  // Check exact filename matches first
  if (basename === 'Dockerfile') return 'dockerfile';
  if (basename === 'Makefile') return 'makefile';
  if (basename === '.gitignore' || basename === '.env') return 'plaintext';
  const ext = basename.includes('.') ? '.' + basename.split('.').pop().toLowerCase() : '';
  return LANG_MAP[ext] || 'plaintext';
}

// ---------------------------------------------------------------------------
// KovixEditor class
// ---------------------------------------------------------------------------

class KovixEditor {
  /**
   * @param {HTMLElement} container - The DOM element to hold the Monaco editor.
   * @param {HTMLElement} headerEl - The header element for file path / actions.
   * @param {object} api - The window.__kovix_api handle.
   * @param {object} options
   * @param {function} options.onAccept - Called after a change is accepted: (filePath: string) => void
   * @param {function} options.onReject - Called after a change is rejected: (filePath: string) => void
   */
  constructor(container, headerEl, api, options = {}) {
    this.container = container;
    this.headerEl = headerEl;
    this.api = api;
    this.onAccept = options.onAccept || (() => {});
    this.onReject = options.onReject || (() => {});

    this.monaco = null;          // Monaco API reference
    this.editor = null;          // Current editor instance
    this.diffEditor = null;      // Current diff editor instance
    this.currentFilePath = null; // Currently open file path
    this.currentModel = null;    // Current regular model
    this.isDiffMode = false;     // Whether we're showing a diff
    this.pendingEntry = null;    // Current pending entry being viewed

    // Placeholder element
    this.emptyEl = null;
    this.editorWrapperEl = null;
  }

  /**
   * Initialize Monaco editor. Must be called after the AMD loader is ready.
   */
  async init() {
    return new Promise((resolve, reject) => {
      // Monaco is loaded via AMD loader configured in index.html.
      // require is the AMD require, not Node's require.
      const amdRequire = window.require;  // AMD require set by Monaco's loader
      amdRequire(['vs/editor/editor.main'], (monacoApi) => {
        this.monaco = monacoApi;

        // Define a dark theme matching our design tokens
        this.monaco.editor.defineTheme('kovix-dark', {
          base: 'vs-dark',
          inherit: true,
          rules: [
            { token: 'comment', foreground: '6A9955', fontStyle: 'italic' },
            { token: 'keyword', foreground: 'C586C0' },
            { token: 'string', foreground: 'CE9178' },
            { token: 'number', foreground: 'B5CEA8' },
            { token: 'type', foreground: '4EC9B0' },
            { token: 'function', foreground: 'DCDCAA' },
            { token: 'variable', foreground: '9CDCFE' },
          ],
          colors: {
            'editor.background': '#1e1e1e',
            'editor.foreground': '#cccccc',
            'editor.lineHighlightBackground': '#2a2a2a',
            'editor.selectionBackground': '#264f78',
            'editorCursor.foreground': '#7c83ff',
            'editorLineNumber.foreground': '#5a5a5a',
            'editorLineNumber.activeForeground': '#cccccc',
            'editor.inactiveSelectionBackground': '#3a3d4110',
            'diffEditor.insertedTextBackground': '#4ec9b020',
            'diffEditor.insertedLineBackground': '#4ec9b015',
            'diffEditor.removedTextBackground': '#f4474720',
            'diffEditor.removedLineBackground': '#f4474715',
          },
        });

        // Create the empty state
        this._createEmptyState();

        resolve();
      }, (err) => {
        reject(err);
      });
    });
  }

  /**
   * Create the empty state placeholder.
   */
  _createEmptyState() {
    this.container.innerHTML = '';
    this.emptyEl = document.createElement('div');
    this.emptyEl.className = 'editor-empty';
    this.emptyEl.innerHTML = `
      <div class="editor-empty-icon">{ }</div>
      <div>Select a file to view</div>
      <div class="editor-empty-hint">Click a file in the tree or run an agent task</div>
    `;
    this.container.appendChild(this.emptyEl);
  }

  /**
   * Open a file for viewing.
   * @param {string} filePath - Absolute path to the file.
   */
  async openFile(filePath) {
    this.currentFilePath = filePath;

    // Read the file content via IPC
    const result = await this.api.readFile(filePath);
    if (result.error) {
      this._showError('Failed to read file: ' + result.error);
      return;
    }

    const content = result.content || '';
    const language = getLanguageId(filePath);

    // Check if there's a pending change for this file
    const pendingDetail = await this.api.getPendingEntryDetail(filePath);

    if (pendingDetail) {
      // Show diff view
      this.pendingEntry = pendingDetail;
      await this._showDiff(pendingDetail.originalContent, pendingDetail.proposedContent, language);
    } else {
      // Show normal editor
      this.pendingEntry = null;
      this._showEditor(content, language);
    }
  }

  /**
   * Show a regular (non-diff) editor.
   */
  _showEditor(content, language) {
    this.isDiffMode = false;

    // Dispose previous editors
    if (this.diffEditor) {
      this.diffEditor.dispose();
      this.diffEditor = null;
    }

    // Clear container
    this.container.innerHTML = '';

    // Remove empty state if present
    if (this.emptyEl) {
      this.emptyEl = null;
    }

    // Create editor wrapper
    this.editorWrapperEl = document.createElement('div');
    this.editorWrapperEl.style.width = '100%';
    this.editorWrapperEl.style.height = '100%';
    this.container.appendChild(this.editorWrapperEl);

    // Update header
    this._updateHeader(false);

    // Create model
    if (this.currentModel) {
      this.currentModel.dispose();
    }
    this.currentModel = this.monaco.editor.createModel(content, language);

    // Create editor — READ ONLY (the only write path is pendingChangesService.accept())
    this.editor = this.monaco.editor.create(this.editorWrapperEl, {
      model: this.currentModel,
      theme: 'kovix-dark',
      readOnly: true,
      minimap: { enabled: false },
      fontSize: 13,
      lineHeight: 20,
      fontFamily: "'Fira Code', 'Cascadia Code', 'Consolas', monospace",
      scrollBeyondLastLine: false,
      renderLineHighlight: 'all',
      automaticLayout: true,
      padding: { top: 8 },
    });
  }

  /**
   * Show a diff editor for a pending change.
   */
  async _showDiff(originalContent, proposedContent, language) {
    this.isDiffMode = true;

    // Dispose previous editors
    if (this.editor) {
      this.editor.dispose();
      this.editor = null;
    }
    if (this.currentModel) {
      this.currentModel.dispose();
      this.currentModel = null;
    }

    // Clear container
    this.container.innerHTML = '';
    if (this.emptyEl) {
      this.emptyEl = null;
    }

    // Create editor wrapper
    this.editorWrapperEl = document.createElement('div');
    this.editorWrapperEl.style.width = '100%';
    this.editorWrapperEl.style.height = '100%';
    this.container.appendChild(this.editorWrapperEl);

    // Update header with diff badge + actions
    this._updateHeader(true);

    // Create models for diff
    const originalModel = this.monaco.editor.createModel(originalContent || '', language);
    const modifiedModel = this.monaco.editor.createModel(proposedContent || '', language);

    // Create diff editor — BOTH SIDES READ ONLY
    this.diffEditor = this.monaco.editor.createDiffEditor(this.editorWrapperEl, {
      theme: 'kovix-dark',
      readOnly: true,            // Original is read-only
      renderSideBySide: true,    // Side-by-side diff view
      minimap: { enabled: false },
      fontSize: 13,
      lineHeight: 20,
      fontFamily: "'Fira Code', 'Cascadia Code', 'Consolas', monospace",
      scrollBeyondLastLine: false,
      automaticLayout: true,
      padding: { top: 8 },
      // The diff editor's modified side is also read-only:
      // the only write path is pendingChangesService.accept()
      originalEditable: false,
    });

    this.diffEditor.setModel({
      original: originalModel,
      modified: modifiedModel,
    });

    // Store modified model for later cleanup
    this._diffOriginalModel = originalModel;
    this._diffModifiedModel = modifiedModel;
  }

  /**
   * Update the header bar.
   */
  _updateHeader(isDiff) {
    // Clear header
    this.headerEl.innerHTML = '';

    // File path
    const pathEl = document.createElement('span');
    pathEl.className = 'editor-file-path';
    // Show relative path from workspace root if possible
    pathEl.textContent = this.currentFilePath ? this.currentFilePath.split('/').pop() : '';
    pathEl.title = this.currentFilePath || '';
    this.headerEl.appendChild(pathEl);

    if (isDiff) {
      // Diff badge
      const badge = document.createElement('span');
      badge.className = 'editor-diff-badge';
      badge.textContent = 'Pending Change';
      this.headerEl.appendChild(badge);

      // Actions
      const actions = document.createElement('div');
      actions.className = 'editor-actions';

      const acceptBtn = document.createElement('button');
      acceptBtn.className = 'btn-editor-accept';
      acceptBtn.textContent = 'Accept';
      acceptBtn.addEventListener('click', () => this._acceptChange());
      actions.appendChild(acceptBtn);

      const rejectBtn = document.createElement('button');
      rejectBtn.className = 'btn-editor-reject';
      rejectBtn.textContent = 'Reject';
      rejectBtn.addEventListener('click', () => this._rejectChange());
      actions.appendChild(rejectBtn);

      this.headerEl.appendChild(actions);
    }
  }

  /**
   * Accept a pending change via the pendingChangesService.
   */
  async _acceptChange() {
    if (!this.currentFilePath) return;
    await this.api.acceptChange(this.currentFilePath);
    this.onAccept(this.currentFilePath);
    // Re-open the file to show the accepted state
    await this.openFile(this.currentFilePath);
  }

  /**
   * Reject a pending change via the pendingChangesService.
   */
  async _rejectChange() {
    if (!this.currentFilePath) return;
    await this.api.rejectChange(this.currentFilePath);
    this.onReject(this.currentFilePath);
    // Re-open the file to show the reverted state
    await this.openFile(this.currentFilePath);
  }

  /**
   * Show an error message in the editor area.
   */
  _showError(message) {
    this.container.innerHTML = '';
    const errEl = document.createElement('div');
    errEl.className = 'editor-empty';
    errEl.innerHTML = `<div style="color:var(--error)">${this._escapeHtml(message)}</div>`;
    this.container.appendChild(errEl);
    this._updateHeader(false);
  }

  _escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /**
   * Clean up editors and models.
   */
  dispose() {
    if (this.editor) { this.editor.dispose(); this.editor = null; }
    if (this.diffEditor) { this.diffEditor.dispose(); this.diffEditor = null; }
    if (this.currentModel) { this.currentModel.dispose(); this.currentModel = null; }
    if (this._diffOriginalModel) { this._diffOriginalModel.dispose(); this._diffOriginalModel = null; }
    if (this._diffModifiedModel) { this._diffModifiedModel.dispose(); this._diffModifiedModel = null; }
  }
}

// Export for use by layout
window.KovixEditor = KovixEditor;
