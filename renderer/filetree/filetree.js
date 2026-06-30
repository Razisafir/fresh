/**
 * filetree.js — File tree component for Kovix Layout B.
 *
 * Reads the workspace root from the app state and displays an expandable
 * file tree. Clicking a file fires the `onFileSelect` callback.
 * Filters out common noise directories (node_modules, .git, etc.).
 */

// ---------------------------------------------------------------------------
// Common directories to skip (lightweight .gitignore approach for v1)
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.DS_Store', '__pycache__',
  '.next', '.nuxt', 'dist', 'build', '.cache', '.turbo', '.vercel',
  '.terraform', '.tox', '.venv', 'venv', 'coverage', '.nyc_output',
  'target', 'bin', 'obj', '.idea', '.vscode', '.vs',
]);

// ---------------------------------------------------------------------------
// File icon mapping (minimal/generic for v1)
// ---------------------------------------------------------------------------

const EXT_ICONS = {
  // Web
  '.js': '📜', '.jsx': '📜', '.ts': '📘', '.tsx': '📘', '.vue': '💚',
  '.css': '🎨', '.scss': '🎨', '.less': '🎨', '.html': '🌐', '.htm': '🌐',
  // Data
  '.json': '📋', '.yaml': '📋', '.yml': '📋', '.toml': '📋', '.xml': '📋',
  '.csv': '📊', '.xlsx': '📊',
  // Config
  '.md': '📝', '.txt': '📄', '.env': '🔒', '.gitignore': '🙈',
  // Code
  '.py': '🐍', '.rb': '💎', '.go': '🔵', '.rs': '🦀', '.java': '☕',
  '.c': '⚙️', '.cpp': '⚙️', '.h': '⚙️', '.cs': '🟣',
  '.sh': '🔧', '.bash': '🔧', '.zsh': '🔧',
  // Images
  '.png': '🖼️', '.jpg': '🖼️', '.jpeg': '🖼️', '.gif': '🖼️', '.svg': '🖼️',
  '.ico': '🖼️',
  // Lockfiles
  '.lock': '🔒',
};

function getFileIcon(name) {
  const ext = name.includes('.') ? '.' + name.split('.').pop().toLowerCase() : '';
  return EXT_ICONS[ext] || '📄';
}

// ---------------------------------------------------------------------------
// FileTree class
// ---------------------------------------------------------------------------

class FileTree {
  /**
   * @param {HTMLElement} container - The DOM element to render into.
   * @param {object} api - The window.__kovix_api handle.
   * @param {object} options
   * @param {function} options.onFileSelect - Called when a file is clicked: (filePath: string) => void
   */
  constructor(container, api, options = {}) {
    this.container = container;
    this.api = api;
    this.onFileSelect = options.onFileSelect || (() => {});
    this.workspaceRoot = null;
    this.expandedDirs = new Set();  // Set of expanded directory paths
    this.activeFilePath = null;
    this.pendingPaths = new Set();  // Paths with pending changes
    this.loading = false;
  }

  /**
   * Set the workspace root and load the tree.
   */
  async setWorkspaceRoot(rootPath) {
    console.log('[FileTree] setWorkspaceRoot:', rootPath);
    this.workspaceRoot = rootPath;
    this.expandedDirs.clear();
    this.activeFilePath = null;
    await this.render();
  }

  /**
   * Update which files have pending changes (for visual indicators).
   */
  setPendingPaths(paths) {
    this.pendingPaths = new Set(paths);
    this.renderPendingIndicators();
  }

  /**
   * Set the active (currently open) file.
   */
  setActiveFile(filePath) {
    this.activeFilePath = filePath;
    // Update active class
    const items = this.container.querySelectorAll('.tree-item');
    items.forEach(item => {
      if (item.dataset.path === filePath) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });
  }

  /**
   * Render the full tree from the workspace root.
   */
  async render() {
    if (!this.workspaceRoot) {
      this.container.innerHTML = '<div class="file-tree-empty">Open a folder to see files</div>';
      return;
    }

    this.loading = true;

    // Auto-expand the root
    this.expandedDirs.add(this.workspaceRoot);

    // Clear container before rendering
    this.container.innerHTML = '';

    try {
      await this.renderDirectory(this.workspaceRoot, this.container, 0);
    } catch (err) {
      console.error('[FileTree] render() failed:', err);
      this.container.innerHTML = '<div class="file-tree-empty" style="color:var(--error)">Error loading files: ' + (err instanceof Error ? err.message : String(err)) + '</div>';
    }

    // If nothing was rendered (empty dir), show a message
    if (this.container.children.length === 0) {
      this.container.innerHTML = '<div class="file-tree-empty">Empty folder</div>';
    }

    this.loading = false;
  }

  /**
   * Render a single directory level.
   */
  async renderDirectory(dirPath, parentEl, depth) {
    console.log('[FileTree] renderDirectory:', dirPath);
    let result;
    try {
      result = await this.api.listDirectory(dirPath);
    } catch (err) {
      console.error('[FileTree] listDirectory IPC failed:', err);
      const errItem = document.createElement('div');
      errItem.className = 'tree-item';
      errItem.style.paddingLeft = (depth * 16 + 20) + 'px';
      errItem.textContent = 'IPC error: ' + (err instanceof Error ? err.message : String(err));
      errItem.style.color = 'var(--error)';
      errItem.style.fontStyle = 'italic';
      parentEl.appendChild(errItem);
      return;
    }
    if (result.error) {
      console.error('[FileTree] listDirectory returned error:', result.error);
      const errItem = document.createElement('div');
      errItem.className = 'tree-item';
      errItem.style.paddingLeft = (depth * 16 + 20) + 'px';
      errItem.textContent = 'Error: ' + result.error;
      errItem.style.color = 'var(--error)';
      errItem.style.fontStyle = 'italic';
      parentEl.appendChild(errItem);
      return;
    }

    const entries = result.entries || [];
    console.log('[FileTree] Got', entries.length, 'entries for', dirPath);

    // Filter out skipped directories
    const filtered = entries.filter(([name, type]) => {
      if (type === 'directory' && SKIP_DIRS.has(name)) return false;
      // Also skip common binary/noise files
      if (name === '.DS_Store' || name === 'Thumbs.db') return false;
      return true;
    });

    for (const [name, type] of filtered) {
      const fullPath = dirPath + (dirPath.endsWith('\\') || dirPath.endsWith('/') ? '' : (dirPath.includes('\\') ? '\\' : '/')) + name;
      const isDir = type === 'directory';
      const isExpanded = this.expandedDirs.has(fullPath);
      const hasPending = this.pendingPaths.has(fullPath);
      const isActive = this.activeFilePath === fullPath;

      const item = document.createElement('div');
      item.className = 'tree-item' + (isActive ? ' active' : '') + (hasPending ? ' has-pending' : '');
      item.dataset.path = fullPath;
      item.dataset.type = type;
      item.style.paddingLeft = (depth * 16 + 8) + 'px';

      // Chevron
      const chevron = document.createElement('span');
      chevron.className = 'tree-chevron' + (isExpanded ? ' expanded' : '') + (!isDir ? ' hidden-chevron' : '');
      chevron.textContent = '\u25B6';  // ▶
      item.appendChild(chevron);

      // Icon
      const icon = document.createElement('span');
      icon.className = 'tree-icon ' + (isDir ? 'folder' : 'file');
      icon.textContent = isDir ? (isExpanded ? '📂' : '📁') : getFileIcon(name);
      item.appendChild(icon);

      // Name
      const nameEl = document.createElement('span');
      nameEl.className = 'tree-name';
      nameEl.textContent = name;
      item.appendChild(nameEl);

      // Pending dot
      if (hasPending) {
        const dot = document.createElement('span');
        dot.className = 'tree-pending-dot';
        item.appendChild(dot);
      }

      // Click handler
      if (isDir) {
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          this.toggleDirectory(fullPath);
        });
      } else {
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          this.activeFilePath = fullPath;
          this.setActiveFile(fullPath);
          this.onFileSelect(fullPath);
        });
      }

      parentEl.appendChild(item);

      // Render children if expanded
      if (isDir && isExpanded) {
        const childContainer = document.createElement('div');
        childContainer.className = 'tree-children';
        childContainer.dataset.parentPath = fullPath;
        parentEl.appendChild(childContainer);
        await this.renderDirectory(fullPath, childContainer, depth + 1);
      }
    }
  }

  /**
   * Toggle a directory's expanded/collapsed state.
   */
  async toggleDirectory(dirPath) {
    if (this.expandedDirs.has(dirPath)) {
      this.expandedDirs.delete(dirPath);
    } else {
      this.expandedDirs.add(dirPath);
    }
    // Re-render the whole tree (simple approach for v1)
    await this.render();
  }

  /**
   * Update pending change indicators without full re-render.
   */
  renderPendingIndicators() {
    const items = this.container.querySelectorAll('.tree-item');
    items.forEach(item => {
      const path = item.dataset.path;
      if (this.pendingPaths.has(path)) {
        item.classList.add('has-pending');
        // Add dot if not already present
        if (!item.querySelector('.tree-pending-dot')) {
          const dot = document.createElement('span');
          dot.className = 'tree-pending-dot';
          item.appendChild(dot);
        }
      } else {
        item.classList.remove('has-pending');
        const dot = item.querySelector('.tree-pending-dot');
        if (dot) dot.remove();
      }
    });
  }

  /**
   * Refresh the tree (e.g., after a file change is accepted).
   */
  async refresh() {
    await this.render();
  }
}

// Export for use by layout
window.KovixFileTree = FileTree;
