/**
 * editor.js — Monaco editor wrapper for Kovix Layout B.
 *
 * Provides:
 *   - Syntax-highlighted file viewing (read from IPC)
 *   - Diff view for pending changes (original vs proposed)
 *   - Accept/Reject actions that go through pendingChangesService
 *   - Tab integration via onFileOpen callback
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
   * @param {function} options.onFileOpen - Called when a file is opened: (filePath: string) => void
   */
  constructor(container, headerEl, api, options = {}) {
    this.container = container;
    this.headerEl = headerEl;
    this.api = api;
    this.onAccept = options.onAccept || (() => {});
    this.onReject = options.onReject || (() => {});
    this.onFileOpen = options.onFileOpen || (() => {});

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
      const amdRequire = window.require;
      amdRequire(['vs/editor/editor.main'], (monacoApi) => {
        this.monaco = monacoApi;

        // Define a dark theme matching our Chromium-style design
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
            'editor.background': '#0d1117',
            'editor.foreground': '#e6edf3',
            'editor.lineHighlightBackground': '#161b22',
            'editor.selectionBackground': '#264f78',
            'editorCursor.foreground': '#7c83ff',
            'editorLineNumber.foreground': '#30363d',
            'editorLineNumber.activeForeground': '#8b949e',
            'editor.inactiveSelectionBackground': '#1c2128',
            'diffEditor.insertedTextBackground': '#3fb95020',
            'diffEditor.insertedLineBackground': '#3fb95012',
            'diffEditor.removedTextBackground': '#f8514920',
            'diffEditor.removedLineBackground': '#f8514912',
            'editorWidget.background': '#161b22',
            'editorWidget.border': '#30363d',
            'editorSuggestWidget.background': '#161b22',
            'editorSuggestWidget.border': '#30363d',
            'editorSuggestWidget.selectedBackground': '#1c2128',
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
      <div class="editor-empty-title">No file open</div>
      <div class="editor-empty-hint">Click a file in the tree or run an agent task to get started</div>
      <div class="editor-empty-shortcuts">
        <span class="editor-shortcut"><kbd>Ctrl+B</kbd> Toggle file tree</span>
        <span class="editor-shortcut"><kbd>Ctrl+J</kbd> Toggle chat</span>
      </div>
    `;
    this.container.appendChild(this.emptyEl);
  }

  /**
   * Open a file for viewing.
   * @param {string} filePath - Absolute path to the file.
   */
  async openFile(filePath) {
    this.currentFilePath = filePath;

    // Notify the tab system
    this.onFileOpen(filePath);

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
      this.pendingEntry = pendingDetail;
      await this._showDiff(pendingDetail.originalContent, pendingDetail.proposedContent, language);
    } else {
      this.pendingEntry = null;
      this._showEditor(content, language);
    }
  }

  /**
   * Close the current file and show empty state.
   */
  closeFile() {
    this.currentFilePath = null;
    this.pendingEntry = null;
    this.isDiffMode = false;

    if (this.editor) { this.editor.dispose(); this.editor = null; }
    if (this.diffEditor) { this.diffEditor.dispose(); this.diffEditor = null; }
    if (this.currentModel) { this.currentModel.dispose(); this.currentModel = null; }
    if (this._diffOriginalModel) { this._diffOriginalModel.dispose(); this._diffOriginalModel = null; }
    if (this._diffModifiedModel) { this._diffModifiedModel.dispose(); this._diffModifiedModel = null; }

    this._createEmptyState();
    this._updateHeader(false);
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
    if (this.emptyEl) this.emptyEl = null;

    // Create editor wrapper
    this.editorWrapperEl = document.createElement('div');
    this.editorWrapperEl.style.width = '100%';
    this.editorWrapperEl.style.height = '100%';
    this.container.appendChild(this.editorWrapperEl);

    // Update header
    this._updateHeader(false);

    // Create model
    if (this.currentModel) this.currentModel.dispose();
    this.currentModel = this.monaco.editor.createModel(content, language);

    // Create editor — READ ONLY
    this.editor = this.monaco.editor.create(this.editorWrapperEl, {
      model: this.currentModel,
      theme: this._getTheme(),
      readOnly: true,
      minimap: { enabled: false },
      fontSize: 13,
      lineHeight: 20,
      fontFamily: "'Fira Code', 'Cascadia Code', 'Consolas', monospace",
      scrollBeyondLastLine: false,
      renderLineHighlight: 'all',
      automaticLayout: true,
      padding: { top: 8 },
      scrollbar: {
        verticalScrollbarSize: 8,
        horizontalScrollbarSize: 8,
      },
    });
  }

  /**
   * Show a diff editor for a pending change.
   */
  async _showDiff(originalContent, proposedContent, language) {
    this.isDiffMode = true;

    if (this.editor) { this.editor.dispose(); this.editor = null; }
    if (this.currentModel) { this.currentModel.dispose(); this.currentModel = null; }

    this.container.innerHTML = '';
    if (this.emptyEl) this.emptyEl = null;

    this.editorWrapperEl = document.createElement('div');
    this.editorWrapperEl.style.width = '100%';
    this.editorWrapperEl.style.height = '100%';
    this.container.appendChild(this.editorWrapperEl);

    this._updateHeader(true);

    const originalModel = this.monaco.editor.createModel(originalContent || '', language);
    const modifiedModel = this.monaco.editor.createModel(proposedContent || '', language);

    this.diffEditor = this.monaco.editor.createDiffEditor(this.editorWrapperEl, {
      theme: this._getTheme(),
      readOnly: true,
      renderSideBySide: true,
      minimap: { enabled: false },
      fontSize: 13,
      lineHeight: 20,
      fontFamily: "'Fira Code', 'Cascadia Code', 'Consolas', monospace",
      scrollBeyondLastLine: false,
      automaticLayout: true,
      padding: { top: 8 },
      originalEditable: false,
      scrollbar: {
        verticalScrollbarSize: 8,
        horizontalScrollbarSize: 8,
      },
    });

    this.diffEditor.setModel({
      original: originalModel,
      modified: modifiedModel,
    });

    this._diffOriginalModel = originalModel;
    this._diffModifiedModel = modifiedModel;
  }

  /**
   * Update the header bar.
   */
  _updateHeader(isDiff) {
    this.headerEl.innerHTML = '';

    const pathEl = document.createElement('span');
    pathEl.className = 'editor-file-path';
    // Show just the filename — the tab bar shows it too but this gives context
    const fileName = this.currentFilePath
      ? (this.currentFilePath.split('/').pop() || this.currentFilePath.split('\\').pop() || this.currentFilePath)
      : '';
    pathEl.textContent = fileName;
    pathEl.title = this.currentFilePath || '';
    this.headerEl.appendChild(pathEl);

    if (isDiff) {
      const badge = document.createElement('span');
      badge.className = 'editor-diff-badge';
      badge.textContent = 'Pending Change';
      this.headerEl.appendChild(badge);

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

  async _acceptChange() {
    if (!this.currentFilePath) return;
    await this.api.acceptChange(this.currentFilePath);
    this.onAccept(this.currentFilePath);
    await this.openFile(this.currentFilePath);
  }

  async _rejectChange() {
    if (!this.currentFilePath) return;
    await this.api.rejectChange(this.currentFilePath);
    this.onReject(this.currentFilePath);
    await this.openFile(this.currentFilePath);
  }

  _showError(message) {
    this.container.innerHTML = '';
    const errEl = document.createElement('div');
    errEl.className = 'editor-empty';
    errEl.innerHTML = `<div style="color:#f85149">${this._escapeHtml(message)}</div>`;
    this.container.appendChild(errEl);
    this._updateHeader(false);
  }

  _escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /**
   * Get the Monaco theme based on current app theme.
   */
  _getTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'vs' : 'kovix-dark';
  }

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
