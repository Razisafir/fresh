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
let activeProvider = 'anthropic'; // Any AIProviderType value

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

  div.innerHTML = renderMarkdown(content);
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
    // Italic
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    // Headers
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h2>$1</h2>')
    // Lists (simple: - item)
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    // Numbered lists
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
    // Links
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
    // Paragraphs (double newline)
    .replace(/\n\n/g, '</p><p>')
    // Single newlines within paragraphs
    .replace(/\n/g, '<br>');
  // Wrap loose <li> in <ul>
  html = html.replace(/(<li>.*?<\/li>)+/gs, '<ul>$&</ul>');
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
  const failed = workerResults.filter(r => !r.success).length;

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
      <h3>Swarm Complete: ${succeeded}/${workerResults.length} succeeded${failed > 0 ? `, ${failed} failed` : ''}</h3>
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
      addMessage('system', `🔍 Verification: ${badge}${unverified}`);
      break;
    }
    case 'complete':
      streamingMessage = null;
      addMessage('system', `✅ Task complete: ${event.summary}`);
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
    if (window.fileTree && result.paths.length > 0) {
      console.log('[Chat] Setting fileTree workspace root:', result.paths[0]);
      await window.fileTree.setWorkspaceRoot(result.paths[0]);
    } else {
      console.warn('[Chat] window.fileTree not available or no paths returned');
    }
  }
});

btnAcceptAll.addEventListener('click', async () => {
  await api.acceptAllChanges();
});

btnRejectAll.addEventListener('click', async () => {
  await api.rejectAllChanges();
});

// Provider metadata — maps provider type to secret key, display name, and whether a key is required
const PROVIDER_META = {
  'anthropic':   { secretKey: 'kovix.apiKey.anthropic',   label: 'Anthropic',     needsKey: true },
  'nvidia-nim':  { secretKey: 'kovix.apiKey.nvidia-nim',  label: 'NVIDIA NIM',    needsKey: true },
  'openrouter':  { secretKey: 'kovix.apiKey.openrouter',  label: 'OpenRouter',    needsKey: true },
  'openai':      { secretKey: 'kovix.apiKey.openai',      label: 'OpenAI',        needsKey: true },
  'ollama':      { secretKey: null,                        label: 'Ollama (Local)',needsKey: false },
  'deepseek':    { secretKey: 'kovix.apiKey.deepseek',    label: 'DeepSeek',      needsKey: true },
  'groq':        { secretKey: 'kovix.apiKey.groq',        label: 'Groq',          needsKey: true },
  'mistral':     { secretKey: 'kovix.apiKey.mistral',     label: 'Mistral',       needsKey: true },
  'gemini':      { secretKey: 'kovix.apiKey.gemini',      label: 'Gemini',        needsKey: true },
  'together':    { secretKey: 'kovix.apiKey.together',    label: 'Together AI',   needsKey: true },
  'lm-studio':   { secretKey: null,                        label: 'LM Studio',     needsKey: false },
};

function getProviderMeta(type) {
  return PROVIDER_META[type] || { secretKey: `kovix.apiKey.${type}`, label: type, needsKey: true };
}

// API key modal
btnSaveKey.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  const selectedProvider = apiKeyProvider ? apiKeyProvider.value : 'anthropic';
  const meta = getProviderMeta(selectedProvider);
  if (meta.needsKey && key) {
    await api.setSecret(meta.secretKey, key);
  } else if (!meta.needsKey) {
    // Local provider — no key needed
  } else {
    return; // Key required but not provided
  }
  // Switch to this provider
  const ok = await api.switchProvider(selectedProvider);
  if (ok) {
    activeProvider = selectedProvider;
    if (providerSelect) providerSelect.value = selectedProvider;
  }
  apiKeyModal.classList.add('hidden');
  addMessage('system', `🔑 API key saved for ${meta.label}.`);
  await loadModels();
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
      return;
    }
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
    const meta = getProviderMeta(providerType);

    if (meta.needsKey) {
      const hasKey = meta.secretKey ? await api.getSecret(meta.secretKey) : false;
      if (!hasKey) {
        // No key for this provider — open settings
        addMessage('system', `No API key set for ${meta.label}. Set it in Settings.`);
        settingsModal.classList.remove('hidden');
        providerSelect.value = activeProvider;
        return;
      }
    }

    const ok = await api.switchProvider(providerType);
    if (ok) {
      activeProvider = providerType;
      addMessage('system', `Switched to ${meta.label}.`);
      await loadModels();
    } else {
      addMessage('system', `Failed to switch to ${meta.label}. Check your API key or server status.`);
      providerSelect.value = activeProvider;
    }
  });
}

// ---------------------------------------------------------------------------
// Settings modal
// ---------------------------------------------------------------------------

btnSettings.addEventListener('click', async () => {
  // Load existing keys into settings fields
  const keys = await Promise.all([
    api.getSecret('kovix.apiKey.anthropic'),
    api.getSecret('kovix.apiKey.nvidia-nim'),
    api.getSecret('kovix.apiKey.openrouter'),
    api.getSecret('kovix.apiKey.openai'),
    api.getSecret('kovix.apiKey.deepseek'),
    api.getSecret('kovix.apiKey.groq'),
    api.getSecret('kovix.apiKey.mistral'),
    api.getSecret('kovix.apiKey.gemini'),
    api.getSecret('kovix.apiKey.together'),
  ]);
  settingsAnthropicKey.value = keys[0] || '';
  if (settingsNvidiaKey) settingsNvidiaKey.value = keys[1] || '';
  if (settingsOpenRouterKey) settingsOpenRouterKey.value = keys[2] || '';
  // New provider key fields
  const newKeyFields = ['settings-openai-key', 'settings-deepseek-key', 'settings-groq-key', 'settings-mistral-key', 'settings-gemini-key', 'settings-together-key'];
  for (let i = 0; i < newKeyFields.length; i++) {
    const el = document.getElementById(newKeyFields[i]);
    if (el) el.value = keys[3 + i] || '';
  }
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

// Dynamic save handlers for new provider keys
const newProviderSaveButtons = [
  { btnId: 'btn-save-openai-key',   inputId: 'settings-openai-key',   secretKey: 'kovix.apiKey.openai',   provider: 'openai',   label: 'OpenAI' },
  { btnId: 'btn-save-deepseek-key', inputId: 'settings-deepseek-key', secretKey: 'kovix.apiKey.deepseek', provider: 'deepseek', label: 'DeepSeek' },
  { btnId: 'btn-save-groq-key',     inputId: 'settings-groq-key',    secretKey: 'kovix.apiKey.groq',     provider: 'groq',     label: 'Groq' },
  { btnId: 'btn-save-mistral-key',  inputId: 'settings-mistral-key', secretKey: 'kovix.apiKey.mistral',  provider: 'mistral',  label: 'Mistral' },
  { btnId: 'btn-save-gemini-key',   inputId: 'settings-gemini-key',  secretKey: 'kovix.apiKey.gemini',   provider: 'gemini',   label: 'Gemini' },
  { btnId: 'btn-save-together-key', inputId: 'settings-together-key', secretKey: 'kovix.apiKey.together', provider: 'together', label: 'Together AI' },
];

for (const { btnId, inputId, secretKey, provider, label } of newProviderSaveButtons) {
  const btn = document.getElementById(btnId);
  const input = document.getElementById(inputId);
  if (btn && input) {
    btn.addEventListener('click', async () => {
      const key = input.value.trim();
      if (key) {
        await api.setSecret(secretKey, key);
        addMessage('system', `${label} API key saved. Switching provider…`);
        settingsModal.classList.add('hidden');
        const ok = await api.switchProvider(provider);
        if (ok) {
          activeProvider = provider;
          if (providerSelect) providerSelect.value = provider;
          addMessage('system', `Switched to ${label}.`);
        }
        await loadModels();
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Init: check for API key on startup
// ---------------------------------------------------------------------------

(async function init() {
  // Check for any API key
  const allKeys = await Promise.all([
    api.getSecret('kovix.apiKey.anthropic'),
    api.getSecret('kovix.apiKey.nvidia-nim'),
    api.getSecret('kovix.apiKey.openrouter'),
    api.getSecret('kovix.apiKey.openai'),
    api.getSecret('kovix.apiKey.deepseek'),
    api.getSecret('kovix.apiKey.groq'),
    api.getSecret('kovix.apiKey.mistral'),
    api.getSecret('kovix.apiKey.gemini'),
    api.getSecret('kovix.apiKey.together'),
  ]);
  const hasAnyKey = allKeys.some(k => k);

  if (!hasAnyKey) {
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
})();
