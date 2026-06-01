/**
 * RFC 0004 W3 alpha.1 — Host SDK bundle.
 *
 * Renders the JavaScript text the operator embeds via:
 *
 *   <script src="https://my-ask-server.example/widget/v1.js" async></script>
 *
 * The bundle installs `window.anydocsAsk` (matching the W1
 * {@link WidgetGlobal} type) and lets the host call
 * `anydocsAsk.init({ projectKey, ... })` to mount an iframe in the configured
 * position. The iframe loads `/widget/chat` from the same ask server,
 * which renders the actual chat UI ([[renderWidgetChatPage]]).
 *
 * Same-origin only at alpha.1 — the host page must be served from the same
 * origin as the ask server (or operator must set up a reverse proxy).
 * Cross-origin support (CORS allowlist + project key validation) lands in
 * alpha.2 with W4.
 *
 * The output is a tiny IIFE (~ 4 KB minified). Authored as readable JS;
 * compaction is left to whatever CDN / nginx serves it.
 */

export type RenderWidgetHostScriptOptions = {
  /** Origin of the ask server, e.g. `https://docs.example.com`. The bundle
   *  uses this to construct the iframe src + the postMessage target. When
   *  null/undefined the bundle falls back to `location.origin` of the page
   *  that loaded the script. */
  defaultBaseUrl?: string | null;
};

/**
 * Returns the JavaScript text to serve at `GET /widget/v1.js`.
 *
 * The bundle is one big IIFE. Trailing newline so the static asset handler
 * doesn't need to worry about appending one.
 */
export function renderWidgetHostScript(
  opts: RenderWidgetHostScriptOptions = {},
): string {
  const defaultBaseUrl = opts.defaultBaseUrl ?? '';
  return WIDGET_HOST_JS.replace('__DEFAULT_BASE_URL__', JSON.stringify(defaultBaseUrl));
}

// ---------------------------------------------------------------------------
// Bundle source — single IIFE, no module imports (browser global only).
// ---------------------------------------------------------------------------

const WIDGET_HOST_JS = `/* anydocs-ask widget host SDK — RFC 0004 W3 MVP (alpha.1).
 * Same-origin only; CORS + project-key validation = alpha.2 W4.
 */
(function (global) {
  'use strict';

  var PROTOCOL = 'anydocs-ask';
  var VERSION = 1;
  var BUNDLE_VERSION = '0.4.0-alpha.1';
  var DEFAULT_BASE_URL = __DEFAULT_BASE_URL__;

  function resolveBaseUrl(options) {
    if (options && typeof options.baseUrl === 'string' && options.baseUrl.length > 0) {
      return options.baseUrl.replace(/\\/+$/, '');
    }
    if (DEFAULT_BASE_URL) return DEFAULT_BASE_URL.replace(/\\/+$/, '');
    return location.origin;
  }

  function buildChatUrl(baseUrl, options) {
    var params = new URLSearchParams();
    params.set('projectKey', options.projectKey);
    if (options.locale && options.locale !== 'auto') params.set('locale', options.locale);
    if (options.mode === 'shadow') params.set('mode', 'shadow');
    if (Array.isArray(options.contextSources) && options.contextSources.length > 0) {
      params.set('contextSources', options.contextSources.join(','));
    }
    // F12 (dogfood 2026-05-24) — propagate docsBaseUrl so the chat page can
    // resolve relative citation paths to the customer's doc site instead of
    // the ask server. Empty string is intentional opt-out (show plain text).
    if (typeof options.docsBaseUrl === 'string' && options.docsBaseUrl.length > 0) {
      params.set('docsBaseUrl', options.docsBaseUrl);
    }
    // F10 — let the iframe pick up theme.baseColor too (renders the send
    // button + verdict accents in the host's brand color).
    if (options.theme && typeof options.theme.baseColor === 'string' && options.theme.baseColor.length > 0) {
      params.set('themeBaseColor', options.theme.baseColor);
    }
    return baseUrl + '/widget/chat?' + params.toString();
  }

  function applyPositionStyles(el, position) {
    el.style.position = 'fixed';
    el.style.zIndex = '2147483646'; // one below max — leave room for host modals
    el.style.boxShadow = '0 8px 24px rgba(0,0,0,0.18)';
    el.style.borderRadius = '12px';
    el.style.border = '1px solid rgba(0,0,0,0.08)';
    el.style.background = '#fff';
    el.style.width = '380px';
    el.style.height = '560px';
    el.style.maxWidth = 'calc(100vw - 16px)';
    el.style.maxHeight = 'calc(100vh - 96px)';
    var pos = position || 'bottom-right';
    el.style.right = pos === 'bottom-right' || pos === 'top-right' ? '16px' : '';
    el.style.left = pos === 'bottom-left' ? '16px' : '';
    el.style.bottom = pos === 'bottom-right' || pos === 'bottom-left' ? '80px' : '';
    el.style.top = pos === 'top-right' ? '16px' : '';
  }

  function makeBubble(onClick, themeBaseColor) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Open ask widget');
    btn.setAttribute('data-anydocs-widget-bubble', '');
    btn.style.position = 'fixed';
    btn.style.right = '16px';
    btn.style.bottom = '16px';
    btn.style.zIndex = '2147483647';
    btn.style.width = '56px';
    btn.style.height = '56px';
    btn.style.borderRadius = '50%';
    btn.style.border = '0';
    // F10 — theme.baseColor flows in here; default = ink black.
    btn.style.background = (themeBaseColor && typeof themeBaseColor === 'string')
      ? themeBaseColor
      : '#1a1a17';
    btn.style.color = '#fff';
    btn.style.cursor = 'pointer';
    btn.style.boxShadow = '0 6px 18px rgba(0,0,0,0.25)';
    btn.style.padding = '0';
    btn.style.display = 'flex';
    btn.style.alignItems = 'center';
    btn.style.justifyContent = 'center';
    btn.style.transition = 'transform 0.15s ease';
    btn.addEventListener('mouseenter', function () { btn.style.transform = 'scale(1.06)'; });
    btn.addEventListener('mouseleave', function () { btn.style.transform = 'scale(1)'; });
    // F10 — SVG chat-bubble icon. Inline so the bundle stays one-file.
    btn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24"' +
      ' fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"' +
      ' stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>' +
      '</svg>';
    btn.addEventListener('click', onClick);
    return btn;
  }

  function postToIframe(iframe, payload) {
    if (!iframe || !iframe.contentWindow) return;
    var msg = Object.assign({ protocol: PROTOCOL, version: VERSION }, payload);
    // Same-origin only at alpha.1 — passing '*' is the documented limitation
    // (RFC §4.4). alpha.2 W4 narrows to exact targetOrigin = baseUrl.
    iframe.contentWindow.postMessage(msg, '*');
  }

  function init(options) {
    if (current) current.destroy();
    if (!options || typeof options.projectKey !== 'string' || options.projectKey.length === 0) {
      throw new Error('anydocsAsk.init: projectKey is required');
    }
    var baseUrl = resolveBaseUrl(options);
    var chatUrl = buildChatUrl(baseUrl, options);

    var iframe = document.createElement('iframe');
    iframe.src = chatUrl;
    iframe.title = 'Anydocs Ask';
    iframe.setAttribute('data-anydocs-widget-frame', '');
    iframe.setAttribute('allow', 'clipboard-write');
    iframe.style.display = 'none';
    applyPositionStyles(iframe, options.position);

    var themeBaseColor = (options.theme && typeof options.theme.baseColor === 'string')
      ? options.theme.baseColor
      : null;
    var bubble = options.position === 'inline' ? null : makeBubble(function () {
      handle.open();
    }, themeBaseColor);

    var mountTarget = document.body;
    if (options.position === 'inline') {
      if (typeof options.mountSelector !== 'string' || options.mountSelector.length === 0) {
        throw new Error('anydocsAsk.init: inline position requires mountSelector');
      }
      var target = document.querySelector(options.mountSelector);
      if (!target) {
        throw new Error('anydocsAsk.init: mountSelector did not match any element');
      }
      mountTarget = target;
      mountTarget.innerHTML = '';
      iframe.style.position = 'relative';
      iframe.style.width = '100%';
      iframe.style.height = '100%';
      iframe.style.right = '';
      iframe.style.bottom = '';
      iframe.style.boxShadow = 'none';
      iframe.style.border = '0';
      iframe.style.display = 'block';
    } else if (bubble) {
      document.body.appendChild(bubble);
    }
    mountTarget.appendChild(iframe);

    var sessionId = null;
    var pendingContext = null;
    var isOpen = options.position === 'inline';

    function onMessage(ev) {
      if (!ev || !ev.data || typeof ev.data !== 'object') return;
      if (ev.data.protocol !== PROTOCOL || ev.data.version !== VERSION) return;
      // Same-origin alpha.1 — iframe is from baseUrl so its origin matches
      // baseUrl. alpha.2 will tighten the origin check here too.
      var kind = ev.data.kind;
      if (kind === 'ready') {
        // Forward host setContext that arrived before the iframe loaded.
        if (pendingContext !== undefined) {
          postToIframe(iframe, { kind: 'set-context', context: pendingContext });
          pendingContext = undefined;
        }
      } else if (kind === 'session-id') {
        sessionId = typeof ev.data.sessionId === 'string' ? ev.data.sessionId : null;
        if (sessionId && typeof options.onSessionId === 'function') {
          try { options.onSessionId(sessionId); } catch (_e) {}
        }
      } else if (kind === 'resize' && iframe.style.position !== 'relative') {
        if (typeof ev.data.height === 'number' && ev.data.height > 0) {
          iframe.style.height = Math.min(720, Math.max(360, ev.data.height)) + 'px';
        }
      } else if (kind === 'error') {
        if (typeof options.onError === 'function' && ev.data.error) {
          try { options.onError(ev.data.error); } catch (_e) {}
        }
      } else if (kind === 'navigate') {
        if (typeof ev.data.href === 'string') {
          var target = ev.data.target === '_self' ? '_self' : '_blank';
          window.open(ev.data.href, target, 'noopener');
        }
      }
    }
    window.addEventListener('message', onMessage);

    var handle = {
      get sessionId() { return sessionId; },
      setContext: function (input) {
        // If the iframe hasn't fired 'ready' yet, queue the latest value
        // (overwriting any prior queued one — host calls during boot are
        // a setContext-storm anti-pattern but tolerated).
        if (iframe.contentWindow) {
          postToIframe(iframe, { kind: 'set-context', context: input === undefined ? null : input });
        } else {
          pendingContext = input === undefined ? null : input;
        }
      },
      open: function () {
        if (options.position === 'inline') return;
        iframe.style.display = 'block';
        isOpen = true;
        postToIframe(iframe, { kind: 'open' });
      },
      close: function () {
        if (options.position === 'inline') return;
        iframe.style.display = 'none';
        isOpen = false;
        postToIframe(iframe, { kind: 'close' });
      },
      destroy: function () {
        try { postToIframe(iframe, { kind: 'destroy' }); } catch (_e) {}
        window.removeEventListener('message', onMessage);
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
        if (bubble && bubble.parentNode) bubble.parentNode.removeChild(bubble);
        if (current === handle) current = null;
      },
    };
    current = handle;
    return handle;
  }

  var current = null;
  global.anydocsAsk = {
    init: init,
    get current() { return current; },
    version: BUNDLE_VERSION,
  };
})(window);
`;
