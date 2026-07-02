/**
 * terminal.js — Integrated terminal for Kovix using xterm.js + node-pty.
 *
 * Provides a VS Code-style terminal panel that sits below the editor.
 * Supports multiple terminal instances, create/close/switch tabs.
 */

class KovixTerminal {
  /**
   * @param {HTMLElement} container - The #terminal-panel element
   * @param {object} api - The window.__kovix_api bridge
   * @param {object} [options]
   * @param {function} [options.onToggle] - Called when panel visibility changes
   * @param {function} [options.onResize] - Called when panel height changes
   */
  constructor(container, api, options = {}) {
    this.container = container;
    this.api = api;
    this.options = options;
    this.terminals = new Map(); // id → { xterm, fitAddon, ptyId, tabEl, containerEl }
    this.activeId = null;
    this.isCollapsed = false;
    this._resizeObserver = null;

    this._buildUI();
    this._setupEventListeners();
  }

  /** Build the terminal panel DOM structure */
  _buildUI() {
    this.container.innerHTML = '';

    // Resize handle (top)
    this.resizeHandle = document.createElement('div');
    this.resizeHandle.className = 'terminal-resize-handle';
    this.container.appendChild(this.resizeHandle);

    // Header
    this.header = document.createElement('div');
    this.header.className = 'terminal-header';
    this.header.innerHTML = `
      <span class="terminal-header-title">Terminal</span>
      <div class="terminal-tabs"></div>
      <div class="terminal-header-actions">
        <button class="terminal-btn" id="terminal-btn-new" title="New Terminal (+)">+</button>
        <button class="terminal-btn" id="terminal-btn-trash" title="Kill Active Terminal">&#128465;</button>
        <button class="terminal-btn" id="terminal-btn-collapse" title="Toggle Terminal (Ctrl+`)">&#9660;</button>
      </div>
    `;
    this.container.appendChild(this.header);

    this.tabContainer = this.header.querySelector('.terminal-tabs');
    this.bodyContainer = document.createElement('div');
    this.bodyContainer.className = 'terminal-body';
    this.container.appendChild(this.bodyContainer);

    // Button listeners
    this.header.querySelector('#terminal-btn-new').addEventListener('click', () => this.createTerminal());
    this.header.querySelector('#terminal-btn-trash').addEventListener('click', () => this.killActive());
    this.collapseBtn = this.header.querySelector('#terminal-btn-collapse');
    this.collapseBtn.addEventListener('click', () => this.toggle());
  }

  /** Set up IPC event listeners for terminal data/exit */
  _setupEventListeners() {
    // Data from PTY → xterm
    this.api.onTerminalData(({ id, data }) => {
      const term = this.terminals.get(id);
      if (term && term.xterm) {
        term.xterm.write(data);
      }
    });

    // PTY exit
    this.api.onTerminalExit(({ id, exitCode }) => {
      const term = this.terminals.get(id);
      if (term) {
        term.xterm.write(`\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m\r\n`);
        // Disable further input
        term.exited = true;
      }
    });
  }

  /** Create a new terminal instance */
  async createTerminal(options = {}) {
    // Check if xterm is loaded
    if (typeof Terminal === 'undefined') {
      console.error('[Terminal] xterm.js Terminal class not found. Make sure xterm.js is loaded.');
      this.bodyContainer.innerHTML = '<div class="terminal-empty">Loading terminal...</div>';
      return null;
    }

    // Spawn PTY on main process
    const cwd = options.cwd || (window.fileTree && window.fileTree.workspaceRoot) || undefined;
    const result = await this.api.terminalCreate({ cwd, shell: options.shell });
    if (result.error) {
      console.error('[Terminal] Failed to create PTY:', result.error);
      return null;
    }

    const ptyId = result.id;

    // Create xterm instance
    const xterm = new Terminal({
      theme: this._getTheme(),
      fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', 'Courier New', monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 5000,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon.FitAddon();
    xterm.loadAddon(fitAddon);

    // Create a container div for this terminal
    const termContainer = document.createElement('div');
    termContainer.style.height = '100%';
    termContainer.style.width = '100%';
    termContainer.style.display = 'none';
    this.bodyContainer.appendChild(termContainer);

    xterm.open(termContainer);
    fitAddon.fit();

    // Wire xterm → PTY input
    xterm.onData((data) => {
      if (!this.terminals.get(ptyId)?.exited) {
        this.api.terminalWrite(ptyId, data);
      }
    });

    // Wire xterm resize → PTY resize
    xterm.onResize(({ cols, rows }) => {
      this.api.terminalResize(ptyId, cols, rows);
    });

    // Create tab
    const tabEl = document.createElement('button');
    tabEl.className = 'terminal-tab';
    tabEl.textContent = `Terminal ${this.terminals.size + 1}`;
    tabEl.addEventListener('click', () => this.switchTo(ptyId));

    const closeBtn = document.createElement('span');
    closeBtn.className = 'terminal-tab-close';
    closeBtn.innerHTML = '&#10005;';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.killTerminal(ptyId);
    });
    tabEl.appendChild(closeBtn);

    this.tabContainer.appendChild(tabEl);

    // Store
    this.terminals.set(ptyId, {
      xterm,
      fitAddon,
      ptyId,
      tabEl,
      containerEl: termContainer,
      exited: false,
    });

    // Switch to new terminal
    this.switchTo(ptyId);

    // Uncollapse if collapsed
    if (this.isCollapsed) {
      this.toggle();
    }

    // Resize observer for auto-fit
    if (!this._resizeObserver) {
      this._resizeObserver = new ResizeObserver(() => {
        this._refitActive();
      });
      this._resizeObserver.observe(this.bodyContainer);
    }

    console.log(`[Terminal] Created terminal ${ptyId} (pid=${result.pid})`);
    return ptyId;
  }

  /** Switch to a terminal tab */
  switchTo(id) {
    // Hide all
    for (const [termId, term] of this.terminals) {
      term.containerEl.style.display = 'none';
      term.tabEl.classList.remove('active');
    }

    // Show target
    const term = this.terminals.get(id);
    if (term) {
      term.containerEl.style.display = 'block';
      term.tabEl.classList.add('active');
      this.activeId = id;
      // Refit on switch
      setTimeout(() => {
        try { term.fitAddon.fit(); } catch { /* */ }
        term.xterm.focus();
      }, 50);
    }
  }

  /** Kill a specific terminal */
  async killTerminal(id) {
    const term = this.terminals.get(id);
    if (!term) return;

    await this.api.terminalKill(id);
    term.xterm.dispose();
    term.containerEl.remove();
    term.tabEl.remove();
    this.terminals.delete(id);

    // Switch to another tab if the killed one was active
    if (this.activeId === id) {
      const remaining = [...this.terminals.keys()];
      if (remaining.length > 0) {
        this.switchTo(remaining[0]);
      } else {
        this.activeId = null;
        this.bodyContainer.innerHTML = '<div class="terminal-empty">No terminals. Click + to create one.</div>';
      }
    }
  }

  /** Kill the active terminal */
  killActive() {
    if (this.activeId) {
      this.killTerminal(this.activeId);
    }
  }

  /** Toggle collapsed/expanded */
  toggle() {
    this.isCollapsed = !this.isCollapsed;
    this.container.classList.toggle('collapsed', this.isCollapsed);
    this.collapseBtn.innerHTML = this.isCollapsed ? '&#9650;' : '&#9660;';
    this.collapseBtn.title = this.isCollapsed ? 'Show Terminal (Ctrl+`)' : 'Hide Terminal (Ctrl+`)';

    if (!this.isCollapsed) {
      setTimeout(() => this._refitActive(), 100);
    }

    if (this.options.onToggle) {
      this.options.onToggle(!this.isCollapsed);
    }
  }

  /** Refit the active terminal */
  _refitActive() {
    const term = this.terminals.get(this.activeId);
    if (term && !this.isCollapsed) {
      try { term.fitAddon.fit(); } catch { /* */ }
    }
  }

  /** Get the xterm theme */
  _getTheme() {
    const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
    if (isDark) {
      return {
        background: '#1E1E1E',
        foreground: '#D4D4D4',
        cursor: '#D4D4D4',
        cursorAccent: '#1E1E1E',
        selectionBackground: '#264F78',
        black: '#000000',
        red: '#CD3131',
        green: '#0DBC79',
        yellow: '#E5E510',
        blue: '#2472C8',
        magenta: '#BC3FBC',
        cyan: '#11A8CD',
        white: '#E5E5E5',
        brightBlack: '#666666',
        brightRed: '#F14C4C',
        brightGreen: '#23D18B',
        brightYellow: '#F5F543',
        brightBlue: '#3B8EEA',
        brightMagenta: '#D670D6',
        brightCyan: '#29B8DB',
        brightWhite: '#FFFFFF',
      };
    } else {
      return {
        background: '#FFFFFF',
        foreground: '#383A42',
        cursor: '#383A42',
        cursorAccent: '#FFFFFF',
        selectionBackground: '#ADD6FF',
        black: '#383A42',
        red: '#E45649',
        green: '#50A14F',
        yellow: '#C18401',
        blue: '#4078F2',
        magenta: '#A626A4',
        cyan: '#0184BC',
        white: '#A0A1A7',
        brightBlack: '#4F525E',
        brightRed: '#E06C75',
        brightGreen: '#98C379',
        brightYellow: '#E5C07B',
        brightBlue: '#61AFEF',
        brightMagenta: '#C678DD',
        brightCyan: '#56B6C2',
        brightWhite: '#FFFFFF',
      };
    }
  }

  /** Update theme on all terminals */
  updateTheme() {
    const theme = this._getTheme();
    for (const [, term] of this.terminals) {
      if (term.xterm) {
        term.xterm.options.theme = theme;
      }
    }
  }

  /** Set the CWD for new terminals (e.g. when workspace changes) */
  setCwd(cwd) {
    this._defaultCwd = cwd;
  }

  /** Setup the resize handle drag */
  setupResizeHandle() {
    let startY = 0;
    let startHeight = 0;

    this.resizeHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startY = e.clientY;
      startHeight = this.container.offsetHeight;
      this.resizeHandle.classList.add('active');

      const onMouseMove = (e) => {
        const delta = startY - e.clientY; // drag up = increase height
        let newHeight = startHeight + delta;
        newHeight = Math.max(36, Math.min(400, newHeight));
        this.container.style.height = newHeight + 'px';

        if (this.isCollapsed && newHeight > 36) {
          this.isCollapsed = false;
          this.container.classList.remove('collapsed');
          this.collapseBtn.innerHTML = '&#9660;';
        }

        this._refitActive();
        if (this.options.onResize) this.options.onResize(newHeight);
      };

      const onMouseUp = () => {
        this.resizeHandle.classList.remove('active');
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }
}

// Expose globally
window.KovixTerminal = KovixTerminal;
