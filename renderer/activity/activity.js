/**
 * activity.js — Agent Activity Panel for Kovix IDE.
 *
 * Shows a real-time feed of everything the agent is doing:
 * tool calls, file operations, commands, thinking, milestones,
 * verification results, etc.
 *
 * Integrates with the editor: clicking a file path opens it in Monaco.
 * Each activity entry is collapsible (thought process, task completion, etc.)
 */

// ---------------------------------------------------------------------------
// Activity entry types and their display config
// ---------------------------------------------------------------------------

const ACTIVITY_CONFIG = {
  thinking:       { icon: '\u{1F4AD}', label: 'Thinking',          color: '#8b949e', collapsible: true,  defaultCollapsed: true  },
  token:          { icon: '\u270D\uFE0F',  label: 'Responding',       color: '#7c83ff', collapsible: false, defaultCollapsed: false },
  tool_start:     { icon: '\u{1F527}', label: 'Tool Call',          color: '#d29922', collapsible: true,  defaultCollapsed: false },
  tool_executing: { icon: '\u2699\uFE0F',  label: 'Executing',        color: '#d29922', collapsible: false, defaultCollapsed: false },
  tool_result:    { icon: '\u2705', label: 'Tool Result',        color: '#3fb950', collapsible: true,  defaultCollapsed: true  },
  file_written:   { icon: '\u{1F4DD}', label: 'File Written',       color: '#58a6ff', collapsible: false, defaultCollapsed: false },
  file_read:      { icon: '\u{1F4C4}', label: 'File Read',          color: '#8b949e', collapsible: false, defaultCollapsed: false },
  command:        { icon: '\u{1F4BB}', label: 'Command',            color: '#d29922', collapsible: true,  defaultCollapsed: false },
  plan_ready:     { icon: '\u{1F4CB}', label: 'Plan Ready',         color: '#7c83ff', collapsible: true,  defaultCollapsed: false },
  milestone:      { icon: '\u{1F3C1}', label: 'Milestone',          color: '#d29922', collapsible: false, defaultCollapsed: false },
  verification:   { icon: '\u{1F50D}', label: 'Verification',       color: '#58a6ff', collapsible: true,  defaultCollapsed: true  },
  complete:       { icon: '\u2705', label: 'Complete',            color: '#3fb950', collapsible: true,  defaultCollapsed: true  },
  error:          { icon: '\u274C', label: 'Error',               color: '#f85149', collapsible: true,  defaultCollapsed: false },
  pipeline:       { icon: '\u{1F680}', label: 'Pipeline',           color: '#7c83ff', collapsible: false, defaultCollapsed: false },
  swarm:          { icon: '\u{1F41D}', label: 'Swarm',              color: '#d29922', collapsible: false, defaultCollapsed: false },
  info:           { icon: '\u2139\uFE0F',  label: 'Info',             color: '#8b949e', collapsible: false, defaultCollapsed: false },
};

// ---------------------------------------------------------------------------
// AgentActivityPanel class
// ---------------------------------------------------------------------------

class AgentActivityPanel {
  /**
   * @param {HTMLElement} container - DOM element to render into
   * @param {object} api - window.__kovix_api handle
   * @param {object} options
   * @param {function} options.onFileClick - Called when user clicks a file path
   * @param {function} options.onToggle - Called when panel visibility changes
   */
  constructor(container, api, options = {}) {
    this.container = container;
    this.api = api;
    this.onFileClick = options.onFileClick || (() => {});
    this.onToggle = options.onToggle || (() => {});

    this.entries = [];       // All activity entries
    this.maxEntries = 500;   // Limit to prevent memory bloat
    this.isVisible = true;
    this.isPaused = false;   // Pause auto-scroll
    this.filterLevel = 'all'; // 'all' | 'important' | 'files'

    // Current streaming state
    this._currentToolStart = null;
    this._streamingEntry = null;

    this._buildUI();
  }

  /**
   * Build the panel UI structure.
   */
  _buildUI() {
    this.container.innerHTML = '';
    this.container.className = 'agent-activity-panel';

    // Header bar
    const header = document.createElement('div');
    header.className = 'activity-header';

    const titleEl = document.createElement('span');
    titleEl.className = 'activity-title';
    titleEl.innerHTML = '\u{1F916} Agent Activity';

    const controls = document.createElement('div');
    controls.className = 'activity-controls';

    // Filter buttons
    const filterBtns = ['all', 'important', 'files'].map(level => {
      const btn = document.createElement('button');
      btn.className = 'activity-filter-btn' + (level === this.filterLevel ? ' active' : '');
      btn.textContent = level.charAt(0).toUpperCase() + level.slice(1);
      btn.dataset.level = level;
      btn.addEventListener('click', () => {
        this.filterLevel = level;
        controls.querySelectorAll('.activity-filter-btn').forEach(b => b.classList.toggle('active', b.dataset.level === level));
        this._render();
      });
      return btn;
    });

    // Pause button
    const pauseBtn = document.createElement('button');
    pauseBtn.className = 'activity-pause-btn';
    pauseBtn.textContent = '\u23F8';
    pauseBtn.title = 'Pause auto-scroll';
    pauseBtn.addEventListener('click', () => {
      this.isPaused = !this.isPaused;
      pauseBtn.textContent = this.isPaused ? '\u25B6' : '\u23F8';
      pauseBtn.title = this.isPaused ? 'Resume auto-scroll' : 'Pause auto-scroll';
      pauseBtn.classList.toggle('paused', this.isPaused);
    });

    // Clear button
    const clearBtn = document.createElement('button');
    clearBtn.className = 'activity-clear-btn';
    clearBtn.textContent = '\u{1F5D1}';
    clearBtn.title = 'Clear activity log';
    clearBtn.addEventListener('click', () => {
      this.entries = [];
      this._currentToolStart = null;
      this._streamingEntry = null;
      this._render();
    });

    // Toggle button (minimize)
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'activity-toggle-btn';
    toggleBtn.textContent = '\u{1F4CA}';
    toggleBtn.title = 'Toggle activity panel';
    toggleBtn.addEventListener('click', () => {
      this.isVisible = !this.isVisible;
      this.container.classList.toggle('collapsed', !this.isVisible);
      this.onToggle(this.isVisible);
    });

    filterBtns.forEach(b => controls.appendChild(b));
    controls.appendChild(pauseBtn);
    controls.appendChild(clearBtn);
    controls.appendChild(toggleBtn);

    header.appendChild(titleEl);
    header.appendChild(controls);
    this.container.appendChild(header);

    // Activity list (scrollable)
    this.listEl = document.createElement('div');
    this.listEl.className = 'activity-list';
    this.container.appendChild(this.listEl);

    // Empty state
    this.emptyEl = document.createElement('div');
    this.emptyEl.className = 'activity-empty';
    this.emptyEl.textContent = 'Agent is idle. Send a task to see activity here.';
    this.listEl.appendChild(this.emptyEl);

    // Status bar at bottom
    this.statusBar = document.createElement('div');
    this.statusBar.className = 'activity-status-bar';
    this.statusBar.innerHTML = '<span class="status-idle">\u{1F7E2} Idle</span>';
    this.container.appendChild(this.statusBar);
  }

  /**
   * Handle an agent event from the IPC bridge.
   */
  handleEvent(event) {
    const type = event.type;
    const config = ACTIVITY_CONFIG[type] || ACTIVITY_CONFIG.info;

    // Special handling for streaming tokens - accumulate into existing entry
    if (type === 'thinking') {
      if (!this._streamingEntry) {
        this._streamingEntry = this._addEntry({
          type: 'thinking',
          icon: config.icon,
          label: 'Thinking',
          color: config.color,
          content: '',
          collapsible: true,
          defaultCollapsed: true,
          timestamp: Date.now(),
        });
      }
      this._updateStatus('\u{1F4AD} Thinking...');
      return;
    }

    if (type === 'token') {
      if (!this._streamingEntry) {
        this._streamingEntry = this._addEntry({
          type: 'token',
          icon: ACTIVITY_CONFIG.token.icon,
          label: 'Responding',
          color: ACTIVITY_CONFIG.token.color,
          content: '',
          collapsible: false,
          defaultCollapsed: false,
          timestamp: Date.now(),
        });
      }
      this._streamingEntry.content += event.text || '';
      this._streamingEntry.rawText = (this._streamingEntry.rawText || '') + (event.text || '');
      this._updateEntryDOM(this._streamingEntry);
      this._updateStatus('\u270D\uFE0F Generating response...');
      return;
    }

    // Non-streaming event: end any active streaming
    this._streamingEntry = null;

    // Special handling for tool events - merge start + result
    if (type === 'tool_start') {
      const toolInput = event.toolInput;
      const inputStr = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput, null, 2);

      this._currentToolStart = this._addEntry({
        type: 'tool_start',
        icon: config.icon,
        label: this._formatToolName(event.toolName),
        color: config.color,
        content: inputStr,
        filePath: this._extractFilePath(toolInput),
        toolName: event.toolName,
        status: 'running',
        collapsible: true,
        defaultCollapsed: false,
        timestamp: Date.now(),
      });
      this._updateStatus('\u{1F527} ' + this._formatToolName(event.toolName));
      return;
    }

    if (type === 'tool_executing') {
      this._updateStatus('\u2699\uFE0F Executing ' + (event.toolName || 'tool') + '...');
      return;
    }

    if (type === 'tool_result') {
      if (this._currentToolStart) {
        // Merge with tool_start entry
        this._currentToolStart.status = event.success ? 'success' : 'error';
        this._currentToolStart.result = event.result;
        this._currentToolStart.color = event.success ? '#3fb950' : '#f85149';
        this._currentToolStart.icon = event.success ? '\u2705' : '\u274C';
        this._updateEntryDOM(this._currentToolStart);
        this._currentToolStart = null;
      } else {
        this._addEntry({
          type: 'tool_result',
          icon: event.success ? '\u2705' : '\u274C',
          label: 'Tool Result',
          color: event.success ? '#3fb950' : '#f85149',
          content: String(event.result || ''),
          status: event.success ? 'success' : 'error',
          collapsible: true,
          defaultCollapsed: true,
          timestamp: Date.now(),
        });
      }
      this._updateStatus(event.success ? '\u2705 Tool completed' : '\u274C Tool failed');
      return;
    }

    // File operations
    if (type === 'file_written') {
      const entry = this._addEntry({
        type: 'file_written',
        icon: config.icon,
        label: this._shortenPath(event.filePath),
        color: config.color,
        content: event.filePath,
        filePath: event.filePath,
        collapsible: false,
        defaultCollapsed: false,
        timestamp: Date.now(),
      });
      // Auto-open file in editor if it's a code file
      if (this._isCodeFile(event.filePath)) {
        this.onFileClick(event.filePath);
      }
      this._updateStatus('\u{1F4DD} ' + this._shortenPath(event.filePath));
      return;
    }

    // Plan ready
    if (type === 'plan_ready') {
      const steps = event.plan && event.plan.steps ? event.plan.steps : [];
      const stepsSummary = steps.map((s, i) => (i + 1) + '. [' + s.action + '] ' + s.target + ' \u2014 ' + s.description).join('\n');
      this._addEntry({
        type: 'plan_ready',
        icon: config.icon,
        label: 'Plan: ' + steps.length + ' steps',
        color: config.color,
        content: stepsSummary,
        collapsible: true,
        defaultCollapsed: false,
        timestamp: Date.now(),
      });
      this._updateStatus('\u{1F4CB} Plan ready (' + steps.length + ' steps)');
      return;
    }

    // Milestone events
    if (type === 'milestone_paused' || type === 'milestone_reached' ||
        type === 'milestone_completed' || type === 'milestone_skipped') {
      const milestone = event.milestone;
      const label = milestone ? milestone.name : 'Milestone';
      const statusMap = {
        milestone_paused: '\u23F8 Paused',
        milestone_reached: '\u{1F3C1} Reached',
        milestone_completed: '\u2705 Completed',
        milestone_skipped: '\u23ED Skipped',
      };
      this._addEntry({
        type: 'milestone',
        icon: '\u{1F3C1}',
        label: (statusMap[type] || type) + ': ' + label,
        color: type === 'milestone_completed' ? '#3fb950' : type === 'milestone_skipped' ? '#8b949e' : '#d29922',
        content: milestone && milestone.description ? milestone.description : '',
        collapsible: false,
        defaultCollapsed: false,
        timestamp: Date.now(),
      });
      this._updateStatus((statusMap[type] || type) + ': ' + label);
      return;
    }

    // Verification
    if (type === 'verification_start') {
      this._addEntry({
        type: 'verification',
        icon: '\u{1F50D}',
        label: 'Verifying: ' + event.command,
        color: '#58a6ff',
        content: event.command,
        collapsible: true,
        defaultCollapsed: true,
        timestamp: Date.now(),
      });
      this._updateStatus('\u{1F50D} Verifying: ' + event.command);
      return;
    }
    if (type === 'verification_result') {
      const badge = event.passed ? 'PASS' : 'FAIL';
      this._addEntry({
        type: 'verification',
        icon: event.passed ? '\u2705' : '\u274C',
        label: 'Verification: ' + badge,
        color: event.passed ? '#3fb950' : '#f85149',
        content: event.unverified ? '(unverified)' : '',
        collapsible: true,
        defaultCollapsed: true,
        timestamp: Date.now(),
      });
      this._updateStatus('Verification: ' + badge);
      return;
    }

    // Complete
    if (type === 'complete') {
      this._addEntry({
        type: 'complete',
        icon: config.icon,
        label: event.summary || 'Task complete',
        color: config.color,
        content: event.summary || '',
        collapsible: true,
        defaultCollapsed: true,
        timestamp: Date.now(),
      });
      this._updateStatus('\u{1F7E2} Idle');
      return;
    }

    // Error
    if (type === 'error') {
      this._addEntry({
        type: 'error',
        icon: config.icon,
        label: event.text || 'Error',
        color: config.color,
        content: event.text || '',
        collapsible: true,
        defaultCollapsed: false,
        timestamp: Date.now(),
      });
      this._updateStatus('\u274C Error');
      return;
    }

    // Pipeline events
    if (type && type.startsWith('pipeline_')) {
      this._addEntry({
        type: 'pipeline',
        icon: config.icon,
        label: this._formatPipelineEvent(event),
        color: config.color,
        content: JSON.stringify(event, null, 2),
        collapsible: true,
        defaultCollapsed: true,
        timestamp: Date.now(),
      });
      this._updateStatus('\u{1F680} ' + this._formatPipelineEvent(event));
      return;
    }

    // Swarm events
    if (type && type.startsWith('swarm_')) {
      this._addEntry({
        type: 'swarm',
        icon: config.icon,
        label: this._formatSwarmEvent(event),
        color: config.color,
        content: JSON.stringify(event, null, 2),
        collapsible: true,
        defaultCollapsed: true,
        timestamp: Date.now(),
      });
      this._updateStatus('\u{1F41D} ' + this._formatSwarmEvent(event));
      return;
    }

    // Generic fallback
    this._addEntry({
      type: type || 'info',
      icon: config.icon,
      label: event.text || event.type || 'Event',
      color: config.color,
      content: JSON.stringify(event, null, 2),
      collapsible: config.collapsible,
      defaultCollapsed: config.defaultCollapsed,
      timestamp: Date.now(),
    });
  }

  /**
   * Add an entry and render it.
   */
  _addEntry(entry) {
    entry.id = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    entry.isCollapsed = entry.defaultCollapsed;

    this.entries.push(entry);

    // Trim old entries
    while (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }

    // Hide empty state
    if (this.emptyEl && this.emptyEl.parentNode) {
      this.emptyEl.remove();
      this.emptyEl = null;
    }

    this._renderEntry(entry);
    this._autoScroll();
    return entry;
  }

  /**
   * Render a single entry as DOM.
   */
  _renderEntry(entry) {
    const el = document.createElement('div');
    el.className = 'activity-entry';
    el.dataset.type = entry.type;
    el.dataset.id = entry.id;
    if (entry.status) el.dataset.status = entry.status;
    if (entry.isCollapsed) el.classList.add('collapsed');

    // Header line
    const header = document.createElement('div');
    header.className = 'activity-entry-header';

    // Chevron (only for collapsible entries)
    if (entry.collapsible) {
      const chevron = document.createElement('span');
      chevron.className = 'activity-chevron';
      chevron.textContent = entry.isCollapsed ? '\u25B6' : '\u25BC';
      header.appendChild(chevron);
    }

    // Icon
    const icon = document.createElement('span');
    icon.className = 'activity-icon';
    icon.textContent = entry.icon;
    header.appendChild(icon);

    // Label
    const label = document.createElement('span');
    label.className = 'activity-label';
    label.style.color = entry.color;
    label.textContent = entry.label;
    header.appendChild(label);

    // Status badge (for tool calls)
    if (entry.status === 'running') {
      const badge = document.createElement('span');
      badge.className = 'activity-badge running';
      badge.innerHTML = '<span class="spinner"></span>';
      header.appendChild(badge);
    } else if (entry.status === 'success') {
      const badge = document.createElement('span');
      badge.className = 'activity-badge success';
      badge.textContent = '\u2713';
      header.appendChild(badge);
    } else if (entry.status === 'error') {
      const badge = document.createElement('span');
      badge.className = 'activity-badge error';
      badge.textContent = '\u2717';
      header.appendChild(badge);
    }

    // Timestamp
    const ts = document.createElement('span');
    ts.className = 'activity-timestamp';
    ts.textContent = this._formatTime(entry.timestamp);
    header.appendChild(ts);

    el.appendChild(header);

    // Body (collapsible)
    if (entry.content) {
      const body = document.createElement('div');
      body.className = 'activity-entry-body';
      if (entry.isCollapsed) body.style.display = 'none';

      // Check if content has a file path to make it clickable
      if (entry.filePath) {
        const pathEl = document.createElement('div');
        pathEl.className = 'activity-file-path';
        pathEl.textContent = entry.filePath;
        pathEl.addEventListener('click', (e) => {
          e.stopPropagation();
          this.onFileClick(entry.filePath);
        });
        body.appendChild(pathEl);
      }

      // Render content
      const contentEl = document.createElement('pre');
      contentEl.className = 'activity-content';
      const truncated = this._truncateContent(entry.content, 500);
      contentEl.textContent = truncated;
      body.appendChild(contentEl);

      el.appendChild(body);
    }

    // Click handler for collapsible entries
    if (entry.collapsible) {
      header.addEventListener('click', () => {
        entry.isCollapsed = !entry.isCollapsed;
        el.classList.toggle('collapsed', entry.isCollapsed);
        const chevron = el.querySelector('.activity-chevron');
        if (chevron) chevron.textContent = entry.isCollapsed ? '\u25B6' : '\u25BC';
        const bodyEl = el.querySelector('.activity-entry-body');
        if (bodyEl) bodyEl.style.display = entry.isCollapsed ? 'none' : '';
      });
    }

    entry._el = el;
    this.listEl.appendChild(el);
  }

  /**
   * Update an existing entry's DOM (for streaming/merging).
   */
  _updateEntryDOM(entry) {
    if (!entry._el) return;
    const el = entry._el;

    // Update icon
    const iconEl = el.querySelector('.activity-icon');
    if (iconEl) iconEl.textContent = entry.icon;

    // Update label color
    const labelEl = el.querySelector('.activity-label');
    if (labelEl) labelEl.style.color = entry.color;

    // Update status badge
    const existingBadge = el.querySelector('.activity-badge');
    if (existingBadge) existingBadge.remove();
    if (entry.status === 'success' || entry.status === 'error') {
      const badge = document.createElement('span');
      badge.className = 'activity-badge ' + entry.status;
      badge.textContent = entry.status === 'success' ? '\u2713' : '\u2717';
      const headerEl = el.querySelector('.activity-entry-header');
      if (headerEl) headerEl.appendChild(badge);
    }
    if (entry.status === 'running') {
      const existingSpinner = el.querySelector('.activity-badge.running');
      if (!existingSpinner) {
        const badge = document.createElement('span');
        badge.className = 'activity-badge running';
        badge.innerHTML = '<span class="spinner"></span>';
        const headerEl = el.querySelector('.activity-entry-header');
        if (headerEl) headerEl.appendChild(badge);
      }
    }

    // Update content
    let bodyEl = el.querySelector('.activity-entry-body');
    if (entry.content || entry.result) {
      if (!bodyEl) {
        bodyEl = document.createElement('div');
        bodyEl.className = 'activity-entry-body';
        el.appendChild(bodyEl);
      }

      // Clear and re-render
      bodyEl.innerHTML = '';

      if (entry.filePath) {
        const pathEl = document.createElement('div');
        pathEl.className = 'activity-file-path';
        pathEl.textContent = entry.filePath;
        pathEl.addEventListener('click', (e) => {
          e.stopPropagation();
          this.onFileClick(entry.filePath);
        });
        bodyEl.appendChild(pathEl);
      }

      if (entry.content) {
        const contentEl = document.createElement('pre');
        contentEl.className = 'activity-content';
        contentEl.textContent = this._truncateContent(entry.content, 500);
        bodyEl.appendChild(contentEl);
      }

      if (entry.result) {
        const resultEl = document.createElement('pre');
        resultEl.className = 'activity-content activity-result';
        resultEl.textContent = this._truncateContent(String(entry.result), 500);
        bodyEl.appendChild(resultEl);
      }
    }

    // Auto-scroll
    this._autoScroll();
  }

  /**
   * Full re-render (used when filter changes).
   */
  _render() {
    this.listEl.innerHTML = '';
    const filtered = this._getFilteredEntries();
    if (filtered.length === 0) {
      this.emptyEl = document.createElement('div');
      this.emptyEl.className = 'activity-empty';
      this.emptyEl.textContent = this.entries.length === 0
        ? 'Agent is idle. Send a task to see activity here.'
        : 'No matching entries for current filter.';
      this.listEl.appendChild(this.emptyEl);
      return;
    }
    for (const entry of filtered) {
      this._renderEntry(entry);
    }
    this._autoScroll();
  }

  /**
   * Get entries filtered by current level.
   */
  _getFilteredEntries() {
    if (this.filterLevel === 'all') return this.entries;
    if (this.filterLevel === 'important') {
      return this.entries.filter(e =>
        ['tool_start', 'tool_result', 'file_written', 'complete', 'error', 'plan_ready', 'milestone', 'pipeline', 'swarm'].includes(e.type)
      );
    }
    if (this.filterLevel === 'files') {
      return this.entries.filter(e =>
        ['file_written', 'file_read'].includes(e.type) || e.filePath
      );
    }
    return this.entries;
  }

  /**
   * Update the status bar.
   */
  _updateStatus(text) {
    if (!this.statusBar) return;
    const isIdle = text.includes('Idle');
    this.statusBar.innerHTML = isIdle
      ? '<span class="status-idle">\u{1F7E2} ' + text.replace('\u{1F7E2} ', '') + '</span>'
      : '<span class="status-active">' + text + '</span>';
  }

  /**
   * Auto-scroll to bottom if not paused.
   */
  _autoScroll() {
    if (!this.isPaused) {
      this.listEl.scrollTop = this.listEl.scrollHeight;
    }
  }

  // ----- Formatters -----

  _formatToolName(name) {
    if (!name) return 'Tool';
    return name
      .replace(/_/g, ' ')
      .replace(/([A-Z])/g, ' $1')
      .replace(/^\s+/, '')
      .split(' ')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');
  }

  _formatPipelineEvent(event) {
    const labels = {
      pipeline_refinement_started: 'Refinement started',
      pipeline_refinement_round: 'Round ' + (event.round || '?'),
      pipeline_spec_updated: 'Spec updated (v' + (event.spec && event.spec.version ? event.spec.version : '?') + ')',
      pipeline_spec_approved: 'Spec approved',
      pipeline_plan_ready: 'Plan ready',
      pipeline_preflight_configured: 'Pre-flight configured',
      pipeline_execution_started: 'Execution started',
      pipeline_v2_refinement: 'v2 Refinement available',
      pipeline_completed: 'Pipeline completed',
      pipeline_error: 'Pipeline error',
    };
    return labels[event.type] || event.type || 'Pipeline event';
  }

  _formatSwarmEvent(event) {
    const labels = {
      swarm_partition_ready: 'Swarm partition ready',
      swarm_worker_started: 'Worker ' + (event.agentId || '?') + ' started',
      swarm_worker_progress: 'Worker ' + (event.agentId || '?') + ' progress',
      swarm_worker_completed: 'Worker ' + (event.agentId || '?') + ' done',
      swarm_worker_error: 'Worker ' + (event.agentId || '?') + ' error',
      swarm_completed: 'Swarm completed',
      swarm_error: 'Swarm error',
    };
    return labels[event.type] || event.type || 'Swarm event';
  }

  _shortenPath(filePath) {
    if (!filePath) return '';
    const parts = filePath.replace(/\\/g, '/').split('/');
    return parts.length > 3 ? '.../' + parts.slice(-3).join('/') : filePath;
  }

  _extractFilePath(toolInput) {
    if (!toolInput) return null;
    if (typeof toolInput === 'string') {
      const match = toolInput.match(/(?:\/[\w.-]+)+\.\w+/);
      return match ? match[0] : null;
    }
    return toolInput.filePath || toolInput.path || toolInput.targetPath ||
           toolInput.destinationPath || toolInput.dirPath || null;
  }

  _isCodeFile(filePath) {
    if (!filePath) return false;
    const ext = filePath.split('.').pop().toLowerCase();
    const codeExts = ['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h',
                      'css', 'scss', 'html', 'htm', 'json', 'yaml', 'yml', 'toml', 'md'];
    return codeExts.includes(ext);
  }

  _truncateContent(content, maxLen) {
    if (!content) return '';
    if (content.length <= maxLen) return content;
    return content.slice(0, maxLen) + '\n... (truncated)';
  }

  _formatTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
}

// Export for use by layout
window.AgentActivityPanel = AgentActivityPanel;
