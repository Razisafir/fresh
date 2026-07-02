/**
 * chat.js — Vanilla JS client for the Kovix chat UI.
 *
 * Runs in the renderer process. Acquires the API from window.__kovix_api
 * (set by preload.ts via contextBridge).
 *
 * State machine: idle → planning → awaiting_approval → executing → complete
 */

// ---------------------------------------------------------------------------
// API handle
// ---------------------------------------------------------------------------

const api = window.__kovix_api;

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const messageList = document.getElementById('message-list');
const inputBox = document.getElementById('input-box');
const btnSend = document.getElementById('btn-send');
const btnFolder = document.getElementById('btn-folder');
const modelSelect = document.getElementById('model-select');
const btnSettings = document.getElementById('btn-settings');
const settingsModal = document.getElementById('settings-modal');
const settingsAnthropicKey = document.getElementById('settings-anthropic-key');
const btnSaveAnthropicKey = document.getElementById('btn-save-anthropic-key');
const settingsNvidiaKey = document.getElementById('settings-nvidia-key');
const btnSaveNvidiaKey = document.getElementById('btn-save-nvidia-key');
const settingsOpenRouterKey = document.getElementById('settings-openrouter-key');
const btnSaveOpenRouterKey = document.getElementById('btn-save-openrouter-key');
const btnCloseSettings = document.getElementById('btn-close-settings');
const providerSelect = document.getElementById('provider-select');
const apiKeyProvider = document.getElementById('api-key-provider');
const pendingBar = document.getElementById('pending-bar');
const pendingCount = document.getElementById('pending-count');
const btnAcceptAll = document.getElementById('btn-accept-all');
const btnRejectAll = document.getElementById('btn-reject-all');
const welcomeMsg = document.getElementById('welcome-message');
const apiKeyModal = document.getElementById('api-key-modal');
const apiKeyInput = document.getElementById('api-key-input');
const btnSaveKey = document.getElementById('btn-save-key');
const btnCancelKey = document.getElementById('btn-cancel-key');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let state = 'idle'; // idle | planning | awaiting_approval | executing | swarm_executing | complete
let currentMode = 'chat'; // 'chat' | 'plan' | 'swarm'
let _currentPlan = null;
let streamingMessage = null;
let activeProvider = 'anthropic'; // 'anthropic' | 'nvidia-nim' | 'openrouter'

// ---- Swarm state ----
let _swarmWorkers = {};      // { agentId: { name, status, steps, filesModified, summary } }
let _swarmPartition = null;   // IPartitionResult from orchestrator
let _swarmWorkerCards = {};   // { agentId: DOM element }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addMessage(role, content, extra) {
  if (welcomeMsg) welcomeMsg.remove();

  const div = document.createElement('div');
  div.className = `message message-${role}`;

  if (extra) {
    if (extra.className) div.classList.add(extra.className);
    if (extra.streaming) div.classList.add('streaming');
  }

  // Support collapsible sections (thought process, task completion, etc.)
  if (extra && extra.collapsible) {
    div.classList.add('collapsible-message');
    if (extra.defaultCollapsed) div.classList.add('collapsed');

    const header = document.createElement('div');
    header.className = 'collapsible-header';
    const titleText = extra.collapsibleTitle || content.slice(0, 100);
    header.innerHTML = `<span class="collapsible-chevron">${extra.defaultCollapsed ? '\u25B6' : '\u25BC'}</span> <span class="collapsible-title">${escapeHtml(titleText)}</span>`;
    header.addEventListener('click', () => {
      div.classList.toggle('collapsed');
      const chevron = header.querySelector('.collapsible-chevron');
      if (chevron) chevron.textContent = div.classList.contains('collapsed') ? '\u25B6' : '\u25BC';
    });
    div.appendChild(header);

    const body = document.createElement('div');
    body.className = 'collapsible-body';
    body.innerHTML = renderMarkdown(content);
    div.appendChild(body);
  } else {
    div.innerHTML = renderMarkdown(content);
  }

  messageList.appendChild(div);
  messageList.scrollTop = messageList.scrollHeight;
  return div;
}

function renderMarkdown(text) {
  if (!text) return '';
  let html = text
    // Code blocks (```...```)
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    // Inline code
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Bold
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    // Italic (single * that are not inside **)
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>')
    // Headers
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h2>$1</h2>')
    // Lists (simple: - item or * item)
    .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
    // Numbered lists
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
    // Links
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    // Paragraphs (double newline)
    .replace(/\n\n/g, '</p><p>')
    // Single newlines within paragraphs
    .replace(/\n/g, '<br>');
  // Wrap loose <li> in <ul>
  html = html.replace(/(<li>.*?<\/li>)+/gs, '<ul>$&</ul>');
  // Sanitize with DOMPurify if available
  if (typeof DOMPurify !== 'undefined') {
    html = DOMPurify.sanitize(html, {
      ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'pre', 'code', 'a'],
      ALLOWED_ATTR: ['href', 'target', 'rel'],
    });
  }
  return '<p>' + html + '</p>';
}

function addToolCallCard(toolName, toolInput, success, result) {
  if (welcomeMsg) welcomeMsg.remove();

  const div = document.createElement('div');
  div.className = `tool-call ${success ? 'success' : 'error'}`;

  const header = document.createElement('div');
  header.className = 'tool-call-header';
  header.innerHTML = `<span class="tool-call-chevron">▼</span><span class="tool-call-name">${escapeHtml(toolName)}</span>`;

  const body = document.createElement('div');
  body.className = 'tool-call-body';

  if (toolInput) body.textContent += `Input: ${typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput, null, 2)}\n`;
  if (result) body.textContent += `Result: ${result}\n`;

  div.appendChild(header);
  div.appendChild(body);

  header.addEventListener('click', () => {
    div.classList.toggle('collapsed');
  });

  messageList.appendChild(div);
  messageList.scrollTop = messageList.scrollHeight;
  return div;
}

function addPlanCard(plan) {
  if (welcomeMsg) welcomeMsg.remove();

  const div = document.createElement('div');
  div.className = 'plan-card';

  const stepsHtml = plan.steps.map(s => `<li>[${s.action}] ${escapeHtml(s.target)} — ${escapeHtml(s.description)}</li>`).join('');

  div.innerHTML = `
    <h3>Plan: ${plan.steps.length} steps</h3>
    <ol class="plan-steps">${stepsHtml}</ol>
    <div class="plan-actions">
      <select id="autonomy-select">
        <option value="every_milestone">Every milestone</option>
        <option value="major_milestone" selected>Major milestone</option>
        <option value="selective">Selective</option>
        <option value="full_auto">Full auto</option>
      </select>
      <button class="btn-primary" id="btn-approve-plan">Approve & Run</button>
      <button class="btn-secondary" id="btn-cancel-plan">Cancel</button>
    </div>
  `;

  messageList.appendChild(div);
  messageList.scrollTop = messageList.scrollHeight;

  document.getElementById('btn-approve-plan').addEventListener('click', () => approvePlan(plan));
  document.getElementById('btn-cancel-plan').addEventListener('click', () => cancelPlan());
}

function addMilestoneBanner(milestone) {
  const div = document.createElement('div');
  div.className = 'milestone-banner';
  div.innerHTML = `
    <h4>⏸ Paused at milestone</h4>
    <p>${escapeHtml(milestone.name)}: ${escapeHtml(milestone.description)}</p>
    <div class="milestone-actions">
      <button class="btn-primary btn-resume">Resume</button>
      <button class="btn-secondary btn-skip">Skip</button>
    </div>
  `;

  div.querySelector('.btn-resume').addEventListener('click', () => {
    api.resumeMilestone();
    div.remove();
  });

  div.querySelector('.btn-skip').addEventListener('click', () => {
    api.skipMilestone();
    div.remove();
  });

  messageList.appendChild(div);
  messageList.scrollTop = messageList.scrollHeight;
}

function addCommandConfirm(command) {
  const div = document.createElement('div');
  div.className = 'command-confirm';
  div.innerHTML = `
    <p>Approve command execution?</p>
    <code>${escapeHtml(command)}</code>
    <p style="font-size:12px; color:var(--text-secondary)">This command can execute arbitrary code. Review carefully.</p>
    <div class="confirm-actions">
      <button class="btn-primary btn-approve-cmd">Run once</button>
      <button class="btn-secondary btn-reject-cmd">Cancel</button>
    </div>
  `;

  div.querySelector('.btn-approve-cmd').addEventListener('click', () => {
    api.respondToConfirmation(command, true);
    div.remove();
  });

  div.querySelector('.btn-reject-cmd').addEventListener('click', () => {
    api.respondToConfirmation(command, false);
    div.remove();
  });

  messageList.appendChild(div);
  messageList.scrollTop = messageList.scrollHeight;
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---- Swarm UI helpers ----

function addSwarmPartitionCard(partition) {
  if (welcomeMsg) welcomeMsg.remove();
  _swarmPartition = partition;
  _swarmWorkers = {};

  const div = document.createElement('div');
  div.className = 'swarm-partition-card';
  div.id = 'swarm-partition-card';

  const subPlansHtml = partition.subPlans.map((sp, i) => {
    _swarmWorkers[sp.agentId] = { name: sp.agentName, status: 'pending', steps: 0, filesModified: [], summary: '' };
    const filesHtml = sp.filesTouched.map(f => `<span class="swarm-file-tag">${escapeHtml(f.split('/').pop())}</span>`).join('');
    const stepsHtml = sp.steps.map(s => `<li>[${escapeHtml(s.action)}] ${escapeHtml(s.target)}</li>`).join('');
    return `
      <div class="swarm-worker-preview" data-agent-id="${escapeHtml(sp.agentId)}">
        <div class="swarm-worker-header">
          <span class="swarm-worker-badge">${i + 1}</span>
          <span class="swarm-worker-name">${escapeHtml(sp.agentName)}</span>
        </div>
        <p class="swarm-worker-desc">${escapeHtml(sp.description)}</p>
        <div class="swarm-file-tags">${filesHtml}</div>
        <ol class="swarm-worker-steps">${stepsHtml}</ol>
      </div>
    `;
  }).join('');

  div.innerHTML = `
    <div class="swarm-partition-header">
      <span class="swarm-icon">&#9881;</span>
      <h3>Swarm Partition: ${partition.subPlans.length} workers</h3>
    </div>
    <p class="swarm-reasoning">${escapeHtml(partition.reasoning)}</p>
    <div class="swarm-workers-grid">${subPlansHtml}</div>
    <div class="swarm-partition-actions">
      <button class="btn-primary" id="btn-approve-swarm">Deploy Swarm</button>
      <button class="btn-secondary" id="btn-reject-swarm">Cancel</button>
    </div>
  `;

  messageList.appendChild(div);
  messageList.scrollTop = messageList.scrollHeight;

  document.getElementById('btn-approve-swarm').addEventListener('click', () => approveSwarmPartition());
  document.getElementById('btn-reject-swarm').addEventListener('click', () => rejectSwarmPartition());
}

function addSwarmWorkerPanel() {
  // Remove partition card, replace with live worker status panel
  const partitionCard = document.getElementById('swarm-partition-card');
  if (partitionCard) partitionCard.remove();

  const panel = document.createElement('div');
  panel.className = 'swarm-status-panel';
  panel.id = 'swarm-status-panel';

  const workersHtml = Object.entries(_swarmWorkers).map(([agentId, w]) => {
    return `
      <div class="swarm-worker-card" id="swarm-worker-${escapeHtml(agentId)}">
        <div class="swarm-worker-top">
          <span class="swarm-worker-status-dot pending"></span>
          <span class="swarm-worker-card-name">${escapeHtml(w.name)}</span>
          <span class="swarm-worker-status-text">Waiting...</span>
        </div>
        <div class="swarm-worker-progress">
          <div class="swarm-progress-bar"><div class="swarm-progress-fill" style="width:0%"></div></div>
        </div>
        <div class="swarm-worker-details">
          <span class="swarm-worker-step-count">0 steps</span>
          <span class="swarm-worker-file-count">0 files</span>
        </div>
        <div class="swarm-worker-log"></div>
      </div>
    `;
  }).join('');

  panel.innerHTML = `
    <div class="swarm-panel-header">
      <span class="swarm-icon">&#9881;</span>
      <h3>Swarm Running</h3>
      <span class="swarm-worker-count">${Object.keys(_swarmWorkers).length} workers</span>
    </div>
    <div class="swarm-workers-list">${workersHtml}</div>
  `;

  messageList.appendChild(panel);
  messageList.scrollTop = messageList.scrollHeight;

  // Store references to worker cards for fast updates
  _swarmWorkerCards = {};
  for (const agentId of Object.keys(_swarmWorkers)) {
    _swarmWorkerCards[agentId] = document.getElementById(`swarm-worker-${agentId}`);
  }
}

function updateSwarmWorkerCard(agentId, updates) {
  const card = _swarmWorkerCards[agentId];
  if (!card) return;

  const worker = _swarmWorkers[agentId];
  if (!worker) return;

  Object.assign(worker, updates);

  const dot = card.querySelector('.swarm-worker-status-dot');
  const statusText = card.querySelector('.swarm-worker-status-text');
  const stepCount = card.querySelector('.swarm-worker-step-count');
  const fileCount = card.querySelector('.swarm-worker-file-count');
  const progressFill = card.querySelector('.swarm-progress-fill');
  const logEl = card.querySelector('.swarm-worker-log');

  if (updates.status) {
    dot.className = `swarm-worker-status-dot ${updates.status}`;
    const statusLabels = { pending: 'Waiting...', running: 'Working...', completed: 'Done', failed: 'Failed' };
    statusText.textContent = statusLabels[updates.status] || updates.status;
  }

  if (updates.steps !== undefined) {
    stepCount.textContent = `${updates.steps} step${updates.steps !== 1 ? 's' : ''}`;
    // Estimate progress (rough: assume ~5 steps per worker max)
    const pct = Math.min(100, Math.round((updates.steps / 5) * 100));
    progressFill.style.width = pct + '%';
  }

  if (updates.filesModified) {
    fileCount.textContent = `${updates.filesModified.length} file${updates.filesModified.length !== 1 ? 's' : ''}`;
  }

  // Add log entries for key events
  if (updates.logEntry) {
    const logLine = document.createElement('div');
    logLine.className = 'swarm-log-line';
    logLine.textContent = updates.logEntry;
    logEl.appendChild(logLine);
    logEl.scrollTop = logEl.scrollHeight;
  }
}

function addSwarmCompletedCard(summary, workerResults) {
  const panel = document.getElementById('swarm-status-panel');
  if (panel) panel.remove();

  const div = document.createElement('div');
  div.className = 'swarm-completed-card';

  const succeeded = workerResults.filter(r => r.success).length;
  const _failed = workerResults.filter(r => !r.success).length;

  const resultsHtml = workerResults.map(r => {
    const statusClass = r.success ? 'success' : 'error';
    const statusIcon = r.success ? '&#10003;' : '&#10007;';
    const filesText = r.filesModified && r.filesModified.length > 0
      ? `<span class="swarm-result-files">${r.filesModified.length} file${r.filesModified.length !== 1 ? 's' : ''}</span>`
      : '';
    return `
      <div class="swarm-result-row ${statusClass}">
        <span class="swarm-result-icon">${statusIcon}</span>
        <span class="swarm-result-name">${escapeHtml(r.agentName)}</span>
        ${filesText}
        <span class="swarm-result-summary">${escapeHtml(r.summary.slice(0, 150))}</span>
      </div>
    `;
  }).join('');

  div.innerHTML = `
    <div class="swarm-partition-header">
      <span class="swarm-icon">&#9881;</span>
      <h3>Swarm Complete: ${succeeded}/${workerResults.length} succeeded</h3>
    </div>
    <div class="swarm-results-list">${resultsHtml}</div>
  `;

  messageList.appendChild(div);
  messageList.scrollTop = messageList.scrollHeight;
}

async function approveSwarmPartition() {
  if (!_currentPlan) return;
  const partitionCard = document.getElementById('swarm-partition-card');
  if (partitionCard) partitionCard.remove();

  addMessage('system', 'Swarm partition approved. Deploying workers...');
  setState('swarm_executing');

  // Show live worker panel
  addSwarmWorkerPanel();

  // Call swarm:approvePartition then swarm:execute
  await api.swarmApprovePartition();
  const result = await api.swarmExecute(_currentPlan);
  if (result.error) {
    addMessage('system', `Swarm error: ${result.error}`);
    setState('idle');
  }
}

function rejectSwarmPartition() {
  const partitionCard = document.getElementById('swarm-partition-card');
  if (partitionCard) partitionCard.remove();
  _swarmPartition = null;
  _swarmWorkers = {};
  addMessage('system', 'Swarm partition rejected.');
  setState('idle');
  api.swarmRejectPartition();
}

function updateCreditBar() {
  api.getCreditsStatus().then(status => {
    if (!status) return;
    const bar = document.getElementById('credit-bar');
    const fill = document.getElementById('credit-fill');
    const text = document.getElementById('credit-text');
    if (!bar || !fill || !text) return;

    if (!status.enabled) {
      bar.classList.add('hidden');
      return;
    }

    bar.classList.remove('hidden');
    const pct = Math.round((status.remaining / status.total) * 100);
    fill.style.width = pct + '%';
    text.textContent = `${status.remaining}/${status.total} credits`;

    // Color based on remaining
    if (pct < 10) {
      fill.style.background = 'var(--error)';
      bar.classList.add('emergency');
    } else if (pct < 20) {
      fill.style.background = 'var(--warning)';
      bar.classList.remove('emergency');
    } else {
      fill.style.background = 'var(--accent)';
      bar.classList.remove('emergency');
    }
  }).catch(() => {});
}

function setState(newState) {
  state = newState;
  btnSend.disabled = (state === 'planning' || state === 'executing' || state === 'swarm_executing');
}

function updatePlaceholder() {
  if (inputBox) {
    if (currentMode === 'chat') inputBox.placeholder = 'Ask anything...';
    else if (currentMode === 'plan') inputBox.placeholder = 'Describe a task...';
    else if (currentMode === 'refine') inputBox.placeholder = 'Describe your idea... (Refine mode builds a spec)';
    else if (currentMode === 'swarm') inputBox.placeholder = 'Describe a multi-part task for parallel agents...';
  }
}

function showPendingBar(count) {
  if (count > 0) {
    pendingBar.classList.remove('hidden');
    pendingCount.textContent = `${count} pending change${count !== 1 ? 's' : ''}`;
  } else {
    pendingBar.classList.add('hidden');
  }
}

// ---------------------------------------------------------------------------
// Agent event handling
// ---------------------------------------------------------------------------

api.onAgentEvent(async (event) => {
  switch (event.type) {
    case 'thinking':
      if (!streamingMessage) {
        streamingMessage = addMessage('agent', '', { streaming: true });
      }
      break;
    case 'token':
      if (!streamingMessage) {
        streamingMessage = addMessage('agent', '', { streaming: true });
      }
      // Accumulate raw text, then render markdown from full accumulated text
      if (!streamingMessage._rawText) streamingMessage._rawText = '';
      streamingMessage._rawText += event.text;
      streamingMessage.innerHTML = renderMarkdown(streamingMessage._rawText);
      messageList.scrollTop = messageList.scrollHeight;
      break;
    case 'tool_start':
      streamingMessage = null;
      addToolCallCard(event.toolName, event.toolInput, true, null);
      break;
    case 'tool_executing':
      break;
    case 'tool_result':
      addToolCallCard(event.toolName, null, event.success, event.result);
      break;
    case 'file_written':
      addMessage('system', `📝 File staged: ${event.filePath} (review in Pending Changes)`);
      break;
    case 'plan_ready': {
      // Guard against duplicate plan_ready events (the IPC handler sends
      // plan_ready once, but defensive coding prevents double-rendering).
      if (_currentPlan) {
        const existingCard = document.querySelector('.plan-card');
        if (existingCard) break;
      }
      _currentPlan = event.plan;

      if (currentMode === 'swarm') {
        // Swarm mode: auto-trigger swarm execution instead of showing plan card
        addMessage('system', `Plan ready with ${event.plan.steps.length} steps. Launching swarm...`);
        setState('executing');

        // Build approved plan for swarm
        const approvedPlan = {
          task: event.plan.summary || 'Swarm task',
          steps: event.plan.steps.map((s, i) => ({ ...s, selected: true, index: i })),
          executionMode: 'full_auto',
          milestones: [],
          approved: true,
          approvedAt: Date.now(),
        };
        _currentPlan = approvedPlan;

        const result = await api.swarmExecute(approvedPlan);
        if (result.error) {
          addMessage('system', `Swarm error: ${result.error}`);
          setState('idle');
        }
      } else {
        // Normal plan mode: show plan card for approval
        addPlanCard(event.plan);
        setState('awaiting_approval');
      }
      break;
    }
    case 'milestone_paused':
      addMilestoneBanner(event.milestone);
      break;
    case 'milestone_reached':
      addMessage('system', `🏁 Milestone reached: ${event.milestone.name}`);
      break;
    case 'milestone_skipped':
      addMessage('system', `⏭ Milestone skipped: ${event.milestone.name}`);
      break;
    case 'milestone_completed':
      addMessage('system', `✅ Milestone completed: ${event.milestone.name}`);
      break;
    case 'verification_start':
      addMessage('system', `🔍 Verifying: ${event.command}`);
      break;
    case 'verification_result': {
      const badge = event.passed ? 'PASS' : 'FAIL';
      const unverified = event.unverified ? ' (unverified)' : '';
      addMessage('system', `\u{1F50D} Verification: ${badge}${unverified}`, {
        collapsible: true,
        collapsibleTitle: `\u{1F50D} Verification: ${badge}${unverified}`,
        defaultCollapsed: true,
      });
      break;
    }
    case 'complete':
      streamingMessage = null;
      addMessage('system', event.summary || 'Task complete', {
        collapsible: true,
        collapsibleTitle: '\u2705 Task complete: ' + (event.summary ? event.summary.slice(0, 60) : ''),
        defaultCollapsed: true,
      });
      setState('idle');
      break;
    case 'error':
      streamingMessage = null;
      addMessage('system', `❌ Error: ${event.text}`);
      setState('idle');
      break;
  }
});

api.onPendingChanged((entries) => {
  showPendingBar(Array.isArray(entries) ? entries.length : 0);
});

api.onPromptConfirmCommand((command) => {
  addCommandConfirm(command);
});

api.onSwarmEvent((event) => {
  switch (event.type) {
    case 'swarm_partition_ready': {
      addSwarmPartitionCard(event.partition);
      setState('awaiting_approval');
      break;
    }
    case 'swarm_worker_started': {
      updateSwarmWorkerCard(event.agentId, { status: 'running', logEntry: 'Worker started' });
      updateCreditBar();
      break;
    }
    case 'swarm_worker_progress': {
      // Forward select agent events to the worker card
      const agentEvent = event.event;
      if (!agentEvent) break;
      const worker = _swarmWorkers[event.agentId];
      if (!worker) break;

      if (agentEvent.type === 'tool_result') {
        const newSteps = (worker.steps || 0) + 1;
        const newFiles = worker.filesModified ? [...worker.filesModified] : [];
        if (agentEvent.toolName === 'write_file' || agentEvent.toolName === 'edit_file') {
          // Track file from tool result
        }
        updateSwarmWorkerCard(event.agentId, {
          steps: newSteps,
          filesModified: newFiles,
          logEntry: `${agentEvent.toolName}: ${agentEvent.success ? 'OK' : 'FAIL'}`,
        });
      } else if (agentEvent.type === 'file_written') {
        const newFiles = worker.filesModified ? [...worker.filesModified] : [];
        if (!newFiles.includes(agentEvent.filePath)) newFiles.push(agentEvent.filePath);
        updateSwarmWorkerCard(event.agentId, {
          filesModified: newFiles,
          logEntry: `Staged: ${agentEvent.filePath.split('/').pop()}`,
        });
      }
      updateCreditBar();
      break;
    }
    case 'swarm_worker_completed': {
      updateSwarmWorkerCard(event.agentId, {
        status: event.success ? 'completed' : 'failed',
        logEntry: event.success ? 'Completed successfully' : `Failed: ${event.summary.slice(0, 80)}`,
      });
      updateCreditBar();
      break;
    }
    case 'swarm_worker_failed': {
      updateSwarmWorkerCard(event.agentId, {
        status: 'failed',
        logEntry: `Error: ${event.error.slice(0, 80)}`,
      });
      break;
    }
    case 'swarm_completed': {
      addSwarmCompletedCard(event.summary, event.workerResults);
      addMessage('system', `Swarm finished: ${event.summary.split('\n')[0]}`);
      _swarmWorkers = {};
      _swarmPartition = null;
      _swarmWorkerCards = {};
      setState('idle');
      updateCreditBar();
      break;
    }
    case 'swarm_error': {
      addMessage('system', `Swarm error: ${event.error}`);
      // If we were in swarm mode, clean up
      const panel = document.getElementById('swarm-status-panel');
      if (panel) panel.remove();
      _swarmWorkers = {};
      _swarmPartition = null;
      _swarmWorkerCards = {};
      setState('idle');
      break;
    }
  }
});

// ---------------------------------------------------------------------------
// Pipeline event handling (Idea-to-Execution)
// ---------------------------------------------------------------------------

api.onPipelineEvent((event) => {
  switch (event.type) {
    case 'refinement_started':
      addMessage('system', '🔍 Refinement started...');
      break;
    case 'refinement_round':
      addMessage('system', `Round ${event.round}: ${event.question.slice(0, 100)}...`);
      break;
    case 'spec_updated':
      if (event.spec) {
        updateSpecCard(event.spec);
        if (!_pipelineComplete) {
          addMessage('system', `📝 Spec updated: ${event.spec.name} v${event.spec.version} (${event.spec.requirements.length} requirements)`);
        }
      }
      break;
    case 'spec_approved':
      addMessage('system', `✅ Spec approved: ${event.spec.name}`);
      break;
    case 'plan_ready':
      addMessage('system', `📋 Plan ready: ${event.milestoneCount} milestones, ${event.totalSteps} steps, ~${event.estimatedCredits} credits`);
      break;
    case 'preflight_configured':
      addMessage('system', '⚙️ Pre-flight configured. Ready to execute.');
      break;
    case 'execution_started':
      _pipelineComplete = false;
      showPipelineProgress(0, event.totalMilestones, 'Execution starting...');
      addMessage('system', `🚀 Execution started: ${event.totalMilestones} milestones`);
      break;
    case 'milestone_progress':
      showPipelineProgress(event.completedMilestones, event.totalMilestones, event.currentMilestone);
      break;
    case 'swarm_started':
      addMessage('system', `🐝 Swarm deployed: ${event.workerCount} workers`);
      break;
    case 'swarm_worker_update':
      // Could update a swarm panel here — for now just log
      break;
    case 'execution_complete':
      _pipelineComplete = true;
      _hidePipelineProgress();
      if (event.spec) {
        updateSpecCard(event.spec);
      }
      _showCompletionCard(event.spec, event.allRequirementsMet);
      addMessage('system', event.allRequirementsMet
        ? '✅ All requirements satisfied!'
        : '⚠️ Partial completion — some requirements not met.');
      setState('idle');
      break;
    case 'v2_prompt':
      // The v2 prompt is already shown via the completion card's "Run it again" button
      addMessage('system', `🔄 v2 refinement available: ${event.unsatisfiedRequirements?.length || 0} unsatisfied requirements`);
      break;
    case 'pipeline_error':
      addMessage('system', `❌ Pipeline error: ${event.error}${event.recoverable ? ' (recoverable)' : ''}`);
      if (!event.recoverable) {
        _hidePipelineProgress();
        setState('idle');
      }
      break;
  }
});

// ---------------------------------------------------------------------------
// User actions
// ---------------------------------------------------------------------------

async function sendTask() {
  const text = inputBox.value.trim();
  if (!text) return;

  addMessage('user', text);
  inputBox.value = '';
  inputBox.style.height = 'auto';
  streamingMessage = null;

  if (currentMode === 'chat') {
    // Chat mode: send directly to AI, no plan/approve gate
    setState('executing');
    const result = await api.chat(text);
    if (result.error) {
      addMessage('system', `❌ ${result.error}`);
      setState('idle');
    }
  } else if (currentMode === 'refine') {
    // Refine mode: send to pipeline refinement
    setState('executing');
    _refinementActive = true;
    addMessage('system', '🔍 Refining your idea into a structured spec...');
    try {
      if (_currentSpec && _refinementActive) {
        // Continue refinement conversation
        const result = await api.pipelineContinueRefinement(text);
        if (result.error) {
          addMessage('system', `❌ ${result.error}`);
          setState('idle');
        } else if (result.spec) {
          updateSpecCard(result.spec);
          addMessage('agent', result.response);
        }
      } else {
        // Start new refinement
        const result = await api.pipelineStartRefinement(text);
        if (result.error) {
          addMessage('system', `❌ ${result.error}`);
          setState('idle');
        } else if (result.spec) {
          updateSpecCard(result.spec);
          addMessage('agent', result.response);
        }
      }
    } catch (err) {
      addMessage('system', `❌ Pipeline error: ${err.message || err}`);
      setState('idle');
    }
    setState('idle');
  } else if (currentMode === 'swarm') {
    // Swarm mode: plan first, then auto-offer swarm partition
    setState('planning');
    addMessage('system', 'Planning task for swarm execution...');
    const result = await api.sendTask(text);
    if (result.error) {
      addMessage('system', `❌ ${result.error}`);
      setState('idle');
    }
    // If plan was created successfully, the plan_ready event will fire.
    // We handle it in the agent event handler — for swarm mode, we
    // auto-trigger the swarm flow instead of showing a normal plan card.
  } else {
    // Plan mode: existing behavior
    setState('planning');
    const result = await api.sendTask(text);
    if (result.error) {
      addMessage('system', `❌ ${result.error}`);
      setState('idle');
    }
  }
}

async function approvePlan(plan) {
  if (!plan) return;
  const autonomy = document.getElementById('autonomy-select')?.value || 'major_milestone';
  const milestones = []; // milestones come from the plan if available

  const approvedPlan = {
    task: plan.summary || 'User task',
    steps: plan.steps.map((s, i) => ({ ...s, selected: true, index: i })),
    executionMode: autonomy,
    milestones: milestones,
    approved: true,
    approvedAt: Date.now(),
  };

  // Remove the plan card
  const planCard = document.querySelector('.plan-card');
  if (planCard) planCard.remove();

  addMessage('system', `▶ Plan approved (${autonomy}). Starting execution…`);
  setState('executing');
  streamingMessage = null;

  const result = await api.approvePlan(approvedPlan);
  if (result.error) {
    addMessage('system', `❌ Execution error: ${result.error}`);
    setState('idle');
  } else {
    setState('idle');
  }
}

function cancelPlan() {
  const planCard = document.querySelector('.plan-card');
  if (planCard) planCard.remove();
  addMessage('system', 'Plan cancelled.');
  setState('idle');
  api.cancelPlan();
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

btnSend.addEventListener('click', sendTask);

inputBox.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendTask();
  }
});

// Mode toggle buttons
document.getElementById('btn-mode-chat').addEventListener('click', () => {
  currentMode = 'chat';
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('btn-mode-chat').classList.add('active');
  updatePlaceholder();
});

document.getElementById('btn-mode-plan').addEventListener('click', () => {
  currentMode = 'plan';
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('btn-mode-plan').classList.add('active');
  updatePlaceholder();
});

document.getElementById('btn-mode-swarm').addEventListener('click', () => {
  currentMode = 'swarm';
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('btn-mode-swarm').classList.add('active');
  updatePlaceholder();
});

// ---- Refine mode ----
document.getElementById('btn-mode-refine').addEventListener('click', () => {
  currentMode = 'refine';
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('btn-mode-refine').classList.add('active');
  updatePlaceholder();
  // Show spec card if we have one
  if (_currentSpec) updateSpecCard(_currentSpec);
});

// ---- Spec card state ----
let _currentSpec = null;       // IStructuredSpec from backend
let _refinementActive = false; // Are we in a refinement conversation?

// ---- Spec card UI ----
function updateSpecCard(spec) {
  _currentSpec = spec;
  const card = document.getElementById('spec-card');
  if (!spec) { card.classList.add('hidden'); return; }

  card.classList.remove('hidden');
  document.getElementById('spec-card-title').textContent = spec.name;
  document.getElementById('spec-card-version').textContent = `v${spec.version}`;
  document.getElementById('spec-card-summary').textContent = spec.summary;
  document.getElementById('spec-card-assumptions').textContent = spec.assumptions.join('; ') || '—';
  document.getElementById('spec-card-complexity').textContent = spec.complexity;
  document.getElementById('spec-card-credits').textContent = `~${spec.estimatedCredits}`;

  // Requirements list
  const ul = document.getElementById('spec-card-requirements');
  ul.innerHTML = '';
  for (const req of spec.requirements) {
    const li = document.createElement('li');
    const prioritySpan = document.createElement('span');
    prioritySpan.className = `spec-req-priority ${req.priority}`;
    prioritySpan.textContent = req.priority.toUpperCase();
    li.appendChild(prioritySpan);
    li.appendChild(document.createTextNode(`${req.label}: ${req.description}`));
    if (req.satisfied) {
      const check = document.createElement('span');
      check.className = 'spec-req-satisfied';
      check.textContent = ' ✓';
      li.appendChild(check);
    } else if (_pipelineComplete) {
      const cross = document.createElement('span');
      cross.className = 'spec-req-unsatisfied';
      cross.textContent = ' ✗';
      li.appendChild(cross);
    }
    ul.appendChild(li);
  }
}

// ---- Pipeline progress UI ----
let _pipelineComplete = false;

function showPipelineProgress(completed, total, current) {
  const el = document.getElementById('pipeline-progress');
  el.classList.remove('hidden');
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  document.getElementById('pipeline-progress-fill').style.width = `${pct}%`;
  document.getElementById('pipeline-progress-label').textContent = `Executing... ${completed}/${total} milestones`;
  document.getElementById('pipeline-progress-detail').textContent = current || '';
}

function _hidePipelineProgress() {
  document.getElementById('pipeline-progress').classList.add('hidden');
}

function _showCompletionCard(spec, allMet) {
  const msgList = document.getElementById('message-list');
  const card = document.createElement('div');
  card.className = 'completion-card';

  const header = document.createElement('div');
  header.className = 'completion-card-header';
  header.innerHTML = `<h3>${allMet ? '✅ All Requirements Met' : '⚠️ Partial Completion'}</h3>`;
  card.appendChild(header);

  const body = document.createElement('div');
  body.className = 'completion-card-body';
  if (spec) {
    const met = spec.requirements.filter(r => r.satisfied).length;
    const total = spec.requirements.length;
    body.innerHTML = `<p>${met}/${total} requirements satisfied.</p>`;
    for (const req of spec.requirements) {
      const div = document.createElement('div');
      div.className = 'completion-req-status';
      div.textContent = `${req.satisfied ? '✓' : '✗'} [${req.priority.toUpperCase()}] ${req.label}`;
      div.style.color = req.satisfied ? '#3fb950' : '#f85149';
      body.appendChild(div);
    }
  }
  card.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'completion-card-actions';
  if (!allMet) {
    const v2Btn = document.createElement('button');
    v2Btn.className = 'btn-small btn-primary';
    v2Btn.textContent = 'Run it again (v2)';
    v2Btn.addEventListener('click', async () => {
      currentMode = 'refine';
      document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
      document.getElementById('btn-mode-refine').classList.add('active');
      updatePlaceholder();

      // Start v2 refinement with pipeline backend
      try {
        addMessage('system', '🔄 Starting v2 refinement based on execution results...');
        const unsatisfiedReqs = spec.requirements.filter(r => !r.satisfied).map(r => `[${r.priority}] ${r.label}: ${r.description}`).join('\n');
        const result = await api.pipelineStartV2Refinement(`Unsatisfied requirements from previous run:\n${unsatisfiedReqs}\n\nPlease update the spec to address these gaps.`);
        if (result.error) {
          addMessage('system', `❌ v2 refinement failed: ${result.error}`);
        } else if (result.spec) {
          updateSpecCard(result.spec);
          addMessage('agent', result.response);
        }
      } catch (err) {
        addMessage('system', `❌ v2 pipeline error: ${err.message || err}`);
      }
    });
    actions.appendChild(v2Btn);
  }
  card.appendChild(actions);

  msgList.appendChild(card);
  msgList.scrollTop = msgList.scrollHeight;
}

// ---- Approve/Reject spec buttons ----
document.getElementById('btn-approve-spec').addEventListener('click', async () => {
  if (!_currentSpec) return;
  addMessage('system', `✅ Spec approved: **${_currentSpec.name}** v${_currentSpec.version}. Generating plan...`);
  document.getElementById('spec-card').classList.add('hidden');
  state = 'planning';
  _refinementActive = false;

  try {
    const result = await api.pipelineApproveSpec();
    if (result.error) {
      addMessage('system', `❌ Plan generation failed: ${result.error}`);
      setState('idle');
      return;
    }
    if (result.plan) {
      addMessage('system', `📋 Plan generated: ${result.plan.steps?.length || 0} steps, ${result.plan.milestones?.length || 0} milestones.`);
      // Show the preflight card for execution config
      document.getElementById('preflight-card').classList.remove('hidden');
    }
  } catch (err) {
    addMessage('system', `❌ Pipeline error: ${err.message || err}`);
    setState('idle');
  }
});

document.getElementById('btn-reject-spec').addEventListener('click', async () => {
  if (!_currentSpec) return;
  addMessage('system', '🔄 Spec revision requested. Continue refining...');
  _refinementActive = true;
  try {
    await api.pipelineRejectSpec('User requested revisions');
  } catch (_err) {
    // Non-critical — just log
  }
});

// ---- Pre-flight card ----
document.getElementById('preflight-allow-swarm').addEventListener('change', (e) => {
  document.getElementById('preflight-workers-row').style.display = e.target.checked ? 'flex' : 'none';
});

document.getElementById('btn-execute-preflight').addEventListener('click', async () => {
  const config = {
    executionMode: document.getElementById('preflight-exec-mode').value,
    creditLimit: parseInt(document.getElementById('preflight-credit-limit').value) || 200,
    verifyAfterMilestone: document.getElementById('preflight-verify').checked,
    allowSwarm: document.getElementById('preflight-allow-swarm').checked,
    maxWorkers: parseInt(document.getElementById('preflight-max-workers').value) || 4,
    selectedMilestoneIds: [],
  };
  document.getElementById('preflight-card').classList.add('hidden');
  addMessage('system', `🚀 Executing with config: mode=${config.executionMode}, credits≤${config.creditLimit}${config.allowSwarm ? `, swarm=${config.maxWorkers} workers` : ''}`);
  state = 'executing';
  showPipelineProgress(0, 1, 'Starting execution...');

  try {
    // Configure preflight first
    const configResult = await api.pipelineConfigurePreFlight(config);
    if (configResult.error) {
      addMessage('system', `❌ Pre-flight config failed: ${configResult.error}`);
      setState('idle');
      _hidePipelineProgress();
      return;
    }
    // Then execute
    const result = await api.pipelineExecute();
    if (result.error) {
      addMessage('system', `❌ Execution failed: ${result.error}`);
    }
  } catch (err) {
    addMessage('system', `❌ Pipeline execution error: ${err.message || err}`);
  }
  setState('idle');
  _hidePipelineProgress();
});

document.getElementById('btn-cancel-preflight').addEventListener('click', () => {
  document.getElementById('preflight-card').classList.add('hidden');
  state = 'idle';
  addMessage('system', 'Execution cancelled.');
});

// Auto-grow textarea
inputBox.addEventListener('input', () => {
  inputBox.style.height = 'auto';
  inputBox.style.height = Math.min(inputBox.scrollHeight, 200) + 'px';
});

btnFolder.addEventListener('click', async () => {
  const result = await api.pickFolder();
  if (!result.cancelled) {
    addMessage('system', `📂 Opened: ${result.paths.join(', ')}`);
    // Notify Layout B file tree
    if (result.paths && result.paths.length > 0) {
      // Wait briefly for window.fileTree if initLayout hasn't finished yet
      let ft = window.fileTree;
      if (!ft) {
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 200));
          ft = window.fileTree;
          if (ft) break;
        }
      }
      if (ft) {
        console.log('[Chat] Setting fileTree workspace root:', result.paths[0]);
        await ft.setWorkspaceRoot(result.paths[0]);
      } else {
        console.warn('[Chat] window.fileTree not available after waiting');
      }
    } else {
      console.warn('[Chat] No paths returned from pickFolder');
    }
  }
});

btnAcceptAll.addEventListener('click', async () => {
  await api.acceptAllChanges();
});

btnRejectAll.addEventListener('click', async () => {
  await api.rejectAllChanges();
});

// API key modal
btnSaveKey.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  const selectedProvider = apiKeyProvider ? apiKeyProvider.value : 'anthropic';
  if (key) {
    const secretKey = selectedProvider === 'nvidia-nim' ? 'kovix.apiKey.nvidia-nim' : selectedProvider === 'openrouter' ? 'kovix.apiKey.openrouter' : 'kovix.apiKey.anthropic';
    await api.setSecret(secretKey, key);
    // Switch to this provider
    const ok = await api.switchProvider(selectedProvider);
    if (ok) {
      activeProvider = selectedProvider;
      if (providerSelect) providerSelect.value = selectedProvider;
    }
    apiKeyModal.classList.add('hidden');
    // Hide first-run card after key is saved
    const firstRunCard = document.getElementById('first-run-card');
    if (firstRunCard) firstRunCard.classList.add('hidden');
    addMessage('system', `🔑 API key saved for ${selectedProvider === 'nvidia-nim' ? 'NVIDIA NIM' : 'Anthropic'}.`);
    await loadModels();
  }
});

btnCancelKey.addEventListener('click', () => {
  apiKeyModal.classList.add('hidden');
});

// ---------------------------------------------------------------------------
// Model selector
// ---------------------------------------------------------------------------

async function loadModels() {
  try {
    const models = await api.listModels();
    if (!models || models.length === 0) {
      modelSelect.innerHTML = '<option value="">No models available</option>';
      // Show "Configure API Key" link when no models are available
      const existingLink = document.getElementById('configure-api-key-link');
      if (!existingLink) {
        const link = document.createElement('a');
        link.id = 'configure-api-key-link';
        link.href = '#';
        link.textContent = 'Configure API Key';
        link.style.cssText = 'font-size:11px;color:#58a6ff;margin-left:8px;cursor:pointer;text-decoration:underline;';
        link.addEventListener('click', (e) => {
          e.preventDefault();
          const modal = document.getElementById('api-key-modal');
          if (modal) modal.classList.remove('hidden');
        });
        modelSelect.parentNode.insertBefore(link, modelSelect.nextSibling);
      }
      return;
    }
    // Hide the configure link if models are loaded
    const existingLink = document.getElementById('configure-api-key-link');
    if (existingLink) existingLink.remove();
    const config = await api.getConfig();
    const currentModel = config.llmActiveModel || '';
    modelSelect.innerHTML = '';
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.displayName || m.id;
      if (m.id === currentModel) opt.selected = true;
      modelSelect.appendChild(opt);
    }
  } catch (_err) {
    modelSelect.innerHTML = '<option value="">Error loading models</option>';
  }
}

modelSelect.addEventListener('change', async () => {
  const modelId = modelSelect.value;
  if (!modelId) return;
  const ok = await api.setModel(modelId);
  if (ok) {
    addMessage('system', `Switched to model: ${modelId}`);
  } else {
    addMessage('system', `Failed to switch model to ${modelId}`);
  }
});

// Provider selector
if (providerSelect) {
  providerSelect.addEventListener('change', async () => {
    const providerType = providerSelect.value;
    const secretKey = providerType === 'nvidia-nim' ? 'kovix.apiKey.nvidia-nim' : providerType === 'openrouter' ? 'kovix.apiKey.openrouter' : 'kovix.apiKey.anthropic';
    const hasKey = await api.getSecret(secretKey);
    if (!hasKey) {
      // No key for this provider — open settings
      const providerLabel = providerType === 'nvidia-nim' ? 'NVIDIA NIM' : providerType === 'openrouter' ? 'OpenRouter' : 'Anthropic';
      addMessage('system', `No API key set for ${providerLabel}. Set it in Settings.`);
      settingsModal.classList.remove('hidden');
      providerSelect.value = activeProvider;
      return;
    }
    const ok = await api.switchProvider(providerType);
    if (ok) {
      activeProvider = providerType;
      const providerLabel2 = providerType === 'nvidia-nim' ? 'NVIDIA NIM' : providerType === 'openrouter' ? 'OpenRouter' : 'Anthropic';
      addMessage('system', `Switched to ${providerLabel2}.`);
      await loadModels();
    } else {
      addMessage('system', `Failed to switch to ${providerType}. Check your API key.`);
      providerSelect.value = activeProvider;
    }
  });
}

// ---------------------------------------------------------------------------
// Settings modal
// ---------------------------------------------------------------------------

btnSettings.addEventListener('click', async () => {
  const anthropicKey = await api.getSecret('kovix.apiKey.anthropic');
  const nvidiaKey = await api.getSecret('kovix.apiKey.nvidia-nim');
  const openrouterKey = await api.getSecret('kovix.apiKey.openrouter');
  settingsAnthropicKey.value = anthropicKey || '';
  if (settingsNvidiaKey) settingsNvidiaKey.value = nvidiaKey || '';
  if (settingsOpenRouterKey) settingsOpenRouterKey.value = openrouterKey || '';
  settingsModal.classList.remove('hidden');
});

btnCloseSettings.addEventListener('click', () => {
  settingsModal.classList.add('hidden');
});

btnSaveAnthropicKey.addEventListener('click', async () => {
  const key = settingsAnthropicKey.value.trim();
  if (key) {
    await api.setSecret('kovix.apiKey.anthropic', key);
    addMessage('system', 'Anthropic API key saved. Refreshing models…');
    settingsModal.classList.add('hidden');
    await loadModels();
  }
});

if (btnSaveNvidiaKey) {
  btnSaveNvidiaKey.addEventListener('click', async () => {
    const key = settingsNvidiaKey.value.trim();
    if (key) {
      await api.setSecret('kovix.apiKey.nvidia-nim', key);
      addMessage('system', 'NVIDIA API key saved. Switching provider…');
      settingsModal.classList.add('hidden');
      // Auto-switch to NVIDIA
      const ok = await api.switchProvider('nvidia-nim');
      if (ok) {
        activeProvider = 'nvidia-nim';
        if (providerSelect) providerSelect.value = 'nvidia-nim';
        addMessage('system', 'Switched to NVIDIA NIM.');
      }
      await loadModels();
    }
  });
}

if (btnSaveOpenRouterKey) {
  btnSaveOpenRouterKey.addEventListener('click', async () => {
    const key = settingsOpenRouterKey.value.trim();
    if (key) {
      await api.setSecret('kovix.apiKey.openrouter', key);
      addMessage('system', 'OpenRouter API key saved. Switching provider…');
      settingsModal.classList.add('hidden');
      // Auto-switch to OpenRouter
      const ok = await api.switchProvider('openrouter');
      if (ok) {
        activeProvider = 'openrouter';
        if (providerSelect) providerSelect.value = 'openrouter';
        addMessage('system', 'Switched to OpenRouter.');
      }
      await loadModels();
    }
  });
}

// ---------------------------------------------------------------------------
// Init: check for API key on startup
// ---------------------------------------------------------------------------

(async function init() {
  // Check for any API key
  const anthropicKey = await api.getSecret('kovix.apiKey.anthropic');
  const nvidiaKey = await api.getSecret('kovix.apiKey.nvidia-nim');
  const openrouterKey = await api.getSecret('kovix.apiKey.openrouter');

  if (!anthropicKey && !nvidiaKey && !openrouterKey) {
    apiKeyModal.classList.remove('hidden');
  }

  // Restore active provider from config
  try {
    const provider = await api.getActiveProvider();
    if (provider) {
      activeProvider = provider;
      if (providerSelect) providerSelect.value = provider;
    }
  } catch { /* provider config not available yet */ }

  // Load models into the selector
  await loadModels();

  // Set initial placeholder based on default mode
  updatePlaceholder();

  // Initialize credit bar
  updateCreditBar();
  // Refresh credits every 15 seconds
  setInterval(updateCreditBar, 15000);

  // Check workspace roots
  const appState = await api.getAppState();
  if (appState.workspaceRoots && appState.workspaceRoots.length > 0) {
    if (welcomeMsg) {
      welcomeMsg.querySelector('p').textContent = `Workspace: ${appState.workspaceRoots.join(', ')}. Ask anything to get started.`;
    }
  }

  // First-run onboarding: show card if no API key is configured
  try {
    const models = await api.listModels();
    if (!models || models.length === 0) {
      const firstRunCard = document.getElementById('first-run-card');
      if (firstRunCard) firstRunCard.classList.remove('hidden');
      const btnFirstRun = document.getElementById('btn-first-run-configure');
      if (btnFirstRun) {
        btnFirstRun.addEventListener('click', () => {
          const modal = document.getElementById('api-key-modal');
          if (modal) modal.classList.remove('hidden');
        });
      }
    }
  } catch { /* first-run check failed, non-critical */ }
})();
