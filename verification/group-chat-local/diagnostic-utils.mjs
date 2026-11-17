import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

export function fileFingerprint(file) {
  try { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function completeHistory(api) {
  const first = await api('B', '/messages?limit=100');
  assert.equal(first.status, 200);
  const messages = [...first.data.messages], seen = new Set();
  let cursor = first.data.next_cursor;
  while (cursor) {
    assert.ok(!seen.has(cursor), 'History cursor repeated'); seen.add(cursor);
    assert.ok(seen.size <= 10000, 'History page limit exceeded');
    const page = await api('B', '/messages?limit=100&cursor=' + encodeURIComponent(cursor));
    assert.equal(page.status, 200); messages.push(...page.data.messages); cursor = page.data.next_cursor;
  }
  // Delta recovery starts at the FIRST page's watermark, including changes
  // committed while subsequent (older) pages were being read.
  return { ...first, data: { ...first.data, messages, next_cursor: null } };
}
