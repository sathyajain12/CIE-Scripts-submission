import assert from 'node:assert';
import { parseCell, formatCell, colLetter } from './cell.js';

for (const c of [
  { hard: false, soft: false, link: '' },
  { hard: true, soft: false, link: '' },
  { hard: false, soft: true, link: 'https://drive.google.com/hardcopy' },
  { hard: true, soft: true, link: 'https://a, https://b ' },
  { hard: false, soft: true, link: '' },
  { hard: true, soft: true, link: '' },
]) assert.deepStrictEqual(parseCell(formatCell(c)), c);
assert.strictEqual(formatCell({ hard: false, soft: true, link: '' }), 'Soft');

assert.deepStrictEqual([0, 25, 26, 51, 701, 702].map(colLetter), ['A', 'Z', 'AA', 'AZ', 'ZZ', 'AAA']);
console.log('ok');
