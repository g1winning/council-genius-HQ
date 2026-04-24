/* Council Genius PWA — client runtime.
 *
 * Three-screen SPA (splash → picker → chat). State lives in one object.
 * No framework — vanilla DOM APIs, ~12 KB of JS.
 *
 * API contract: POST /c/{slug}/chat with {messages: [...]} → {reply, reply_with_tags?, meta}.
 * POST /c/{slug}/feedback with {rating, query, response} → {ok: true}.
 * GET /api/councils → {schema_version, councils: [{slug, display_name, state, postcodes, status, ...}]}.
 */

(() => {
  'use strict';

  // ── Config ──────────────────────────────────────────────────────────
  const API_BASE = document.querySelector('meta[name="cg-api-base"]')?.content || '';
  const SESSION_ID = crypto.randomUUID();

  // ── State ───────────────────────────────────────────────────────────
  const state = {
    screen: 'splash',              // splash | picker | chat
    council: null,                 // selected registry row
    postcode: null,                // non-null when picker used postcode tab
    messages: [],                  // [{role, content}, ...] — the Anthropic-style history
    councils: [],                  // loaded from /api/councils
    busy: false,                   // true while awaiting /chat reply
  };

  // ── DOM refs ────────────────────────────────────────────────────────
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const el = {
    screens: {
      splash: $('#screen-splash'),
      picker: $('#screen-picker'),
      chat: $('#screen-chat'),
    },
    btnStart: $('#btn-start'),
    btnSwitch: $('#btn-switch'),
    tabs: $$('.picker-tab'),
    panels: $$('.picker-panel'),
    inputSearch: $('#input-search'),
    inputPostcode: $('#input-postcode'),
    listSearch: $('#list-search'),
    listPostcode: $('#list-postcode'),
    listBrowse: $('#list-browse'),
    hintSearch: $('#hint-search'),
    hintPostcode: $('#hint-postcode'),
    chatCouncil: $('#chat-council-name'),
    chatDomain: $('#chat-domain'),
    chatArea: $('#chat-area'),
    chatForm: $('#chat-form'),
    chatInput: $('#chat-input'),
    btnSend: $('#btn-send'),
    installHint: $('#install-hint-ios'),
  };

  // ── Screen routing ──────────────────────────────────────────────────
  function show(screenName) {
    state.screen = screenName;
    for (const [name, node] of Object.entries(el.screens)) {
      if (name === screenName) node.removeAttribute('hidden');
      else node.setAttribute('hidden', '');
    }
    if (screenName === 'chat') setTimeout(() => el.chatInput.focus(), 50);
  }

  // ── Council loading ─────────────────────────────────────────────────
  async function loadCouncils() {
    try {
      const resp = await fetch(`${API_BASE}/api/councils`, { cache: 'no-cache' });
      const data = await resp.json();
      state.councils = (data.councils || []).filter(c => c.status !== 'paused');
      renderBrowse();
    } catch (e) {
      state.councils = [];
      console.error('[councils] load failed', e);
    }
  }

  // ── Render helpers ──────────────────────────────────────────────────
  function councilItem(c) {
    const li = document.createElement('li');
    li.className = 'council-item';
    li.tabIndex = 0;
    li.dataset.slug = c.slug;

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = c.display_name;
    if (c.status === 'beta') {
      const badge = document.createElement('span');
      badge.className = 'badge-beta';
      badge.textContent = 'BETA';
      name.appendChild(badge);
    }

    const state_ = document.createElement('span');
    state_.className = 'state';
    state_.textContent = c.state;

    li.appendChild(name);
    li.appendChild(state_);

    const choose = () => selectCouncil(c, /* viaPostcode */ state.postcode);
    li.addEventListener('click', choose);
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); }
    });
    return li;
  }

  function renderSearch(query) {
    const q = (query || '').trim().toLowerCase();
    el.listSearch.innerHTML = '';
    if (!q) {
      el.hintSearch.textContent = 'Start typing to see matching councils.';
      return;
    }
    const matches = state.councils.filter(c =>
      c.display_name.toLowerCase().includes(q)
    );
    if (matches.length === 0) {
      el.hintSearch.textContent = `No matches for "${query}". Try Postcode or Browse.`;
      return;
    }
    el.hintSearch.textContent = `${matches.length} match${matches.length === 1 ? '' : 'es'}`;
    matches.forEach(c => el.listSearch.appendChild(councilItem(c)));
  }

  function renderPostcode(pc) {
    const p = (pc || '').trim();
    el.listPostcode.innerHTML = '';
    if (p.length !== 4 || !/^\d{4}$/.test(p)) {
      el.hintPostcode.textContent = 'Enter a 4-digit postcode.';
      return;
    }
    const matches = state.councils.filter(c => (c.postcodes || []).includes(p));
    if (matches.length === 0) {
      el.hintPostcode.textContent = `No councils for postcode ${p} yet. Try Search or Browse.`;
      return;
    }
    el.hintPostcode.textContent = `Councils covering ${p}`;
    state.postcode = p;  // remember for logging on council select
    matches.forEach(c => el.listPostcode.appendChild(councilItem(c)));
  }

  function renderBrowse() {
    el.listBrowse.innerHTML = '';
    if (state.councils.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty-state';
      li.textContent = 'No councils available yet.';
      el.listBrowse.appendChild(li);
      return;
    }
    const sorted = state.councils.slice().sort((a, b) =>
      a.display_name.localeCompare(b.display_name)
    );
    sorted.forEach(c => el.listBrowse.appendChild(councilItem(c)));
  }

  // ── Council selection → go to chat ──────────────────────────────────
  function selectCouncil(c, postcode) {
    state.council = c;
    state.messages = [];
    el.chatCouncil.textContent = c.display_name;
    el.chatDomain.textContent = inferDomain(c);
    el.chatArea.innerHTML = '';
    el.chatInput.value = '';
    appendBotMessage(
      `Hi! I can answer questions about ${c.display_name}. What would you like to know?`,
      { skipFeedback: true }
    );
    show('chat');
  }

  function inferDomain(c) {
    // councils.json doesn't carry the domain — infer from slug for the banner.
    const map = {
      strathbogie: 'strathbogie.vic.gov.au',
      melbourne: 'melbourne.vic.gov.au',
      melton: 'melton.vic.gov.au',
    };
    return map[c.slug] || 'council-published sources';
  }

  // ── Chat rendering ──────────────────────────────────────────────────
  function renderMarkdown(text) {
    // Minimal markdown: **bold**, [label](url), newlines.
    const escape = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    let html = escape(text);
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, label, url) => {
      const safeUrl = /^(https?:|tel:|mailto:)/i.test(url) ? url : '#';
      const target = /^https?:/i.test(safeUrl) ? ' target="_blank" rel="noopener"' : '';
      return `<a href="${safeUrl}"${target}>${label}</a>`;
    });
    html = html.replace(/\n/g, '<br>');
    return html;
  }

  function appendUserMessage(text) {
    const div = document.createElement('div');
    div.className = 'msg msg-user';
    div.textContent = text;
    el.chatArea.appendChild(div);
    scrollChatToBottom();
  }

  function appendBotMessage(text, { skipFeedback = false, error = false } = {}) {
    const div = document.createElement('div');
    div.className = 'msg msg-bot' + (error ? ' msg-error' : '');
    div.innerHTML = renderMarkdown(text);
    el.chatArea.appendChild(div);

    if (!skipFeedback && !error) {
      const actions = document.createElement('div');
      actions.className = 'msg-actions';

      const up = document.createElement('button');
      up.className = 'thumb';
      up.type = 'button';
      up.setAttribute('aria-label', 'Helpful');
      up.textContent = '👍';

      const down = document.createElement('button');
      down.className = 'thumb';
      down.type = 'button';
      down.setAttribute('aria-label', 'Not helpful');
      down.textContent = '👎';

      const submitFeedback = (rating, btn) => {
        up.disabled = true; down.disabled = true;
        btn.classList.add('selected');
        sendFeedback(rating, text);
      };
      up.addEventListener('click', () => submitFeedback('up', up));
      down.addEventListener('click', () => submitFeedback('down', down));

      actions.appendChild(up);
      actions.appendChild(down);
      el.chatArea.appendChild(actions);
    }

    scrollChatToBottom();
  }

  function appendTypingIndicator() {
    const div = document.createElement('div');
    div.className = 'typing-indicator';
    div.id = 'typing-indicator';
    div.textContent = 'Thinking…';
    el.chatArea.appendChild(div);
    scrollChatToBottom();
  }

  function removeTypingIndicator() {
    const t = document.getElementById('typing-indicator');
    if (t) t.remove();
  }

  function scrollChatToBottom() {
    el.chatArea.scrollTop = el.chatArea.scrollHeight;
  }

  // ── API calls ───────────────────────────────────────────────────────
  async function sendChat(userText) {
    if (!state.council || state.busy) return;
    state.busy = true;
    el.btnSend.disabled = true;
    el.chatInput.disabled = true;

    state.messages.push({ role: 'user', content: userText });
    appendUserMessage(userText);
    appendTypingIndicator();

    const url = `${API_BASE}/c/${state.council.slug}/chat`
      + (state.postcode ? `?postcode=${encodeURIComponent(state.postcode)}` : '');

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Id': SESSION_ID,
        },
        body: JSON.stringify({ messages: state.messages }),
      });
      const data = await resp.json();
      removeTypingIndicator();

      if (!resp.ok || data.error) {
        appendBotMessage(data.error || `Server error (${resp.status}).`, { error: true });
      } else {
        // For RAG councils, reply_with_tags preserves meta tags for the next turn.
        const historyContent = data.reply_with_tags || data.reply || '';
        state.messages.push({ role: 'assistant', content: historyContent });
        appendBotMessage(data.reply || '(empty response)');
      }
    } catch (e) {
      removeTypingIndicator();
      appendBotMessage(`Network error: ${e.message}. Please try again.`, { error: true });
    } finally {
      state.busy = false;
      el.btnSend.disabled = false;
      el.chatInput.disabled = false;
      el.chatInput.focus();
    }
  }

  async function sendFeedback(rating, responseText) {
    if (!state.council) return;
    const lastUser = state.messages.slice().reverse().find(m => m.role === 'user');
    try {
      await fetch(`${API_BASE}/c/${state.council.slug}/feedback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Id': SESSION_ID,
        },
        body: JSON.stringify({
          rating,
          query: lastUser ? lastUser.content : '',
          response: responseText,
        }),
      });
    } catch (e) {
      console.warn('[feedback] failed', e);
    }
  }

  // ── Event wiring ────────────────────────────────────────────────────
  el.btnStart.addEventListener('click', () => show('picker'));

  el.btnSwitch.addEventListener('click', () => {
    state.postcode = null;
    show('picker');
  });

  el.tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      el.tabs.forEach(t => t.classList.toggle('active', t === tab));
      el.panels.forEach(p => {
        if (p.dataset.panel === target) p.removeAttribute('hidden');
        else p.setAttribute('hidden', '');
      });
    });
  });

  let searchDebounce;
  el.inputSearch.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => renderSearch(el.inputSearch.value), 120);
  });

  el.inputPostcode.addEventListener('input', () => {
    renderPostcode(el.inputPostcode.value);
  });

  el.chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = el.chatInput.value.trim();
    if (!text) return;
    el.chatInput.value = '';
    sendChat(text);
  });

  // iOS install hint: hide on non-iOS or when already in standalone.
  (function setupInstallHint() {
    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const inStandalone = window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone;
    if (!isIos || inStandalone) {
      el.installHint.hidden = true;
    }
  })();

  // Service worker registration (graceful fail — PWA still works without).
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('service-worker.js').catch(e => {
        console.warn('[sw] registration failed', e);
      });
    });
  }

  // ── Boot ────────────────────────────────────────────────────────────
  show('splash');
  loadCouncils();
})();
