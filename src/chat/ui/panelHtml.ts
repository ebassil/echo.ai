// Panel webview UI (HTML/CSS/JS). Embedded as a module so no
// filesystem asset is needed at runtime: __dirname is unreliable in the
// Joplin plugin host.
export const PANEL_HTML: string = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
	:root {
		--bg: #ffffff;
		--bg-alt: #f4f5f7;
		--border: #d8dce2;
		--text: #1c1e21;
		--muted: #6b7280;
		--accent: #2f6fdb;
		--user-bg: #e8f0fe;
		--assistant-bg: #f4f5f7;
		--error: #c0392b;
	}
	@media (prefers-color-scheme: dark) {
		:root {
			--bg: #1e1e1e;
			--bg-alt: #2b2b2b;
			--border: #3f3f3f;
			--text: #e6e6e6;
			--muted: #9a9a9a;
			--accent: #6da2f0;
			--user-bg: #23334a;
			--assistant-bg: #2b2b2b;
			--error: #e06c5b;
		}
	}
	* { box-sizing: border-box; }
	html, body { height: 100%; margin: 0; }
	body {
		font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
		background: var(--bg);
		color: var(--text);
		font-size: 13px;
		display: flex;
		flex-direction: column;
		height: 100%;
	}
	button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		border: 1px solid var(--border);
		background: var(--bg);
		color: var(--text);
		border-radius: 4px;
		padding: 4px;
		line-height: 0;
	}
	button:hover { background: var(--assistant-bg); }
	button:active { background: var(--border); }
	header {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 4px 6px;
		border-bottom: 1px solid var(--border);
		background: var(--bg-alt);
	}
	header select { flex: 1; min-width: 60px; }
	details.settings {
		border-bottom: 1px solid var(--border);
		background: var(--bg-alt);
	}
	details.settings summary {
		cursor: pointer;
		padding: 4px 8px;
		color: var(--muted);
		user-select: none;
		list-style: none;
		display: flex;
		align-items: center;
		gap: 6px;
	}
	details.settings summary::-webkit-details-marker { display: none; }
	#controls {
		padding: 6px 8px;
		display: flex;
		flex-direction: column;
		gap: 6px;
		max-height: 40vh;
		overflow-y: auto;
	}
	#messages {
		flex: 0 1 auto;
		min-height: 0;
		overflow-y: auto;
		padding: 8px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.message {
		position: relative;
		max-width: 85%;
		padding: 8px 10px;
		border-radius: 8px;
		white-space: pre-wrap;
		word-break: break-word;
		line-height: 1.45;
	}
	.message.user { align-self: flex-end; background: var(--user-bg); }
	.message.assistant { align-self: flex-start; background: var(--assistant-bg); }
	.message.error {
		background: #fdecea;
		border: 1px solid #e74c3c;
	}
	.message.error .error-icon {
		position: absolute;
		top: 3px;
		right: 3px;
		border: none;
		background: transparent;
		color: #e74c3c;
		padding: 2px;
		line-height: 0;
		cursor: help;
	}
	@media (prefers-color-scheme: dark) {
		.message.error { background: #3b1f1c; border-color: #e06c5b; }
		.message.error .error-icon { color: #e06c5b; }
	}
	.message .role-label {
		font-size: 11px;
		color: var(--muted);
		display: block;
		margin-bottom: 2px;
	}
	.message.streaming::after {
		content: "";
		display: inline-block;
		width: 6px;
		height: 12px;
		margin-left: 2px;
		vertical-align: text-bottom;
		background: var(--accent);
		animation: blink 1s steps(2, start) infinite;
	}
	@keyframes blink { 50% { opacity: 0; } }
	a.citation {
		color: var(--accent);
		text-decoration: none;
		cursor: pointer;
		font-weight: 600;
	}
	a.citation:hover { text-decoration: underline; }
	.empty {
		color: var(--muted);
		padding: 6px 4px;
		text-align: center;
	}
	#error-banner {
		display: none;
		background: var(--error);
		color: #fff;
		padding: 5px 8px;
		font-size: 12px;
	}
	#error-banner.visible { display: block; }
	#input-row {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 6px;
		border-top: 1px solid var(--border);
		background: var(--bg-alt);
	}
	#input {
		flex: 1;
		resize: none;
		min-height: 34px;
		max-height: 160px;
		overflow-y: auto;
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 6px 8px;
		background: var(--bg);
		color: var(--text);
		font-family: inherit;
	}
	#stop-btn { display: none; }
	#stop-btn.visible { display: inline-flex; }
	.control-row {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.control-row label { color: var(--muted); flex: 0 0 110px; }
	.control-row input[type="text"], .control-row textarea, .control-row select {
		flex: 1;
		background: var(--bg);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: 4px;
		padding: 4px 6px;
		font-family: inherit;
	}
	.control-row textarea { min-height: 48px; resize: vertical; }
	.switch { display: inline-flex; align-items: center; gap: 4px; }
	.toggle-grid { display: flex; flex-wrap: wrap; gap: 2px 10px; }
	.toggle-grid label { color: var(--text); font-size: 12px; }
</style>
</head>
<body>
<header>
	<select id="conversation-select" title="Conversation"></select>
	<button id="new-conversation-btn" title="New conversation">
		<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
	</button>
	<button id="delete-conversation-btn" title="Delete conversation">
		<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
	</button>
</header>
<details class="settings" id="settings">
	<summary>
		<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
		Settings
	</summary>
	<div id="controls">
		<div class="control-row">
			<label>Title</label>
			<input type="text" id="title-input" placeholder="Conversation title" title="Rename this conversation">
		</div>
		<div class="control-row" id="model-row">
			<label>Model</label>
			<select id="model-select" title="Model for this conversation"></select>
		</div>
		<div class="control-row">
			<label>System prompt</label>
			<textarea id="system-prompt-input"></textarea>
		</div>
		<div class="control-row">
			<label>Notes on/off</label>
			<label class="switch"><input type="checkbox" id="notes-on"> Use notes as context</label>
		</div>
		<div class="control-row">
			<label>Retrievers</label>
			<div class="toggle-grid">
				<label><input type="checkbox" data-retriever="bm25"> BM25</label>
				<label><input type="checkbox" data-retriever="tfidf"> TF-IDF</label>
				<label><input type="checkbox" data-retriever="fuzzy"> Fuzzy</label>
				<label><input type="checkbox" data-retriever="dense"> Dense</label>
				<label><input type="checkbox" data-retriever="graph"> Graph</label>
				<label><input type="checkbox" id="graph-enabled"> Graph master</label>
			</div>
		</div>
	</div>
</details>
<div id="error-banner"></div>
<div id="messages"></div>
<div id="input-row">
	<textarea id="input" placeholder="Ask about your notes…" rows="1"></textarea>
	<button id="send-btn" title="Send">
		<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
	</button>
	<button id="stop-btn" title="Stop">
		<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="1"/></svg>
	</button>
	<button id="regenerate-btn" title="Regenerate last response">
		<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
	</button>
</div>
<script>
	'use strict';

	let state = null;
	let tokenBuffer = {};
	let currentErrorTimer = null;

	const messagesEl = document.getElementById('messages');
	const inputEl = document.getElementById('input');
	const sendBtn = document.getElementById('send-btn');
	const stopBtn = document.getElementById('stop-btn');
	const regenBtn = document.getElementById('regenerate-btn');
	const errorBanner = document.getElementById('error-banner');
	const selectEl = document.getElementById('conversation-select');
	const titleInput = document.getElementById('title-input');
	const modelRow = document.getElementById('model-row');
	const modelSelect = document.getElementById('model-select');
	const systemPromptInput = document.getElementById('system-prompt-input');
	const notesOnEl = document.getElementById('notes-on');
	const graphEnabledEl = document.getElementById('graph-enabled');

	function post(msg) {
		try {
			webviewApi.postMessage(msg);
		} catch (e) {
			console.error('echo chat: postMessage failed', e);
		}
	}

	function escapeHtml(text) {
		return String(text)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	function renderContent(text, citations) {
		let html = escapeHtml(text);
		for (const citation of citations || []) {
			const noteId = escapeHtml(citation.noteId);
			const title = escapeHtml(citation.title || '');
			html = html.split('[' + citation.index + ']').join(
				'<a class="citation" data-note="' + noteId + '" title="' + title + '">[' + citation.index + ']</a>'
			);
		}
		return html;
	}

	function sendCurrentText() {
		const text = inputEl.value.trim();
		if (!text) return;
		post({ type: 'send', text });
		inputEl.value = '';
		inputEl.style.height = '';
		errorBanner.classList.remove('visible');
	}

	function autoGrow() {
		inputEl.style.height = 'auto';
		inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
	}

	// ---- Event wiring (bound immediately so Enter/Send work even if a later
	// ---- render call throws in some environment).
	inputEl.addEventListener('input', autoGrow);

	inputEl.addEventListener('keydown', (event) => {
		const isEnter = event.key === 'Enter' || event.code === 'Enter';
		if (isEnter && !event.shiftKey) {
			event.preventDefault();
			sendCurrentText();
		}
	});

	sendBtn.addEventListener('click', sendCurrentText);
	stopBtn.addEventListener('click', () => post({ type: 'stop' }));
	regenBtn.addEventListener('click', () => post({ type: 'regenerate' }));

	notesOnEl.addEventListener('change', () => post({ type: 'toggles', notesOn: notesOnEl.checked }));
	graphEnabledEl.addEventListener('change', () => post({ type: 'toggles', graphEnabled: graphEnabledEl.checked }));
	document.querySelectorAll('[data-retriever]').forEach((el) => {
		el.addEventListener('change', () => {
			const toggles = {};
			toggles[el.dataset.retriever] = el.checked;
			post({ type: 'toggles', toggles });
		});
	});

	modelSelect.addEventListener('change', () => post({ type: 'model', model: modelSelect.value }));
	systemPromptInput.addEventListener('change', () => post({ type: 'systemPrompt', prompt: systemPromptInput.value }));
	titleInput.addEventListener('change', () => post({ type: 'renameConversation', title: titleInput.value }));

	selectEl.addEventListener('change', () => post({ type: 'selectConversation', conversationId: selectEl.value }));
	document.getElementById('new-conversation-btn').addEventListener('click', () => post({ type: 'newConversation' }));
	document.getElementById('delete-conversation-btn').addEventListener('click', () => {
		if (selectEl.value) post({ type: 'deleteConversation', conversationId: selectEl.value });
	});

	messagesEl.addEventListener('click', (event) => {
		const citation = event.target.closest('a.citation');
		if (citation && citation.dataset.note) post({ type: 'openCitation', noteId: citation.dataset.note });
	});

	// ---- Rendering.

	function renderMessages() {
		messagesEl.innerHTML = '';
		if (!state || state.messages.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'empty';
			empty.textContent = 'Start a conversation with your notes.';
			messagesEl.appendChild(empty);
			return;
		}
		for (const message of state.messages) {
			const el = document.createElement('div');
			el.className = 'message ' + (message.role === 'user' ? 'user' : 'assistant');
			if (message.status === 'streaming') el.classList.add('streaming');
			if (message.status === 'error') {
				el.classList.add('error');
				const errIcon = document.createElement('button');
				errIcon.type = 'button';
				errIcon.className = 'error-icon';
				errIcon.title = message.error || 'Message failed to send';
				errIcon.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>';
				el.appendChild(errIcon);
			}
			const label = document.createElement('span');
			label.className = 'role-label';
			label.textContent = message.role === 'user' ? 'You' : 'echo';
			el.appendChild(label);
			el.innerHTML += renderContent(message.content, message.citations);
			messagesEl.appendChild(el);
		}
		const last = state.messages[state.messages.length - 1];
		if (last && last.status === 'streaming' && tokenBuffer[last.seq]) {
			appendToLastAssistant(tokenBuffer[last.seq]);
			delete tokenBuffer[last.seq];
		}
		messagesEl.scrollTop = messagesEl.scrollHeight;
	}

	function appendToLastAssistant(delta) {
		const nodes = messagesEl.querySelectorAll('.message.assistant');
		const last = nodes[nodes.length - 1];
		if (!last) return;
		const text = last.textContent;
		last.innerHTML = '';
		last.innerHTML = renderContent(text + delta, state ? state.messages[state.messages.length - 1].citations : []);
		messagesEl.scrollTop = messagesEl.scrollHeight;
	}

	function renderConversations() {
		selectEl.innerHTML = '';
		const conversations = (state.conversations || []).slice();
		if (conversations.length === 0 && state.conversationId) {
			conversations.push({ id: state.conversationId, title: state.title, updatedAt: '' });
		}
		for (const conversation of conversations) {
			const option = document.createElement('option');
			option.value = conversation.id;
			option.textContent = conversation.title || 'New conversation';
			if (conversation.id === state.conversationId) option.selected = true;
			selectEl.appendChild(option);
		}
	}

	function renderModel() {
		const models = (state.models || []).filter(Boolean);
		if (models.length > 1) {
			modelRow.style.display = '';
			const options = models.slice();
			if (state.model && options.indexOf(state.model) < 0) options.unshift(state.model);
			modelSelect.innerHTML = '';
			for (const model of options) {
				const option = document.createElement('option');
				option.value = model;
				option.textContent = model;
				if (model === state.model) option.selected = true;
				modelSelect.appendChild(option);
			}
		} else {
			// Single (or unknown) model: nothing to choose, hide the selector.
			modelRow.style.display = 'none';
		}
	}

	function renderControls() {
		titleInput.value = state.title || '';
		renderModel();
		notesOnEl.checked = state.notesOn;
		graphEnabledEl.checked = state.retrievalToggles.graphEnabled;
		for (const key of ['bm25', 'tfidf', 'fuzzy', 'dense', 'graph']) {
			const el = document.querySelector('[data-retriever="' + key + '"]');
			if (el) el.checked = state.retrievalToggles[key];
		}
		systemPromptInput.value = state.systemPrompt || '';
	}

	function render() {
		renderConversations();
		renderMessages();
		renderControls();
		stopBtn.classList.toggle('visible', !!(state && state.streaming));
	}

	function showError(message) {
		errorBanner.textContent = message || '';
		errorBanner.classList.toggle('visible', !!message);
		clearTimeout(currentErrorTimer);
		if (message) currentErrorTimer = setTimeout(() => errorBanner.classList.remove('visible'), 6000);
	}

	function onToken(msg) {
		if (!state || state.messages.length === 0) {
			tokenBuffer[msg.seq] = (tokenBuffer[msg.seq] || '') + msg.delta;
			return;
		}
		const last = state.messages[state.messages.length - 1];
		if (last && last.seq === msg.seq && last.status === 'streaming') {
			last.content += msg.delta;
			appendToLastAssistant(msg.delta);
		} else {
			tokenBuffer[msg.seq] = (tokenBuffer[msg.seq] || '') + msg.delta;
		}
	}

	webviewApi.onMessage((message) => {
		if (!message || !message.type) return;
		switch (message.type) {
			case 'snapshot':
				state = message.snapshot;
				render();
				break;
			case 'token':
				onToken(message);
				break;
			case 'status':
				if (message.error) showError(message.error);
				stopBtn.classList.toggle('visible', message.status === 'streaming');
				break;
		}
	});

	post({ type: 'init' });
</script>
</body>
</html>`;