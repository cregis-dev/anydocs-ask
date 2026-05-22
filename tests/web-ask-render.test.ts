/**
 * Reader Ask page (/ask) render smoke tests — pin the bits of inline JS /
 * CSS the rest of the app relies on. Source-level assertions: the page
 * inlines the renderer as a string template, so we grep for the helpers +
 * call sites rather than booting JSDOM.
 *
 * Today this only covers the F4-analog fix (cite-section span derived from
 * `in_page_path`). Extend as more reader-visible regressions come up.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderAskPage } from '../src/server/web-ask.ts';

function html(): string {
  return renderAskPage({ prompt: { assistantName: null, systemInstructions: [] } });
}

test('renderAskPage: inlines citeSectionLabel helper + cite-section span (Reader F4-analog fix)', () => {
  const body = html();
  // The helper that strips "/p[N]" off `in_page_path` to leave the
  // heading id. Must match the Console fix at project.ts:citeSectionLabel
  // so the visual disambiguation behaves the same way on both surfaces.
  assert.match(body, /function citeSectionLabel\(/);
  assert.match(body, /lastIndexOf\(['"]\/p\[['"]\)/);

  // renderCitations must build a `.cite-section` span with the "· §X"
  // prefix when the section label is non-empty.
  assert.match(body, /citeSectionLabel\(c\.in_page_path\)/);
  assert.match(body, /sec\.className = 'cite-section'/);
  assert.match(body, /'· §' \+ section/);

  // The CSS rule that styles the suffix in the small/muted variant lives
  // inside the page <style> block.
  assert.match(body, /\.cite-ti \.cite-section \{/);
});

test('renderAskPage: cite-slug still emits the full in_page_path for deeplink anchors', () => {
  // The slug row is the machine-readable path; the F4 fix appends a human-
  // readable section span without dropping the full path. Future deeplink
  // work (anchoring to a specific chunk inside a page) relies on the full
  // value still being rendered.
  const body = html();
  assert.match(body, /slug\.className = 'cite-slug'/);
  assert.match(body, /slugText \+= ' · ' \+ c\.in_page_path/);
});
