/**
 * agentPanel.js — Kovix agent chat webview client.
 *
 * Round 2D deliverable. Runs inside the webview iframe. Uses the VS Code
 * webview API (acquireVsCodeApi) to post messages to the extension host,
 * which proxies them to the AgentLoopService singleton.
 *
 * Message protocol (extension host ↔ webview):
 *
 * Outbound (webview → host):
 *   { type: 'sendTask',         text: string }
 *   { type: 'cancel' }
 *   { type: 'approvePlan',      executionMode: 'every_milestone'|'major_milestone'|'selective'|'full_auto' }
 *   { type: 'cancelPlan' }
 *   { type: 'resumeMilestone' }
 *   { type: 'skipMilestone' }
 *   { type: 'abortMilestone' }
 *   { type: 'acceptPending',    filePath: string }
 *   { type: 'rejectPending',    filePath: string }
 *   { type: 'viewDiff',         filePath: string }
 *   { type: 'clearConversation' }
 *   { type: 'manageApiKeys' }
 *
 * Inbound (host → webview):
 *   { type: 'ready',                 activeProvider: string|null, hasApiKey: boolean }
 *   { type: 'agentState',            state: 'idle'|'planning'|'running'|'paused'|'complete'|'error' }
 *   { type: 'userMessage',           text: string, timestamp: number }
 *   { type: 'agentMessageStart',     timestamp: number }
 *   { type: 'token',                 text: string }
 *   { type: 'agentMessageEnd' }
 *   { type: 'thinking' }
 *   { type: 'plan',                  task: string, milestones: Array<{id:string,name:string,steps:Array<{index,action,target,description}>}> }
 *   { type: 'toolStart',             toolId: string, toolName: string }
 *   { type: 'toolInput',             toolId: string, text: string }
 *   { type: 'toolEnd',               toolId: string, toolName: string, success: boolean, result: string, durationMs: number }
 *   { type: 'fileWritten',           filePath: string, isNew: boolean }
 *   { type: 'milestoneReached',      milestone: { id, name, description } }
 *   { type: 'milestonePaused',       milestone: { id, name, description } }
 *   { type: 'milestoneResumed',      milestone: { id, name } }
 *   { type: 'milestoneSkipped',      milestone: { id, name } }
 *   { type: 'milestoneCompleted',    milestone: { id, name } }
 *   { type: 'verificationStart',     command: string }
 *   { type: 'verificationResult',    passed: boolean, output: string, unverified: boolean }
 *   { type: 'pendingChanges',        entries: Array<{ filePath: string, isNew: boolean }> }
 *   { type: 'pendingChangeAccepted', filePath: string }
 *   { type: 'pendingChangeRejected', filePath: string }
 *   { type: 'complete',              summary: string }
 *   { type: 'error',                 text: string, recoverable: boolean }
 *   { type: 'cleared' }
 *
 * No external deps. Vanilla JS. CSP-friendly (no eval, no inline handlers).
 */

// acquireVsCodeApi is injected by the VS Code webview host. It returns a
// singleton — calling it twice throws. We acquire once and stash on globalThis.
const vscode = (function () {
  if (typeof acquireVsCodeApi === 'function') {
    return acquireVsCodeApi();
  }
  // Test harness / preview outside VS Code: return a noop stub.
  // eslint-disable-next-line no-console
  console.warn('[kovix] acquireVsCodeApi not available — running in stub mode.');
  return {
    postMessage(msg) {
      // eslint-disable-next-line no-console
      console.log('[kovix:outbound]', msg);
    },
    getState() { return null; },
    setState(_state) { /* noop */ },
  };
})();

// -------------------------------------------------------------------------
// State
// -------------------------------------------------------------------------

const state = {
  /** @type {'idle'|'planning'|'running'|'paused'|'complete'|'error'} */
  agentState: 'idle',
  activeProvider: null,
  hasApiKey: false,
  /** Pending plan awaiting user approval (null if none). */
  pendingPlan: null,
  /** Streaming buffer for the in-flight agent message. */
  streamingBuffer: '',
  /** Whether a streaming agent message is currently open in the DOM. */
  streamingOpen: false,
  /** Map of toolId → DOM element for in-flight tool calls. */
  openToolCards: new Map(),
  /** Pending file changes (mirrors host state). */
  pendingEntries: [],
  /** Track if the empty state has been dismissed. */
  emptyStateDismissed: false,
  /** Current milestone (when paused). */
  pausedMilestone: null,
};

// -------------------------------------------------------------------------
// DOM references (cached on DOMContentLoaded)
// -------------------------------------------------------------------------

const dom = {
  root: null,
  messageList: null,
  emptyState: null,
  inputWrapper: null,
  inputTextarea: null,
  sendButton: null,
  agentStatus: null,
  milestoneBanner: null,
  milestoneLabel: null,
  pendingSection: null,
  pendingHeader: null,
  pendingList: null,
  pendingCount: null,
  actionClear: null,
  actionSettings: null,
};

// -------------------------------------------------------------------------
// Bootstrap
// -------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  cacheDom();
  bindEvents();
  restoreState();
  vscode.postMessage({ type: 'ready' });
});

function cacheDom() {
  dom.root = document.getElementById('kovix-root');
  dom.messageList = document.getElementById('message-list');
  dom.emptyState = document.getElementById('empty-state');
  dom.inputWrapper = document.getElementById('input-wrapper');
  dom.inputTextarea = document.getElementById('input-textarea');
  dom.sendButton = document.getElementById('send-button');
  dom.agentStatus = document.getElementById('agent-status');
  dom.milestoneBanner = document.getElementById('milestone-banner');
  dom.milestoneLabel = document.getElementById('milestone-label');
  dom.pendingSection = document.getElementById('pending-section');
  dom.pendingHeader = document.getElementById('pending-header');
  dom.pendingList = document.getElementById('pending-list');
  dom.pendingCount = document.getElementById('pending-count');
  dom.actionClear = document.getElementById('action-clear');
  dom.actionSettings = document.getElementById('action-settings');
}

function bindEvents() {
  // Send button
  dom.sendButton.addEventListener('click', onSendClick);

  // Input textarea — Enter to send, Shift+Enter for newline, auto-grow.
  dom.inputTextarea.addEventListener('keydown', onInputKeydown);
  dom.inputTextarea.addEventListener('input', onInputInput);

  // Header actions
  dom.actionClear.addEventListener('click', () => {
    vscode.postMessage({ type: 'clearConversation' });
  });
  dom.actionSettings.addEventListener('click', () => {
    vscode.postMessage({ type: 'manageApiKeys' });
  });

  // Milestone banner actions
  document.getElementById('milestone-resume').addEventListener('click', () => {
    vscode.postMessage({ type: 'resumeMilestone' });
  });
  document.getElementById('milestone-skip').addEventListener('click', () => {
    vscode.postMessage({ type: 'skipMilestone' });
  });
  document.getElementById('milestone-abort').addEventListener('click', () => {
    vscode.postMessage({ type: 'abortMilestone' });
  });

  // Pending section header — toggle collapse.
  dom.pendingHeader.addEventListener('click', togglePendingSection);
  dom.pendingHeader.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      togglePendingSection();
    }
  });

  // Inbound messages from the extension host.
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
      return;
    }
    handleMessage(msg);
  });
}

function restoreState() {
  // VS Code webviews can persist state via vscode.getState/setState.
  // For v0.1 we don't persist anything — each activation starts fresh.
  // (Conversation history lives in the AgentLoopService singleton, which
  // survives webview re-parenting but not extension restart.)
}

// -------------------------------------------------------------------------
// Outbound handlers
// -------------------------------------------------------------------------

function onSendClick() {
  if (state.agentState === 'running' || state.agentState === 'planning') {
    // Send button is in "Stop" mode — emit cancel.
    vscode.postMessage({ type: 'cancel' });
    return;
  }
  const text = dom.inputTextarea.value.trim();
  if (!text) {
    return;
  }
  vscode.postMessage({ type: 'sendTask', text });
  dom.inputTextarea.value = '';
  autoGrowTextarea();
}

function onInputKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    onSendClick();
  } else if (e.key === 'Escape' && state.pendingPlan) {
    e.preventDefault();
    vscode.postMessage({ type: 'cancelPlan' });
  }
}

function onInputInput() {
  autoGrowTextarea();
  // Enable/disable send button based on input.
  const text = dom.inputTextarea.value.trim();
  if (state.agentState === 'idle' || state.agentState === 'complete' || state.agentState === 'error') {
    dom.sendButton.disabled = text.length === 0;
  }
}

function autoGrowTextarea() {
  const el = dom.inputTextarea;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 240) + 'px';
}

function togglePendingSection() {
  const section = dom.pendingSection;
  const isCollapsed = section.classList.toggle('collapsed');
  dom.pendingHeader.setAttribute('aria-expanded', String(!isCollapsed));
}

// -------------------------------------------------------------------------
// Inbound message handler
// -------------------------------------------------------------------------

function handleMessage(msg) {
  switch (msg.type) {
    case 'ready':                 return onHostReady(msg);
    case 'agentState':            return setAgentState(msg.state);
    case 'userMessage':           return appendUserMessage(msg.text, msg.timestamp);
    case 'agentMessageStart':     return openStreamingAgentMessage(msg.timestamp);
    case 'token':                 return appendStreamingToken(msg.text);
    case 'agentMessageEnd':       return closeStreamingAgentMessage();
    case 'thinking':              return showThinking();
    case 'plan':                  return showPlanCard(msg);
    case 'toolStart':             return onToolStart(msg);
    case 'toolInput':             return onToolInput(msg);
    case 'toolEnd':               return onToolEnd(msg);
    case 'fileWritten':           return onFileWritten(msg);
    case 'milestoneReached':      return appendSystemMessage(`▸ Milestone: ${msg.milestone.name}`);
    case 'milestonePaused':       return onMilestonePaused(msg.milestone);
    case 'milestoneResumed':      return onMilestoneResumed(msg.milestone);
    case 'milestoneSkipped':      return appendSystemMessage(`▸ Skipped: ${msg.milestone.name}`);
    case 'milestoneCompleted':    return appendSystemMessage(`▸ Completed: ${msg.milestone.name}`);
    case 'verificationStart':     return appendSystemMessage(`▸ Verifying: ${msg.command}`);
    case 'verificationResult':    return appendVerificationResult(msg);
    case 'pendingChanges':        return onPendingChanges(msg.entries);
    case 'pendingChangeAccepted': return onPendingChangeResolved(msg.filePath, 'accepted');
    case 'pendingChangeRejected': return onPendingChangeResolved(msg.filePath, 'rejected');
    case 'complete':              return onComplete(msg.summary);
    case 'error':                 return onError(msg.text, msg.recoverable);
    case 'cleared':               return onCleared();
    default:
      // eslint-disable-next-line no-console
      console.warn('[kovix] Unknown message type:', msg.type, msg);
  }
}

function onHostReady(msg) {
  state.activeProvider = msg.activeProvider;
  state.hasApiKey = msg.hasApiKey;
  if (!state.hasApiKey) {
    appendSystemMessage('No API key set. Click the gear icon to add one.');
  }
}

// -------------------------------------------------------------------------
// Agent state + UI sync
// -------------------------------------------------------------------------

function setAgentState(newState) {
  state.agentState = newState;
  dom.agentStatus.textContent = newState.charAt(0).toUpperCase() + newState.slice(1);

  const isRunning = newState === 'running' || newState === 'planning';
  dom.inputWrapper.classList.toggle('disabled', isRunning && newState !== 'planning');

  // Toggle send button between Send / Stop modes.
  if (isRunning) {
    dom.sendButton.classList.add('stop');
    dom.sendButton.disabled = false;
    dom.sendButton.setAttribute('aria-label', 'Stop');
    dom.sendButton.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <rect x="6" y="6" width="12" height="12" rx="2" />
      </svg>`;
  } else {
    dom.sendButton.classList.remove('stop');
    dom.sendButton.setAttribute('aria-label', 'Send task');
    dom.sendButton.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <line x1="12" y1="19" x2="12" y2="5" />
        <polyline points="5 12 12 5 19 12" />
      </svg>`;
    // Re-evaluate disabled state based on input.
    const text = dom.inputTextarea.value.trim();
    dom.sendButton.disabled = text.length === 0 && newState === 'idle';
  }
}

// -------------------------------------------------------------------------
// Messages (user / agent / system)
// -------------------------------------------------------------------------

function dismissEmptyState() {
  if (state.emptyStateDismissed) { return; }
  state.emptyStateDismissed = true;
  dom.emptyState.style.display = 'none';
}

function appendUserMessage(text, timestamp) {
  dismissEmptyState();
  const el = renderMessage({
    role: 'user',
    name: 'You',
    timestamp: timestamp ?? Date.now(),
    bodyHtml: escapeHtml(text),
  });
  dom.messageList.appendChild(el);
  scrollToBottom();
}

function openStreamingAgentMessage(timestamp) {
  dismissEmptyState();
  const el = renderMessage({
    role: 'agent',
    name: 'Kovix',
    timestamp: timestamp ?? Date.now(),
    bodyHtml: '<span class="streaming-cursor" aria-hidden="true"></span>',
  });
  el.dataset.streaming = 'true';
  dom.messageList.appendChild(el);
  state.streamingBuffer = '';
  state.streamingOpen = true;
  scrollToBottom();
}

function appendStreamingToken(text) {
  if (!state.streamingOpen) {
    openStreamingAgentMessage(Date.now());
  }
  state.streamingBuffer += text;
  // Render incrementally — for v0.1 we treat the buffer as plain text
  // (no markdown parsing mid-stream; we re-render on close). This keeps
  // the streaming path cheap and avoids partial-markdown flicker.
  const bubble = dom.messageList.querySelector('.message.agent[data-streaming="true"] .bubble');
  if (bubble) {
    bubble.innerHTML = escapeHtml(state.streamingBuffer) + '<span class="streaming-cursor" aria-hidden="true"></span>';
  }
  scrollToBottom();
}

function closeStreamingAgentMessage() {
  const el = dom.messageList.querySelector('.message.agent[data-streaming="true"]');
  if (!el) {
    state.streamingOpen = false;
    return;
  }
  delete el.dataset.streaming;
  // Final render — convert markdown-lite to HTML.
  const bubble = el.querySelector('.bubble');
  if (bubble) {
    bubble.innerHTML = renderMarkdown(state.streamingBuffer);
  }
  state.streamingBuffer = '';
  state.streamingOpen = false;
  scrollToBottom();
}

function showThinking() {
  // If a streaming message is open, do nothing — the cursor already
  // signals activity. Otherwise, render a thinking-indicator chip.
  if (state.streamingOpen) { return; }
  dismissEmptyState();
  const el = document.createElement('div');
  el.className = 'message agent';
  el.setAttribute('aria-label', 'Kovix is thinking');
  el.innerHTML = `
    <div class="avatar" aria-hidden="true">K</div>
    <div class="body">
      <div class="header-row">
        <span class="name">Kovix</span>
      </div>
      <div class="thinking-indicator" role="status" aria-live="polite">
        <span class="dot"></span>
        <span class="dot"></span>
        <span class="dot"></span>
      </div>
    </div>`;
  el.dataset.transient = 'true';
  dom.messageList.appendChild(el);
  scrollToBottom();
}

function appendSystemMessage(text) {
  dismissEmptyState();
  const el = document.createElement('div');
  el.className = 'message system';
  el.innerHTML = `<div class="body"><div class="bubble">${escapeHtml(text)}</div></div>`;
  dom.messageList.appendChild(el);
  scrollToBottom();
}

function renderMessage({ role, name, timestamp, bodyHtml }) {
  const el = document.createElement('div');
  el.className = `message ${role}`;
  const time = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  el.innerHTML = `
    <div class="avatar" aria-hidden="true">${role === 'user' ? 'U' : role === 'agent' ? 'K' : '·'}</div>
    <div class="body">
      <div class="header-row">
        <span class="name">${escapeHtml(name)}</span>
        <span class="timestamp">${time}</span>
      </div>
      <div class="bubble">${bodyHtml}</div>
    </div>`;
  return el;
}

// -------------------------------------------------------------------------
// Plan card
// -------------------------------------------------------------------------

function showPlanCard(msg) {
  // Remove any transient thinking indicator.
  const transient = dom.messageList.querySelector('.message[data-transient="true"]');
  if (transient) { transient.remove(); }

  state.pendingPlan = msg;

  const el = document.createElement('div');
  el.className = 'plan-card';
  el.setAttribute('role', 'region');
  el.setAttribute('aria-label', 'Agent plan awaiting approval');

  const milestoneHtml = (msg.milestones || []).map((m) => {
    const steps = (m.steps || []).map((s) => `
      <div class="plan-step">
        <span class="step-index">${s.index}.</span>
        <span class="step-action">${escapeHtml(s.action)}</span>
        <span class="step-target">${escapeHtml(s.target)}</span>
      </div>`).join('');
    return `
      <div class="milestone-block">
        <div class="milestone-name">${escapeHtml(m.name)}</div>
        ${steps}
      </div>`;
  }).join('<div class="plan-divider"></div>');

  el.innerHTML = `
    <div class="plan-label">Proposed Plan</div>
    <div class="plan-task">${escapeHtml(msg.task)}</div>
    <div class="plan-divider"></div>
    ${milestoneHtml}
    <div class="plan-divider"></div>
    <div class="plan-actions">
      <div class="autonomy-select">
        <label for="autonomy-select">Autonomy</label>
        <select id="autonomy-select">
          <option value="every_milestone">Every Milestone — pause at each</option>
          <option value="major_milestone" selected>Major Milestone — pause at major changes</option>
          <option value="selective">Selective — pause at user-picked</option>
          <option value="full_auto">Full Auto — no pauses</option>
        </select>
      </div>
      <button type="button" class="cancel-button">Cancel</button>
      <button type="button" class="approve-button">Approve &amp; Run</button>
    </div>`;

  dom.messageList.appendChild(el);
  scrollToBottom();

  el.querySelector('.approve-button').addEventListener('click', () => {
    const mode = el.querySelector('#autonomy-select').value;
    vscode.postMessage({ type: 'approvePlan', executionMode: mode });
    // Remove the plan card; the host will start streaming events.
    el.remove();
    state.pendingPlan = null;
  });
  el.querySelector('.cancel-button').addEventListener('click', () => {
    vscode.postMessage({ type: 'cancelPlan' });
    el.remove();
    state.pendingPlan = null;
  });
}

// -------------------------------------------------------------------------
// Tool calls
// -------------------------------------------------------------------------

function onToolStart(msg) {
  // Remove any transient thinking indicator.
  const transient = dom.messageList.querySelector('.message[data-transient="true"]');
  if (transient) { transient.remove(); }

  // Tool cards attach to the most recent agent message. If no agent
  // message is open, append a system message and attach there.
  let parent = dom.messageList.querySelector('.message.agent:last-of-type .body');
  if (!parent) {
    appendSystemMessage(`▸ ${msg.toolName}`);
    return;
  }
  // If a streaming message is still open, close it first.
  if (state.streamingOpen) {
    closeStreamingAgentMessage();
    parent = dom.messageList.querySelector('.message.agent:last-of-type .body');
  }

  const card = document.createElement('div');
  card.className = 'tool-card';
  card.dataset.toolId = msg.toolId;
  card.innerHTML = `
    <div class="tool-header" role="button" tabindex="0" aria-expanded="true">
      <span class="chevron" aria-hidden="true">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </span>
      <span class="tool-name">${escapeHtml(msg.toolName)}</span>
      <span class="tool-status">
        <span class="chip info">running</span>
      </span>
    </div>
    <div class="tool-detail" role="region">waiting for input…</div>`;

  parent.appendChild(card);
  state.openToolCards.set(msg.toolId, card);

  // Click to toggle.
  card.querySelector('.tool-header').addEventListener('click', () => {
    card.classList.toggle('collapsed');
    const expanded = !card.classList.contains('collapsed');
    card.querySelector('.tool-header').setAttribute('aria-expanded', String(expanded));
  });
  card.querySelector('.tool-header').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      card.querySelector('.tool-header').click();
    }
  });

  scrollToBottom();
}

function onToolInput(msg) {
  const card = state.openToolCards.get(msg.toolId);
  if (!card) { return; }
  const detail = card.querySelector('.tool-detail');
  if (detail) {
    detail.textContent = msg.text || '(no input)';
  }
  scrollToBottom();
}

function onToolEnd(msg) {
  const card = state.openToolCards.get(msg.toolId);
  if (!card) {
    // Tool ended but we never saw a start — emit a compact card.
    return;
  }
  state.openToolCards.delete(msg.toolId);

  const status = card.querySelector('.tool-status');
  const duration = msg.durationMs != null ? `${(msg.durationMs / 1000).toFixed(1)}s` : '';
  const chipClass = msg.success ? 'success' : 'error';
  const chipText = msg.success ? '✓ success' : '✗ failed';
  status.innerHTML = `<span class="chip ${chipClass}">${chipText}</span>${duration ? `<span>${duration}</span>` : ''}`;

  const detail = card.querySelector('.tool-detail');
  if (detail && msg.result) {
    // Truncate very long outputs to keep the panel readable.
    const max = 4096;
    const out = msg.result.length > max
      ? msg.result.slice(0, max) + `\n\n… (truncated; ${msg.result.length - max} more chars)`
      : msg.result;
    detail.textContent = out;
  }

  scrollToBottom();
}

// -------------------------------------------------------------------------
// Milestone + verification
// -------------------------------------------------------------------------

function onMilestonePaused(milestone) {
  state.pausedMilestone = milestone;
  dom.milestoneLabel.textContent = `Paused at milestone: ${milestone.name}`;
  dom.milestoneBanner.hidden = false;
  setAgentState('paused');
}

function onMilestoneResumed(milestone) {
  state.pausedMilestone = null;
  dom.milestoneBanner.hidden = true;
  appendSystemMessage(`▸ Resumed: ${milestone.name}`);
}

function appendVerificationResult(msg) {
  const chipClass = msg.unverified ? 'warning' : (msg.passed ? 'success' : 'error');
  const chipText = msg.unverified ? '? unverified' : (msg.passed ? '✓ verified' : '✗ failed');
  const el = document.createElement('div');
  el.className = 'message system';
  el.innerHTML = `<div class="body"><div class="bubble">
    <span class="chip ${chipClass}">${chipText}</span>
    ${msg.output ? `<pre>${escapeHtml(msg.output.slice(0, 1024))}</pre>` : ''}
  </div></div>`;
  dom.messageList.appendChild(el);
  scrollToBottom();
}

// -------------------------------------------------------------------------
// Pending changes
// -------------------------------------------------------------------------

function onFileWritten(msg) {
  // Add to pending entries if not already present.
  const exists = state.pendingEntries.some((e) => e.filePath === msg.filePath);
  if (!exists) {
    state.pendingEntries.push({ filePath: msg.filePath, isNew: msg.isNew });
  }
  renderPendingList();
  // Auto-expand the section on first write.
  if (state.pendingEntries.length === 1) {
    dom.pendingSection.classList.remove('collapsed');
    dom.pendingHeader.setAttribute('aria-expanded', 'true');
  }
  dom.pendingSection.hidden = false;
}

function onPendingChanges(entries) {
  state.pendingEntries = entries.slice();
  renderPendingList();
  dom.pendingSection.hidden = entries.length === 0;
}

function renderPendingList() {
  dom.pendingCount.textContent = String(state.pendingEntries.length);
  dom.pendingList.innerHTML = '';
  for (const entry of state.pendingEntries) {
    const el = document.createElement('div');
    el.className = 'pending-entry';
    el.dataset.filePath = entry.filePath;
    el.innerHTML = `
      <span class="action-badge ${entry.isNew ? 'new' : 'edit'}">${entry.isNew ? 'new' : 'edit'}</span>
      <span class="file-path" title="${escapeHtml(entry.filePath)}">${escapeHtml(entry.filePath)}</span>
      <div class="entry-actions">
        <button type="button" class="diff" title="View diff">View</button>
        <button type="button" class="reject" title="Discard">Reject</button>
        <button type="button" class="accept" title="Write to disk">Accept</button>
      </div>`;
    el.querySelector('.accept').addEventListener('click', () => {
      vscode.postMessage({ type: 'acceptPending', filePath: entry.filePath });
    });
    el.querySelector('.reject').addEventListener('click', () => {
      vscode.postMessage({ type: 'rejectPending', filePath: entry.filePath });
    });
    el.querySelector('.diff').addEventListener('click', () => {
      vscode.postMessage({ type: 'viewDiff', filePath: entry.filePath });
    });
    dom.pendingList.appendChild(el);
  }
}

function onPendingChangeResolved(filePath, resolution) {
  state.pendingEntries = state.pendingEntries.filter((e) => e.filePath !== filePath);
  renderPendingList();
  if (state.pendingEntries.length === 0) {
    dom.pendingSection.hidden = true;
  }
  appendSystemMessage(`▸ ${resolution === 'accepted' ? 'Accepted' : 'Rejected'}: ${filePath}`);
}

// -------------------------------------------------------------------------
// Complete + error
// -------------------------------------------------------------------------

function onComplete(summary) {
  // Close any open streaming message.
  if (state.streamingOpen) {
    closeStreamingAgentMessage();
  }
  // Append the final summary as an agent message.
  const el = renderMessage({
    role: 'agent',
    name: 'Kovix',
    timestamp: Date.now(),
    bodyHtml: `<p><strong>Done.</strong></p>${renderMarkdown(summary)}`,
  });
  dom.messageList.appendChild(el);
  setAgentState('complete');
  scrollToBottom();
}

function onError(text, recoverable) {
  if (state.streamingOpen) {
    closeStreamingAgentMessage();
  }
  const el = document.createElement('div');
  el.className = 'message system';
  el.innerHTML = `<div class="body"><div class="error-message">${escapeHtml(text)}${recoverable ? '' : ' <em>(not recoverable)</em>'}</div></div>`;
  dom.messageList.appendChild(el);
  setAgentState('error');
  scrollToBottom();
}

function onCleared() {
  dom.messageList.innerHTML = '';
  // Re-show empty state.
  dom.messageList.appendChild(dom.emptyState);
  dom.emptyState.style.display = '';
  state.emptyStateDismissed = false;
  state.pendingEntries = [];
  dom.pendingSection.hidden = true;
  dom.milestoneBanner.hidden = true;
  setAgentState('idle');
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function scrollToBottom() {
  // Use requestAnimationFrame so layout settles before scrolling.
  requestAnimationFrame(() => {
    dom.messageList.scrollTop = dom.messageList.scrollHeight;
  });
}

function escapeHtml(text) {
  if (text == null) { return ''; }
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Minimal markdown renderer — supports the subset the agent actually
 * emits: paragraphs, code spans, code blocks, bold, italics, unordered
 * lists, ordered lists, headings (## and ###). No HTML passthrough.
 *
 * We deliberately keep this small. The agent's output is LLM-generated
 * markdown; we don't need a full CommonMark parser.
 */
function renderMarkdown(text) {
  if (!text) { return ''; }
  // Escape first, then re-introduce markdown.
  let s = escapeHtml(text);

  // Code blocks (```...```)
  s = s.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => {
    return `<pre><code>${code.replace(/\n$/, '')}</code></pre>`;
  });

  // Inline code
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // Bold
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  // Italics (single * not part of **)
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');

  // Headings
  s = s.replace(/^### (.+)$/gm, '<h4>$1</h4>');
  s = s.replace(/^## (.+)$/gm, '<h3>$1</h3>');
  s = s.replace(/^# (.+)$/gm, '<h3>$1</h3>');

  // Unordered lists
  s = s.replace(/^(?:- |\* )(.+)$/gm, '<li>$1</li>');
  s = s.replace(/(<li>[\s\S]+?<\/li>)(?!\s*<li>)/g, (m) => `<ul>${m}</ul>`);

  // Ordered lists
  s = s.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

  // Paragraphs — split on double newline, wrap any block not already wrapped.
  const blocks = s.split(/\n\n+/);
  s = blocks.map((block) => {
    if (/^\s*<(pre|ul|ol|h\d|div|p|li)/.test(block)) {
      return block;
    }
    // Single newlines inside a paragraph → <br>.
    return `<p>${block.replace(/\n/g, '<br>')}</p>`;
  }).join('\n');

  return s;
}
