import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillBar } from './show';

test('fillBar: null → em dash', () => {
  assert.equal(fillBar(null), '—');
});

test('fillBar: 0% → empty bar', () => {
  assert.equal(fillBar(0), '░░░░░░░░');
});

test('fillBar: 50% → half full', () => {
  assert.equal(fillBar(50), '▓▓▓▓░░░░');
});

test('fillBar: 100% → full', () => {
  assert.equal(fillBar(100), '▓▓▓▓▓▓▓▓');
});

test('fillBar: over 100% clamps to full', () => {
  assert.equal(fillBar(130), '▓▓▓▓▓▓▓▓');
});
