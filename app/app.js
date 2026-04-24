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
    inputBrowse: $('#input-browse'),
    listBrowse: $('#list-browse'),
    hintBrowse: $('#hint-browse'),
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
      renderList('');
    } catch (e) {
      state.councils = [];
      el.hintBrowse.textContent = 'Could not load council list. Check your connection and retry.';
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

  // Single-input browse: accepts council name OR postcode in one field.
  // - Empty input: show all councils (alphabetical).
  // - All digits: match postcodes (prefix-friendly — "30" shows everything starting 30xx).
  // - Anything else: case-insensitive name substring.
  function renderList(query) {
    const q = (query || '').trim();
    const list = el.listBrowse;
    const hint = el.hintBrowse;
    list.innerHTML = '';

    if (state.councils.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty-state';
      li.textContent = 'No councils available yet.';
      list.appendChild(li);
      hint.textContent = '';
      return;
    }

    const sorted = state.councils.slice().sort((a, b) =>
      a.display_name.localeCompare(b.display_name)
    );

    if (!q) {
      state.postcode = null;
      hint.textContent = `${sorted.length} council${sorted.length === 1 ? '' : 's'} available.`;
      sorted.forEach(c => list.appendChild(councilItem(c)));
      return;
    }

    let matches;
    if (/^\d+$/.test(q)) {
      // Postcode prefix match
      matches = sorted.filter(c => (c.postcodes || []).some(p => p.startsWith(q)));
      state.postcode = q.length === 4 ? q : null;  // only log as postcode when full 4 digits
      if (matches.length === 0) {
        hint.textContent = `No councils found for postcode ${q}.`;
        return;
      }
      hint.textContent = matches.length === 1
        ? `1 council covers ${q}`
        : `${matches.length} councils cover ${q}`;
    } else {
      // Name substring
      const lower = q.toLowerCase();
      matches = sorted.filter(c => c.display_name.toLowerCase().includes(lower));
      state.postcode = null;
      if (matches.length === 0) {
        hint.textContent = `No councils match "${q}".`;
        return;
      }
      hint.textContent = matches.length === 1
        ? `1 match`
        : `${matches.length} matches`;
    }

    matches.forEach(c => list.appendChild(councilItem(c)));
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
  el.btnStart.addEventListener('click', () => {
    show('picker');
    setTimeout(() => el.inputBrowse.focus(), 50);
  });

  el.btnSwitch.addEventListener('click', () => {
    state.postcode = null;
    el.inputBrowse.value = '';
    renderList('');
    show('picker');
    setTimeout(() => el.inputBrowse.focus(), 50);
  });

  let browseDebounce;
  el.inputBrowse.addEventListener('input', () => {
    clearTimeout(browseDebounce);
    browseDebounce = setTimeout(() => renderList(el.inputBrowse.value), 100);
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
