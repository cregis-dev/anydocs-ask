import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { html } from 'hono/html';

const COOKIE_NAME = 'anydocs_console_session';
const SESSION_TTL_SECONDS = 12 * 60 * 60;

export type ConsoleAuth = ReturnType<typeof createConsoleAuth>;

export function createConsoleAuth(token: string) {
  const normalizedToken = token.trim();
  if (normalizedToken.length < 16) {
    throw new Error('ANYDOCS_CONSOLE_AUTH_TOKEN must contain at least 16 characters');
  }

  const sign = (payload: string): string =>
    createHmac('sha256', normalizedToken).update(payload).digest('base64url');

  return {
    verifyToken(candidate: string): boolean {
      return safeEqual(candidate, normalizedToken);
    },

    hasValidSession(c: Context): boolean {
      const value = getCookie(c, COOKIE_NAME);
      if (!value) return false;
      const [expiresRaw, nonce, signature] = value.split('.');
      if (!expiresRaw || !nonce || !signature) return false;
      const expires = Number(expiresRaw);
      if (!Number.isSafeInteger(expires) || expires <= Math.floor(Date.now() / 1000)) {
        return false;
      }
      return safeEqual(signature, sign(`${expiresRaw}.${nonce}`));
    },

    setSession(c: Context): void {
      const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
      const payload = `${expires}.${randomBytes(18).toString('base64url')}`;
      setCookie(c, COOKIE_NAME, `${payload}.${sign(payload)}`, {
        path: '/',
        httpOnly: true,
        secure: isHttps(c),
        sameSite: 'Strict',
        maxAge: SESSION_TTL_SECONDS,
      });
    },

    clearSession(c: Context): void {
      deleteCookie(c, COOKIE_NAME, {
        path: '/',
        secure: isHttps(c),
      });
    },
  };
}

export function renderLoginPage(error: string | null = null) {
  return html`<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex,nofollow" />
    <title>Sign in · anydocs-ask console</title>
    <style>
      :root { color-scheme: light; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f7f9; color: #172033; }
      main { width: min(420px, calc(100vw - 32px)); border: 1px solid #dfe3e8; background: #fff; padding: 32px; box-shadow: 0 18px 50px rgba(23, 32, 51, .08); }
      h1 { margin: 0 0 8px; font-size: 24px; letter-spacing: 0; }
      p { margin: 0 0 24px; color: #667085; line-height: 1.5; }
      label { display: block; margin-bottom: 8px; font-size: 13px; font-weight: 650; }
      input { width: 100%; height: 44px; border: 1px solid #cfd5dd; padding: 0 12px; font: inherit; outline: none; }
      input:focus { border-color: #087f5b; box-shadow: 0 0 0 3px rgba(8, 127, 91, .12); }
      button { width: 100%; height: 44px; margin-top: 16px; border: 0; background: #087f5b; color: #fff; font: inherit; font-weight: 700; cursor: pointer; }
      button:hover { background: #066c4d; }
      .error { margin: 0 0 16px; padding: 10px 12px; background: #fff1f0; color: #b42318; font-size: 13px; }
    </style>
  </head>
  <body>
    <main>
      <h1>RAG Console</h1>
      <p>Enter the administrator token to continue.</p>
      ${error ? html`<div class="error" role="alert">${error}</div>` : ''}
      <form method="post" action="/login">
        <label for="token">Access token</label>
        <input id="token" name="token" type="password" required autofocus autocomplete="current-password" />
        <button type="submit">Sign in</button>
      </form>
    </main>
  </body>
</html>`;
}

function isHttps(c: Context): boolean {
  const forwarded = c.req.header('X-Forwarded-Proto')?.split(',')[0]?.trim().toLowerCase();
  return forwarded === 'https' || new URL(c.req.url).protocol === 'https:';
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
