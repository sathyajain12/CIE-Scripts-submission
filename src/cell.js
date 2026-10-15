// A status cell (Swayam / CIE Blocks / Assignments) is stored in the sheet as
// "" | "Hard" | "Soft" | "Hard + Soft", optionally followed by ": <links>" (older rows;
// the drive link now lives in the "Summative test" column).
export function parseCell(v = '') {
  const k = v.indexOf(':');
  const head = k >= 0 ? v.slice(0, k) : v; // only the prefix, so links containing "hard"/"soft" don't count
  const soft = /soft/i.test(head);
  return { hard: /hard/i.test(head), soft, link: soft && k >= 0 ? v.slice(k + 1).replace(/^ /, '') : '' };
}

export function formatCell({ hard, soft, link }) {
  return [hard && 'Hard', soft && 'Soft'].filter(Boolean).join(' + ') + (soft && link ? ': ' + link : '');
}

// 0 -> A, 25 -> Z, 26 -> AA
export function colLetter(i) {
  let s = '';
  for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}
