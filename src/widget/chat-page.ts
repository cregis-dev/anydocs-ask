/**
 * RFC 0004 W3 alpha.2b — Widget iframe chat page.
 *
 * The page served at `GET /widget/chat`. The host-side SDK
 * ([[renderWidgetHostScript]]) creates an `<iframe src="…/widget/chat?…">`
 * pointing at this page, and the page talks back via postMessage.
 *
 * Scope (alpha.2b incremental):
 *   - SSE streaming via `/v1/ask/stream` (token-by-token answer rendering)
 *   - β feedback bar (👍 / 👎 + "答错了" correction)
 *   - History persistence in widget-namespaced localStorage
 *     (`anydocs-ask:widget:history:v1`) — same-origin iframe storage, NEVER
 *     touches host cookies/localStorage (RFC §5 Q3 + PRD §10.7 第 7 条)
 *
 * Out of scope (alpha.3+):
 *   - Cross-origin host → /v1/ask direct mode (chat-page is iframe-internal
 *     same-origin traffic and intentionally does NOT send `X-Project-Key`;
 *     adding it would trip the widget gate's `origin_not_allowed` check
 *     because the iframe's Origin is the ask server, not the host page's
 *     domain. Direct cross-origin SDK mode lands in 0.5+ Phase 4.)
 *   - Citation visual deduplication (use Reader's shared helper in a
 *     future polish PR)
 *   - Multi-turn within widget session (the server-side multi-turn logic
 *     already runs via the session_id round-trip; chat-page just preserves
 *     the id across turns)
 */

import type { PromptConfig } from '../config.ts';

export type RenderWidgetChatPageOptions = {
  prompt: PromptConfig;
};

export function renderWidgetChatPage(opts: RenderWidgetChatPageOptions): string {
  const assistantName = (opts.prompt.assistantName ?? 'Ask').replace(/[<>]/g, '');
  return CHAT_HTML.replaceAll('__TITLE__', escape(assistantName));
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

const CHAT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>__TITLE__</title>
<style>
:root {
  --bg: #fff;
  --bg-soft: #f6f6f3;
  --bd: #e3e3df;
  --bd-soft: #ecedea;
  --fg: #1a1a17;
  --fg-soft: #5a5b56;
  --fg-mute: #8a8b85;
  --accent: #2747c4;
  --ok: #1f7a3a;
  --warn: #8a5a00;
  --err: #b41f2a;
  --err-soft: #fbe6e6;
  --font: ui-sans-serif, system-ui, -apple-system, "Helvetica Neue", "PingFang SC", sans-serif;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; height: 100%; background: var(--bg); color: var(--fg); font-family: var(--font); font-size: 14px; }
.app { display: flex; flex-direction: column; height: 100%; }
.hd { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid var(--bd-soft); font-weight: 600; }
.hd .ti { font-size: 14px; }
.hd .ctx { font-size: 11px; color: var(--fg-mute); font-weight: 400; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.body { flex: 1; overflow-y: auto; padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
.empty { color: var(--fg-mute); font-size: 13px; text-align: center; padding: 24px 12px; }
.turn { display: flex; flex-direction: column; gap: 4px; }
.q { background: var(--bg-soft); padding: 8px 10px; border-radius: 8px; align-self: flex-end; max-width: 90%; }
.a { background: #fff; border: 1px solid var(--bd-soft); padding: 8px 10px; border-radius: 8px; align-self: flex-start; max-width: 95%; white-space: pre-wrap; }
.a.loading { color: var(--fg-mute); font-style: italic; }
.a.err { background: var(--err-soft); border-color: var(--err); color: var(--err); }
.cit { font-size: 11px; color: var(--fg-soft); margin-top: 4px; display: flex; flex-direction: column; gap: 2px; }
.cit a { color: var(--accent); text-decoration: none; }
.cit a:hover { text-decoration: underline; }
.fb { display: flex; gap: 6px; margin-top: 6px; font-size: 11px; align-items: center; flex-wrap: wrap; }
.fb button {
  border: 1px solid var(--bd); background: #fff; cursor: pointer;
  padding: 2px 8px; border-radius: 6px; font: inherit; font-size: 11px; line-height: 1.4;
  color: var(--fg-soft);
}
.fb button:hover { background: var(--bg-soft); color: var(--fg); }
.fb button.sel-up { background: #e6f1e7; border-color: var(--ok); color: var(--ok); }
.fb button.sel-down { background: var(--err-soft); border-color: var(--err); color: var(--err); }
.fb button:disabled { opacity: 0.5; cursor: default; }
.fb .corr { display: flex; gap: 4px; width: 100%; margin-top: 4px; }
.fb .corr input {
  flex: 1; border: 1px solid var(--bd); padding: 4px 6px; border-radius: 6px;
  font: inherit; font-size: 11px;
}
.fb .corr input:focus { border-color: var(--accent); outline: none; }
.composer { display: flex; gap: 6px; padding: 10px 12px; border-top: 1px solid var(--bd-soft); }
.composer textarea {
  flex: 1; resize: none; border: 1px solid var(--bd); border-radius: 8px;
  padding: 8px 10px; font: inherit; outline: none; min-height: 38px; max-height: 120px;
}
.composer textarea:focus { border-color: var(--accent); }
.composer button {
  border: 0; background: var(--fg); color: #fff; border-radius: 8px;
  padding: 0 14px; font: inherit; cursor: pointer; min-width: 56px;
}
.composer button:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
</head>
<body>
<div class="app">
  <div class="hd">
    <span class="ti">__TITLE__</span>
    <span class="ctx" id="ctx-line" title=""></span>
  </div>
  <div class="body" id="body">
    <div class="empty" id="empty">Ask a question to get started.</div>
  </div>
  <div class="composer">
    <textarea id="q" rows="1" placeholder="Ask a question…"></textarea>
    <button type="button" id="send">Send</button>
  </div>
</div>
<script>
(function () {
  'use strict';
  var PROTOCOL = 'anydocs-ask';
  var VERSION = 1;
  // alpha.2b — widget-scoped localStorage namespace; never touches the host
  // page's storage (PRD §10.7 第 7 条 / RFC §5 Q3). The iframe origin is
  // the ask server, so this storage is isolated from the embedding host.
  var STORE_KEY = 'anydocs-ask:widget:history:v1';
  var STORE_MAX_TURNS = 20;

  function $(id) { return document.getElementById(id); }
  function post(payload) {
    if (!window.parent || window.parent === window) return;
    var msg = Object.assign({ protocol: PROTOCOL, version: VERSION }, payload);
    // Same-origin alpha.x — '*' is documented (RFC §4.4 alpha.3 will narrow
    // to the parent baseUrl once the host SDK passes it via init).
    window.parent.postMessage(msg, '*');
  }

  var params = new URLSearchParams(location.search);
  var projectKey = params.get('projectKey') || '';
  var contextSources = (params.get('contextSources') || 'url,title').split(',').filter(Boolean);

  var hostContext = null; // last setContext payload from parent
  var sessionId = null;
  var turns = []; // { q, a, citations, answerId, fb? }

  function loadStored() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      if (!Array.isArray(parsed.turns)) return null;
      return parsed;
    } catch (_e) { return null; }
  }
  function saveStored() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        sessionId: sessionId,
        turns: turns.slice(-STORE_MAX_TURNS),
      }));
    } catch (_e) { /* quota / private mode — silent */ }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;'
        : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;';
    });
  }

  function renderCtxLine() {
    var el = $('ctx-line');
    if (!hostContext) { el.textContent = ''; el.title = ''; return; }
    var bits = [];
    if (hostContext.page) bits.push(hostContext.page);
    if (hostContext.topic) bits.push(hostContext.topic);
    var text = bits.join(' · ');
    el.textContent = text;
    el.title = text;
  }

  function startTurn(q) {
    var empty = $('empty');
    if (empty && empty.parentNode) empty.parentNode.removeChild(empty);
    var wrap = document.createElement('div');
    wrap.className = 'turn';
    var qEl = document.createElement('div');
    qEl.className = 'q';
    qEl.textContent = q;
    var aEl = document.createElement('div');
    aEl.className = 'a loading';
    aEl.textContent = '';
    wrap.appendChild(qEl);
    wrap.appendChild(aEl);
    $('body').appendChild(wrap);
    return { wrap: wrap, aEl: aEl };
  }

  function appendCitations(aEl, citations) {
    if (!Array.isArray(citations) || citations.length === 0) return;
    var cit = document.createElement('div');
    cit.className = 'cit';
    citations.forEach(function (c, i) {
      var line = document.createElement('div');
      var n = i + 1;
      var title = c.title || c.page_id || '';
      if (c.url) {
        var a = document.createElement('a');
        a.href = c.url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = n + '. ' + title;
        a.addEventListener('click', function (e) {
          e.preventDefault();
          post({ kind: 'navigate', href: c.url, target: '_blank' });
        });
        line.appendChild(a);
      } else {
        line.textContent = n + '. ' + title;
      }
      cit.appendChild(line);
    });
    aEl.appendChild(cit);
  }

  function appendFeedbackBar(turnIdx, aEl, answerId) {
    // alpha.2b β feedback. Three actions: 👍 / 👎 / 答错了 (correction).
    // POST /v1/ask/feedback with rating + optional correction; once
    // submitted the buttons are sticky (re-click does nothing — alpha.2b
    // doesn't yet support "change my mind").
    var bar = document.createElement('div');
    bar.className = 'fb';
    var up = document.createElement('button');
    up.type = 'button';
    up.textContent = '👍 helpful';
    var down = document.createElement('button');
    down.type = 'button';
    down.textContent = '👎 not helpful';
    var fix = document.createElement('button');
    fix.type = 'button';
    fix.textContent = 'answered wrong…';
    bar.appendChild(up);
    bar.appendChild(down);
    bar.appendChild(fix);

    var locked = false;
    function lockButtons() {
      locked = true;
      up.disabled = true; down.disabled = true; fix.disabled = true;
    }
    function submit(rating, correction) {
      if (locked) return;
      var body = {
        answer_id: answerId,
        session_id: sessionId,
        rating: rating,
      };
      if (typeof correction === 'string' && correction.length > 0) {
        body.correction = correction;
      }
      // Note: NOT sending X-Project-Key. Same-origin iframe traffic; the
      // widget gate is reserved for direct cross-origin SDK calls in 0.5+
      // Phase 4. Sending X-Project-Key here would trip 'origin_not_allowed'
      // because the iframe Origin is the ask server, not the host page.
      fetch('/v1/ask/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).catch(function () { /* fire-and-forget */ });
      if (turns[turnIdx]) turns[turnIdx].fb = { rating: rating, correction: correction || null };
      saveStored();
      lockButtons();
      if (rating > 0) up.classList.add('sel-up');
      else if (rating < 0) down.classList.add('sel-down');
    }
    up.addEventListener('click', function () { submit(1); });
    down.addEventListener('click', function () { submit(-1); });
    fix.addEventListener('click', function () {
      if (locked) return;
      // Inline correction box. Submitting blank just sends rating=-1 with
      // no correction so we still capture the negative signal.
      var box = document.createElement('div');
      box.className = 'corr';
      var input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'What did the answer get wrong? (optional)';
      var go = document.createElement('button');
      go.type = 'button';
      go.textContent = 'send';
      box.appendChild(input);
      box.appendChild(go);
      bar.appendChild(box);
      input.focus();
      function sendCorr() { submit(-1, input.value.trim()); }
      go.addEventListener('click', sendCorr);
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); sendCorr(); }
      });
    });
    aEl.appendChild(bar);
  }

  function finalizeAnswer(turnIdx, wrap, aEl, result, accumulated) {
    aEl.classList.remove('loading');
    if (!result || result.type === 'error') {
      aEl.classList.add('err');
      aEl.textContent = (result && (result.message || result.code)) || 'Request failed.';
      return;
    }
    if (result.type === 'clarify') {
      aEl.textContent = result.message || 'Please clarify your question.';
      return;
    }
    // type === 'answer'. The SSE deltas already painted the body; result
    // carries the final answer_md (canonical) + citations.
    aEl.textContent = result.answer_md || accumulated || '';
    appendCitations(aEl, result.citations);
    if (result.answer_id) {
      appendFeedbackBar(turnIdx, aEl, result.answer_id);
    }
    if (turns[turnIdx]) {
      turns[turnIdx].a = result.answer_md || '';
      turns[turnIdx].citations = result.citations || [];
      turns[turnIdx].answerId = result.answer_id || null;
      saveStored();
    }
  }

  function reportError(code, message, status) {
    post({ kind: 'error', error: { code: code, message: message, status: status } });
  }

  function parseSseFrame(frame) {
    // SSE per RFC 7693-ish. Minimal parser — only need 'event' + 'data'.
    var event = 'message';
    var data = '';
    var lines = frame.split(/\\r?\\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += (data ? '\\n' : '') + line.slice(5).trim();
    }
    return { event: event, data: data };
  }

  async function send() {
    var qEl = $('q');
    var question = (qEl.value || '').trim();
    if (!question) return;
    qEl.value = '';
    qEl.disabled = true;
    $('send').disabled = true;

    var turn = startTurn(question);
    var turnIdx = turns.length;
    turns.push({ q: question, a: '', citations: [], answerId: null });
    saveStored();

    var body = {
      question: question,
      session_id: sessionId,
      context: {},
    };
    if (hostContext) {
      body.context.widget = {
        host: { page: hostContext.page || undefined, topic: hostContext.topic || undefined },
        data: hostContext.data || undefined,
      };
    }
    var accumulated = '';
    var lastResult = null;

    try {
      var res = await fetch('/v1/ask/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok || !res.body) {
        reportError('client_network', 'request failed', res.status);
        finalizeAnswer(turnIdx, turn.wrap, turn.aEl, { type: 'error', message: 'Request failed (' + res.status + ')' }, accumulated);
        return;
      }
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        var idx;
        while ((idx = buffer.indexOf('\\n\\n')) >= 0) {
          var frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (!frame) continue;
          var ev = parseSseFrame(frame);
          if (ev.event === 'delta') {
            try {
              var d = JSON.parse(ev.data);
              if (d && typeof d.text === 'string') {
                accumulated += d.text;
                turn.aEl.textContent = accumulated;
                var b = $('body');
                b.scrollTop = b.scrollHeight;
              }
            } catch (_e) { /* skip malformed delta */ }
          } else if (ev.event === 'result') {
            try { lastResult = JSON.parse(ev.data); } catch (_e) { /* keep prior */ }
          } else if (ev.event === 'done') {
            break;
          }
        }
      }
      if (lastResult && typeof lastResult.session_id === 'string' && lastResult.session_id !== sessionId) {
        sessionId = lastResult.session_id;
        post({ kind: 'session-id', sessionId: sessionId });
      }
      finalizeAnswer(turnIdx, turn.wrap, turn.aEl, lastResult, accumulated);
    } catch (err) {
      reportError('client_network', String((err && err.message) || err));
      finalizeAnswer(turnIdx, turn.wrap, turn.aEl, { type: 'error', message: 'Network error' }, accumulated);
    } finally {
      qEl.disabled = false;
      $('send').disabled = false;
      qEl.focus();
      var b2 = $('body');
      b2.scrollTop = b2.scrollHeight;
    }
  }

  $('send').addEventListener('click', send);
  $('q').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  window.addEventListener('message', function (ev) {
    if (!ev || !ev.data || typeof ev.data !== 'object') return;
    if (ev.data.protocol !== PROTOCOL || ev.data.version !== VERSION) return;
    if (ev.data.kind === 'set-context') {
      hostContext = ev.data.context === null ? null : (ev.data.context || null);
      renderCtxLine();
    }
  });

  // Restore prior session if any.
  var stored = loadStored();
  if (stored) {
    if (typeof stored.sessionId === 'string') sessionId = stored.sessionId;
    if (Array.isArray(stored.turns)) {
      // Render each prior turn statically — no SSE replay, just final state.
      stored.turns.forEach(function (t) {
        if (!t || typeof t.q !== 'string') return;
        var turn = startTurn(t.q);
        turn.aEl.classList.remove('loading');
        turn.aEl.textContent = t.a || '';
        appendCitations(turn.aEl, t.citations || []);
        turns.push({ q: t.q, a: t.a || '', citations: t.citations || [], answerId: t.answerId || null, fb: t.fb });
      });
    }
  }

  // Force at least one source flag to be referenced so the params parse
  // above stays "live" (linters in alpha.3+ may complain otherwise).
  void contextSources;
  void projectKey;

  post({ kind: 'ready' });
})();
</script>
</body>
</html>
`;
