// Reading the tracker sheet: shared by the faculty portal (App.jsx) and the admin portal (Admin.jsx).

// Columns answered with Y / N / NA (Y asks whether it was a hard or soft copy).
// A hard copy stores "Y"; a soft copy stores the drive link itself in the cell.
export const YN_COLS = ['CIE Block-1', 'CIE Block-2', 'CIE Block-3', 'Assignments', 'Summative test'];

// Match headers loosely so "Course Code (CC)", "Summative test for 1 paper" etc. resolve.
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
export function findCols(headers) {
  const find = name => headers.findIndex(h => norm(h).startsWith(norm(name)));
  const f = name => {
    const i = find(name);
    if (i < 0) throw new Error('Column not found in sheet: ' + name);
    return i;
  };
  return {
    prog: f('Programme'), sem: f('Semester'), code: f('Course Code'), title: find('Course Title'),
    yn: YN_COLS.map(f),
    remarks: f('Remarks'),
    hidden: [find('Swayam'), find('ESE Max')].filter(i => i >= 0), // kept in the sheet, not shown here
  };
}
export const writable = cols => [...cols.yn, cols.remarks];

// Y/N cells hold "Y" | "N" | "NA" | "" (or a drive link). Any other text counts as Y.
export const yn = v => {
  const t = String(v ?? '').trim();
  return /^n\/?a$/i.test(t) ? 'NA' : /^n$|^no\b/i.test(t) ? 'N' : t ? 'Y' : '';
};

// % of applicable (non-NA) Y/N cells answered Y across a list of [row, index] pairs.
export function ynPct(list, ynCols) {
  let y = 0, total = 0;
  for (const [r] of list) for (const j of ynCols) {
    const a = yn(r[j]);
    if (a !== 'NA') { total++; y += a === 'Y'; }
  }
  return total ? Math.round((y / total) * 100) : 0;
}

// One course: 'complete' (every applicable column is Y), 'partial' (some Y), 'notStarted' (no Y yet),
// or 'na' (every column is NA).
export function courseState(row, ynCols) {
  const states = ynCols.map(j => yn(row[j])).filter(a => a !== 'NA');
  if (!states.length) return 'na';
  if (states.every(a => a === 'Y')) return 'complete';
  return states.some(a => a === 'Y') ? 'partial' : 'notStarted';
}

// Semesters are stored as Roman numerals. IBM Plex Sans draws a serifed capital I, so "III" looks like a
// serif font; they are shown as numbers instead (display only, the sheet is unchanged).
const ROMAN = { I: 1, V: 5, X: 10 };
export function semNum(s) {
  const t = String(s ?? '').trim().toUpperCase();
  if (!/^[IVX]+$/.test(t)) return s;
  let n = 0;
  for (let k = 0; k < t.length; k++) n += ROMAN[t[k]] < (ROMAN[t[k + 1]] || 0) ? -ROMAN[t[k]] : ROMAN[t[k]];
  return String(n);
}

// Header row + data rows (padded to the header width) from a values array.
export function parseValues(values = []) {
  const headers = values[0] || [];
  return { headers, cols: findCols(headers), rows: values.slice(1).map(r => headers.map((_, j) => r[j] ?? '')) };
}
