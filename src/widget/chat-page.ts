/**
 * RFC 0004 W3 alpha.1 — Widget iframe chat page.
 *
 * The page served at `GET /widget/chat`. The host-side SDK
 * ([[renderWidgetHostScript]]) creates an `<iframe src="…/widget/chat?…">`
 * pointing at this page, and the page talks back via postMessage.
 *
 * Scope (alpha.1 minimum viable):
 *   - Question textarea + send button + answer area
 *   - Calls `/v1/ask` on the same origin
 *   - Reads URL params: `projectKey`, `locale`, `contextSources`
 *   - Reads host `setContext` payloads via postMessage
 *   - Emits `ready` / `session-id` / `error` / `resize` events back to host
 *
 * Out of scope (alpha.2+):
 *   - SSE streaming (alpha.1 uses POST /v1/ask non-stream)
 *   - β feedback buttons inside the widget
 *   - History drawer
 *   - CORS / project-key validation on /v1/ask (alpha.2 W4)
 *   - Citation visual deduplication (Reader uses this; widget will get it
 *     via shared helper in alpha.2 polish)
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

  function $(id) { return document.getElementById(id); }
  function post(payload) {
    if (!window.parent || window.parent === window) return;
    var msg = Object.assign({ protocol: PROTOCOL, version: VERSION }, payload);
    // Same-origin alpha.1 — '*' is documented (RFC §4.4 alpha.2 will narrow
    // to the parent baseUrl).
    window.parent.postMessage(msg, '*');
  }

  var params = new URLSearchParams(location.search);
  var projectKey = params.get('projectKey') || '';
  var contextSources = (params.get('contextSources') || 'url,title').split(',').filter(Boolean);

  var hostContext = null; // last setContext payload from parent
  var sessionId = null;

  function readAutoContext() {
    // alpha.1: parent's URL + title come from postMessage in alpha.2 when we
    // formalise the host meta channel. For now we leave the slot empty and
    // let host send via setContext(). The 'url'/'title' sources are
    // therefore informational only in this MVP.
    return { sources: contextSources };
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

  function appendTurn(q) {
    var empty = $('empty');
    if (empty && empty.parentNode) empty.parentNode.removeChild(empty);
    var wrap = document.createElement('div');
    wrap.className = 'turn';
    var qEl = document.createElement('div');
    qEl.className = 'q';
    qEl.textContent = q;
    var aEl = document.createElement('div');
    aEl.className = 'a loading';
    aEl.textContent = 'Thinking…';
    wrap.appendChild(qEl);
    wrap.appendChild(aEl);
    $('body').appendChild(wrap);
    return aEl;
  }

  function finalizeAnswer(aEl, result) {
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
    // type === 'answer'
    aEl.textContent = result.answer_md || '';
    if (Array.isArray(result.citations) && result.citations.length > 0) {
      var cit = document.createElement('div');
      cit.className = 'cit';
      result.citations.forEach(function (c, i) {
        var line = document.createElement('div');
        var n = i + 1;
        var pageId = c.page_id || '';
        var title = c.title || pageId || '';
        if (c.url) {
          var a = document.createElement('a');
          a.href = c.url;
          a.target = '_blank';
          a.rel = 'noopener';
          a.textContent = n + '. ' + title;
          a.addEventListener('click', function (e) {
            // Defer to host's navigate decision so the embedded iframe
            // doesn't unilaterally pop a window.
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
  }

  function reportError(code, message, status) {
    post({ kind: 'error', error: { code: code, message: message, status: status } });
  }

  async function send() {
    var qEl = $('q');
    var question = (qEl.value || '').trim();
    if (!question) return;
    qEl.value = '';
    qEl.disabled = true;
    $('send').disabled = true;
    var aEl = appendTurn(question);
    var body = {
      question: question,
      session_id: sessionId,
      context: {},
    };
    if (hostContext) {
      // alpha.1: stash the entire context blob under context.widget so server
      // can ignore it (until alpha.2 W4 actually reads it). This makes the
      // wire format forward-compatible.
      body.context.widget = {
        host: { page: hostContext.page || undefined, topic: hostContext.topic || undefined },
        data: hostContext.data || undefined,
      };
    }
    try {
      var headers = { 'Content-Type': 'application/json' };
      if (projectKey) headers['X-Project-Key'] = projectKey;
      var res = await fetch('/v1/ask', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body),
      });
      var parsed;
      try { parsed = await res.json(); } catch (_e) { parsed = null; }
      if (!res.ok && (!parsed || parsed.type !== 'error')) {
        reportError('client_network', 'request failed', res.status);
        finalizeAnswer(aEl, { type: 'error', code: 'client_network', message: 'Request failed (' + res.status + ')' });
      } else {
        if (parsed && typeof parsed.session_id === 'string' && parsed.session_id !== sessionId) {
          sessionId = parsed.session_id;
          post({ kind: 'session-id', sessionId: sessionId });
        }
        finalizeAnswer(aEl, parsed);
      }
    } catch (err) {
      reportError('client_network', String((err && err.message) || err));
      finalizeAnswer(aEl, { type: 'error', code: 'client_network', message: 'Network error' });
    } finally {
      qEl.disabled = false;
      $('send').disabled = false;
      qEl.focus();
      var b = $('body');
      b.scrollTop = b.scrollHeight;
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
    } else if (ev.data.kind === 'close' || ev.data.kind === 'destroy') {
      // alpha.1 nothing to clean up inside the iframe; parent removes it.
    }
  });

  // Surface the auto-context once for visual confirmation.
  void readAutoContext();

  post({ kind: 'ready' });
})();
</script>
</body>
</html>
`;
