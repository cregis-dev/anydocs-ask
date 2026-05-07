/**
 * ISO 8601 week-of-year tests — covers boundary cases where the calendar
 * year and the ISO week-year disagree.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toIsoWeek } from '../src/runs/iso-week.ts';

function isoWeek(y: number, m: number, d: number): string {
  return toIsoWeek(new Date(Date.UTC(y, m - 1, d)));
}

test('toIsoWeek: 2026-05-08 -> 2026-W19 (ARCH §16 reference)', () => {
  assert.equal(isoWeek(2026, 5, 8), '2026-W19');
});

test('toIsoWeek: 2024-01-01 (Mon) -> 2024-W01', () => {
  assert.equal(isoWeek(2024, 1, 1), '2024-W01');
});

test('toIsoWeek: 2025-12-29 (Mon) -> 2026-W01 — Mon before 2026-01-01 Thu', () => {
  assert.equal(isoWeek(2025, 12, 29), '2026-W01');
});

test('toIsoWeek: 2026-01-04 (Sun) -> 2026-W01', () => {
  assert.equal(isoWeek(2026, 1, 4), '2026-W01');
});

test('toIsoWeek: 2026-01-05 (Mon) -> 2026-W02', () => {
  assert.equal(isoWeek(2026, 1, 5), '2026-W02');
});

test('toIsoWeek: 2024-12-30 (Mon) -> 2025-W01 — Mon before 2025-01-01 Wed', () => {
  assert.equal(isoWeek(2024, 12, 30), '2025-W01');
});

test('toIsoWeek: 2027-01-03 (Sun) -> 2026-W53 — last Sunday of 2026 ISO year', () => {
  assert.equal(isoWeek(2027, 1, 3), '2026-W53');
});

test('toIsoWeek: 2027-01-04 (Mon) -> 2027-W01', () => {
  assert.equal(isoWeek(2027, 1, 4), '2027-W01');
});

test('toIsoWeek: 2024-02-29 (leap day) -> 2024-W09', () => {
  assert.equal(isoWeek(2024, 2, 29), '2024-W09');
});

test('toIsoWeek: zero-padded week numbers', () => {
  assert.match(isoWeek(2026, 1, 5), /^\d{4}-W\d{2}$/);
  assert.match(isoWeek(2026, 7, 1), /^\d{4}-W\d{2}$/);
});
