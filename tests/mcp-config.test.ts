/**
 * RFC 0007 — `mcp` config section: defaults, merge, and validation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAndValidateAskConfig } from '../src/config.ts';

test('mcp: default config — disabled, search+ask, 60/min, no origins', () => {
  const { config } = parseAndValidateAskConfig('{}');
  assert.deepEqual(config.mcp, {
    enabled: false,
    tools: ['search', 'ask'],
    rateLimitPerMinute: 60,
    allowedOrigins: [],
  });
});

test('mcp: user fields merge over defaults', () => {
  const { config, warnings } = parseAndValidateAskConfig(
    JSON.stringify({
      mcp: {
        enabled: true,
        tools: ['search', 'fetch_page'],
        rateLimitPerMinute: 120,
        allowedOrigins: ['https://app.example.com'],
      },
    }),
  );
  assert.equal(config.mcp.enabled, true);
  assert.deepEqual(config.mcp.tools, ['search', 'fetch_page']);
  assert.equal(config.mcp.rateLimitPerMinute, 120);
  assert.deepEqual(config.mcp.allowedOrigins, ['https://app.example.com']);
  assert.deepEqual(warnings, []);
});

test('mcp: tools normalized to canonical order, duplicates collapsed', () => {
  const { config } = parseAndValidateAskConfig(
    JSON.stringify({ mcp: { tools: ['ask', 'search', 'ask'] } }),
  );
  // Canonical order is search, ask, fetch_page regardless of how listed.
  assert.deepEqual(config.mcp.tools, ['search', 'ask']);
});

test('mcp: unknown tool names dropped with a warning', () => {
  const { config, warnings } = parseAndValidateAskConfig(
    JSON.stringify({ mcp: { tools: ['search', 'bogus', 42] } }),
  );
  assert.deepEqual(config.mcp.tools, ['search']);
  assert.ok(warnings.some((w) => /mcp\.tools ignored 2 unknown/.test(w)), warnings.join('; '));
});

test('mcp: empty tools array disables all tools', () => {
  const { config } = parseAndValidateAskConfig(JSON.stringify({ mcp: { tools: [] } }));
  assert.deepEqual(config.mcp.tools, []);
});

test('mcp: out-of-range rateLimitPerMinute warned, default kept', () => {
  const { config, warnings } = parseAndValidateAskConfig(
    JSON.stringify({ mcp: { rateLimitPerMinute: 0 } }),
  );
  assert.equal(config.mcp.rateLimitPerMinute, 60);
  assert.ok(warnings.some((w) => /mcp\.rateLimitPerMinute/.test(w)), warnings.join('; '));
});

test('mcp: non-origin strings in allowedOrigins rejected with a warning', () => {
  const { config, warnings } = parseAndValidateAskConfig(
    JSON.stringify({
      mcp: { allowedOrigins: ['https://ok.example.com', 'https://bad.example.com/path', 7] },
    }),
  );
  assert.deepEqual(config.mcp.allowedOrigins, ['https://ok.example.com']);
  assert.ok(warnings.some((w) => /mcp\.allowedOrigins ignored 2/.test(w)), warnings.join('; '));
});

test('mcp: non-object section warned and ignored', () => {
  const { config, warnings } = parseAndValidateAskConfig(JSON.stringify({ mcp: [1, 2, 3] }));
  assert.deepEqual(config.mcp.tools, ['search', 'ask']);
  assert.ok(warnings.some((w) => /'mcp' must be an object/.test(w)), warnings.join('; '));
});

test('mcp: enabled type-mismatch warned, default false kept', () => {
  const { config, warnings } = parseAndValidateAskConfig(
    JSON.stringify({ mcp: { enabled: 'yes' } }),
  );
  assert.equal(config.mcp.enabled, false);
  assert.ok(warnings.some((w) => /mcp\.enabled must be a boolean/.test(w)), warnings.join('; '));
});
