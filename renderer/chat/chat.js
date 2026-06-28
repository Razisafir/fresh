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
const creditBadge = document.getElementById('credit-badge');
const settingsBudget = document.getElementById('settings-budget');
const btnSaveBudget = document.getElementById('btn-save-budget');

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

  // Show parsed steps if available
  const stepsHtml = plan.steps && plan.steps.length > 0
    ? plan.steps.map(s => `<li>[${s.action}] ${escapeHtml(s.target)}${s.description !== s.target ? ' — ' + escapeHtml(s.description) : ''}</li>`).join('')
    : '';

  // Always show the raw plan text so the user can see the full proposal
  // even if parsing didn't extract structured steps.
  const rawSummary = plan.rawResponse || plan.summary || '';
  const summaryHtml = rawSummary
    ? `<div class="plan-summary">${renderMarkdown(rawSummary)}</div>`
    : '';

  const stepCount = plan.steps ? plan.steps.length : 0;

  div.innerHTML = `
    <h3>Plan: ${stepCount} step${stepCount !== 1 ? 's' : ''}</h3>
    ${stepsHtml ? `<ol class="plan-steps">${stepsHtml}</ol>` : ''}
    ${summaryHtml}
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

async function refreshCreditBadge() {
  try {
    const status = await api.getCreditsStatus();
    if (!creditBadge) return;
    const used = status.creditsUsed || 0;
    const remaining = status.creditsRemaining;
    const max = status.budget?.maxCreditsPerTask || 0;

    if (max > 0) {
      creditBadge.textContent = `${used}/${max} credits`;
    } else {
      creditBadge.textContent = `${used} credits`;
    }

    // Visual warning states
    creditBadge.classList.remove('warning', 'emergency');
    if (status.emergencyMode) {
      creditBadge.classList.add('emergency');
    } else if (max > 0 && remaining / max < 0.2) {
      creditBadge.classList.add('warning');
    }
  } catch {
    // Credit system not available — silently ignore
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
      // Explicitly refresh the pending bar since the file was just staged
      api.getPendingSnapshot().then(snapshot => {
        if (Array.isArray(snapshot)) {
          showPendingBar(snapshot.length);
        }
      });
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
      refreshCreditBadge();
      break;
    case 'error':
      streamingMessage = null;
      addMessage('system', `❌ Error: ${event.text}`);
      setState('idle');
      refreshCreditBadge();
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

  // O-002 fix: Detect if the user is about to send an API key as a chat message.
  // API keys should never be sent to the LLM — they go in the settings dialog.
  const apiKeyPatterns = [
    /^sk-ant-[a-zA-Z0-9]{20,}/,        // Anthropic
    /^sk-or-v1-[a-zA-Z0-9]{20,}/,      // OpenRouter
    /^nvapi-[a-zA-Z0-9]{20,}/,          // NVIDIA NIM
    /^ghp_[a-zA-Z0-9]{30,}/,            // GitHub PAT (classic)
    /^github_pat_[a-zA-Z0-9]{20,}/,     // GitHub PAT (fine-grained)
  ];
  const looksLikeKey = apiKeyPatterns.some(p => p.test(text));
  if (looksLikeKey) {
    addMessage('system', `⚠️ That looks like an API key! Don't send keys as chat messages — they would be sent to the AI provider. To set your API key, click the ⚙️ Settings button and paste it in the correct field.`);
    inputBox.value = '';
    inputBox.style.height = 'auto';
    return;
  }

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

  // Extract milestones from the plan steps if not already provided.
  // This mirrors the extraction logic in agentLoop.ts so the main process
  // doesn't have to re-derive milestones from a potentially mangled plan.
  let milestones = plan.milestones || [];
  if (!milestones || milestones.length === 0) {
    milestones = extractMilestonesFromSteps(plan.steps || []);
  }

  const approvedPlan = {
    task: plan.summary || plan.rawResponse?.substring(0, 200) || 'User task',
    steps: (plan.steps || []).map((s, i) => ({ ...s, selected: true, index: i })),
    executionMode: autonomy,
    milestones: milestones,
    approved: true,
    approvedAt: Date.now(),
  };

  // Remove the plan card
  const planCard = document.querySelector('.plan-card');
  if (planCard) planCard.remove();

  const milestoneInfo = milestones.length > 0 ? ` (${milestones.length} milestone${milestones.length !== 1 ? 's' : ''})` : '';
  addMessage('system', `▶ Plan approved (${autonomy})${milestoneInfo}. Starting execution…`);
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

/**
 * Client-side milestone extraction from plan steps.
 * Mirrors the logic in agentLoop.extractMilestonesFromPlan() so that
 * the renderer can show milestone info and the main process receives
 * a properly structured approved plan.
 */
function extractMilestonesFromSteps(steps) {
  if (!steps || steps.length === 0) return [];

  const milestones = [];
  let currentGroup = [];
  let milestoneIndex = 0;

  for (let i = 0; i < steps.length; i++) {
    currentGroup.push(i);

    const isNaturalBoundary =
      currentGroup.length >= 3 &&
      (i === steps.length - 1 ||
        (steps[i].action === 'Run' && steps[i + 1]?.action !== 'Run') ||
        (steps[i].action === 'Create' && steps[i + 1]?.action !== 'Create') ||
        currentGroup.length >= 5);

    if (isNaturalBoundary) {
      const firstStep = steps[currentGroup[0]];
      const lastStep = steps[currentGroup[currentGroup.length - 1]];
      const isMajor = currentGroup.some(idx =>
        steps[idx].action === 'Create' || steps[idx].action === 'Run'
      );

      milestones.push({
        id: `milestone-${milestoneIndex}`,
        name: `${firstStep.action}: ${firstStep.target}${currentGroup.length > 1 ? ' -> ' + lastStep.target : ''}`,
        description: `Steps ${currentGroup[0] + 1}-${currentGroup[currentGroup.length - 1] + 1}`,
        index: milestoneIndex,
        isMajor: isMajor,
        stepIndices: [...currentGroup],
        completed: false,
      });

      currentGroup = [];
      milestoneIndex++;
    }
  }

  if (currentGroup.length > 0) {
    const firstStep = steps[currentGroup[0]];
    const isMajor = currentGroup.some(idx =>
      steps[idx].action === 'Create' || steps[idx].action === 'Run'
    );

    milestones.push({
      id: `milestone-${milestoneIndex}`,
      name: `${firstStep.action}: ${firstStep.target}`,
      description: `Steps ${currentGroup[0] + 1}-${currentGroup[currentGroup.length - 1] + 1}`,
      index: milestoneIndex,
      isMajor: isMajor,
      stepIndices: [...currentGroup],
      completed: false,
    });
  }

  return milestones;
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
  }
});

btnAcceptAll.addEventListener('click', async () => {
  try {
    await api.acceptAllChanges();
  } catch (e) {
    console.error('Accept all failed:', e);
  }
  // Force refresh pending bar after accept with a microtask delay
  // to ensure the backend has fully processed the deletion.
  await new Promise(r => setTimeout(r, 50));
  try {
    const snapshot = await api.getPendingSnapshot();
    showPendingBar(Array.isArray(snapshot) ? snapshot.length : 0);
  } catch (e) {
    showPendingBar(0);
  }
});

btnRejectAll.addEventListener('click', async () => {
  try {
    await api.rejectAllChanges();
  } catch (e) {
    console.error('Reject all failed:', e);
  }
  // Force refresh pending bar after reject with a microtask delay
  await new Promise(r => setTimeout(r, 50));
  try {
    const snapshot = await api.getPendingSnapshot();
    showPendingBar(Array.isArray(snapshot) ? snapshot.length : 0);
  } catch (e) {
    showPendingBar(0);
  }
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
      // Mark models that don't support tool use
      if (!m.supportsTools) {
        opt.textContent += ' (no tools)';
      }
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
    // Warn if the selected model doesn't support tool use
    const models = await api.listModels();
    const selected = models?.find(m => m.id === modelId);
    if (selected && !selected.supportsTools) {
      addMessage('system', `⚠️ This model does not support tool use. File creation, editing, and other tool-dependent tasks will not work. Switch to a model that supports tools for full functionality.`);
    }
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

// Budget settings handler
if (btnSaveBudget) {
  btnSaveBudget.addEventListener('click', async () => {
    const budgetVal = parseInt(settingsBudget.value, 10);
    if (isNaN(budgetVal) || budgetVal < 0) {
      addMessage('system', '⚠️ Budget must be a non-negative number. Set to 0 for unlimited.');
      return;
    }
    await api.setCreditsBudget({
      maxCreditsPerTask: budgetVal,
      warningThresholdPercent: 20,
      emergencyStopThreshold: 10,
      enabled: budgetVal > 0,
    });
    addMessage('system', budgetVal === 0
      ? '🔓 Credit budget set to unlimited.'
      : `🔒 Credit budget set to ${budgetVal} per task.`
    );
    refreshCreditBadge();
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
  } catch { /* no saved provider yet */ }

  // Load models into the selector
  await loadModels();

  // Load credit status
  await refreshCreditBadge();

  // Set initial placeholder based on default mode
  updatePlaceholder();

  // Check workspace roots
  const appState = await api.getAppState();
  if (appState.workspaceRoots && appState.workspaceRoots.length > 0) {
    if (welcomeMsg) {
      welcomeMsg.querySelector('p').textContent = `Workspace: ${appState.workspaceRoots.join(', ')}. Ask anything to get started.`;
    }
  }

  // Pre-fill budget in settings
  try {
    const status = await api.getCreditsStatus();
    if (settingsBudget && status.budget) {
      settingsBudget.value = status.budget.maxCreditsPerTask || 0;
    }
  } catch { /* ignore */ }
})();
