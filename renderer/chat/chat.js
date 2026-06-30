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

let state = 'idle'; // idle | planning | awaiting_approval | executing | complete
let currentMode = 'chat'; // 'chat' | 'plan'
let _currentPlan = null;
let streamingMessage = null;
let activeProvider = 'anthropic'; // 'anthropic' | 'nvidia-nim' | 'openrouter'

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
    // Lists (simple: - item)
    .replace(/^- (.+)$/gm, '<li>$1</li>')
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

function getSecretKeyForProvider(providerType) {
  switch (providerType) {
    case 'nvidia-nim': return 'kovix.apiKey.nvidia-nim';
    case 'openrouter': return 'kovix.apiKey.openrouter';
    default: return 'kovix.apiKey.anthropic';
  }
}

function getProviderDisplayName(providerType) {
  switch (providerType) {
    case 'nvidia-nim': return 'NVIDIA NIM';
    case 'openrouter': return 'OpenRouter';
    default: return 'Anthropic';
  }
}

function setState(newState) {
  state = newState;
  btnSend.disabled = (state === 'planning' || state === 'executing');
}

function updatePlaceholder() {
  if (inputBox) {
    inputBox.placeholder = currentMode === 'chat' ? 'Ask anything…' : 'Describe a task…';
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

api.onAgentEvent((event) => {
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
      streamingMessage.innerHTML = renderMarkdown(
        (streamingMessage.innerText || '') + event.text
      );
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
      addPlanCard(event.plan);
      setState('awaiting_approval');
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

// API key modal
btnSaveKey.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  const selectedProvider = apiKeyProvider ? apiKeyProvider.value : 'anthropic';
  if (key) {
    const secretKey = getSecretKeyForProvider(selectedProvider);
    await api.setSecret(secretKey, key);
    // Switch to this provider
    const ok = await api.switchProvider(selectedProvider);
    if (ok) {
      activeProvider = selectedProvider;
      if (providerSelect) providerSelect.value = selectedProvider;
    }
    apiKeyModal.classList.add('hidden');
    addMessage('system', `🔑 API key saved for ${getProviderDisplayName(selectedProvider)}.`);
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
    const secretKey = getSecretKeyForProvider(providerType);
    const hasKey = await api.getSecret(secretKey);
    if (!hasKey) {
      // No key for this provider — open settings
      addMessage('system', `No API key set for ${getProviderDisplayName(providerType)}. Set it in Settings.`);
      settingsModal.classList.remove('hidden');
      providerSelect.value = activeProvider;
      return;
    }
    const ok = await api.switchProvider(providerType);
    if (ok) {
      activeProvider = providerType;
      addMessage('system', `Switched to ${getProviderDisplayName(providerType)}.`);
      await loadModels();
    } else {
      addMessage('system', `Failed to switch to ${getProviderDisplayName(providerType)}. Check your API key.`);
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

  // Check workspace roots
  const appState = await api.getAppState();
  if (appState.workspaceRoots && appState.workspaceRoots.length > 0) {
    if (welcomeMsg) {
      welcomeMsg.querySelector('p').textContent = `Workspace: ${appState.workspaceRoots.join(', ')}. Ask anything to get started.`;
    }
  }
})();
