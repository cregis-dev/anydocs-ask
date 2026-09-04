# Console Token Authentication

## Goal

Allow an operator to reach the anydocs-ask Console through an HTTPS reverse proxy without exposing its management pages and APIs anonymously. Keep local loopback development unchanged and avoid loading a second embedding model in the single-project container deployment.

## Design

`ANYDOCS_CONSOLE_AUTH_TOKEN` enables a Token-only login page. A successful login creates a 12-hour `HttpOnly`, `SameSite=Strict` cookie. The cookie contains an expiry, random nonce, and HMAC signature derived from the configured Token; it never contains the Token itself. Token comparisons and signatures use constant-time verification. Failed logins are limited per forwarded client address.

The authentication middleware protects every Console page and `/api/*` management route. `/health`, `/login`, and the separately authenticated `/mcp/:name` transport remain exempt. When Console binds outside loopback, the CLI fails closed unless a Token of at least 16 characters is configured.

For production, `AttachedProcessRegistry` represents an Ask server already listening in the Console container's network namespace. It reports the project as running and proxies Console operations to the existing port, but never starts or stops the externally managed process. This allows a lightweight Console sidecar to share the Ask container network and state volume without a second BGE-M3 instance or index.

## Verification

Tests cover page redirects, API rejection, invalid Token handling, secure Cookie attributes, authenticated access, logout, and the existing Console regression suite. Deployment verification must also confirm that unauthenticated public requests cannot reach management APIs while Ask, MCP, and Try-it health checks remain unchanged.
