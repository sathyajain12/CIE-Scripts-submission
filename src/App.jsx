import { useEffect, useState } from 'react';
import { parseCell, formatCell, colLetter } from './cell.js';

const { VITE_SHEET_ID: SHEET_ID, VITE_SHEET_TAB: TAB = 'Sheet1', VITE_GOOGLE_CLIENT_ID: CLIENT_ID } = import.meta.env;
const API = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values`;
const a1 = r => encodeURIComponent(`'${TAB.replace(/'/g, "''")}'!${r}`);

// No .env yet -> demo mode with sample rows; saves stay in the browser only.
const DEMO = !SHEET_ID || !CLIENT_ID;
const DEMO_VALUES = [
  ['Sl. No.', 'Programme short name', 'Semester', 'Course Code (CC)', 'Course Title', 'Course Credits', 'Course Category', 'CIE Max', 'ESE Max', 'Swayam', 'CIE Block-1', 'CIE Block-2', 'CIE Block-3', 'Assignments', 'Summative test for 1 paper', 'Remarks'],
  ['1', 'BCA', '3', 'BCA301', 'Data Structures', '4', 'I', '50', '50', '', 'Hard', 'Soft: https://drive.google.com/demo1', '', '', '', ''],
  ['2', 'BCA', '3', 'BCA302', 'Operating Systems', '4', 'IE', '50', '50', '', 'Hard + Soft: https://drive.google.com/demo2', '', '', 'Hard', '', 'Block-3 pending'],
  ['3', 'BCom', '5', 'BCO501', 'Cost Accounting', '3', 'I', '50', '50', 'Soft: https://drive.google.com/demo3', '', '', '', '', '', ''],
  ['4', 'BBA', '1', 'BBA101', 'Principles of Management', '3', 'IE', '100', '0', '', '', '', '', '', 'Done', ''],
];

const STATUS_COLS =['Swayam', 'CIE Block-1', 'CIE Block-2', 'CIE Block-3', 'Assignments'];
const TEXT_COLS = ['Summative test', 'Remarks'];

async function api(token, path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  });
  const j = await res.json();
  if (!res.ok) throw new Error(res.status === 401 ? 'Session expired, sign in again.' : j.error?.message || res.statusText);
  return j;
}

// Match headers loosely so "Course Code (CC)", "Summative test for 1 paper" etc. resolve.
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
function findCols(headers) {
  const f = name => {
    const i = headers.findIndex(h => norm(h).startsWith(norm(name)));
    if (i < 0) throw new Error('Column not found in sheet: ' + name);
    return i;
  };
  return { prog: f('Programme'), sem: f('Semester'), code: f('Course Code'), status: STATUS_COLS.map(f), text: TEXT_COLS.map(f) };
}

export default function App() {
  const [token, setToken] = useState(DEMO ? 'demo' : null);
  const [data, setData] = useState(null); // { headers, cols }
  const [rows, setRows] = useState([]);
  const [state, setState] = useState({}); // row index -> 'dirty' | 'saving' | 'saved'
  const [err, setErr] = useState('');
  const [f, setF] = useState({ prog: '', sem: '', q: '' });

  function signIn() {
    google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      callback: r => (r.error ? setErr(r.error) : setToken(r.access_token)),
    }).requestAccessToken();
  }

  useEffect(() => {
    if (!token) return;
    (DEMO ? Promise.resolve({ values: DEMO_VALUES }) : api(token, '/' + a1('A1:ZZ')))
      .then(({ values = [] }) => {
        const headers = values[0] || [];
        const cols = findCols(headers);
        setData({ headers, cols });
        setRows(values.slice(1).map(r => headers.map((_, j) => r[j] ?? '')));
        setState({});
        setErr('');
      })
      .catch(e => setErr(e.message));
  }, [token]);

  const setCell = (i, j, v) => {
    setRows(rs => rs.map((r, k) => (k === i ? r.map((x, m) => (m === j ? v : x)) : r)));
    setState(s => ({ ...s, [i]: 'dirty' }));
  };

  async function save(i) {
    const { headers, cols } = data, r = rows[i], n = i + 2;
    for (const j of cols.status) {
      const c = parseCell(r[j]);
      if (c.soft && !c.link.trim()) return alert(headers[j] + ': enter the drive link for the soft copy.');
    }
    if (DEMO) return setState(s => ({ ...s, [i]: 'saved' }));
    setState(s => ({ ...s, [i]: 'saving' }));
    try {
      // Guard: someone may have sorted/edited the sheet since we loaded it.
      const cur = await api(token, '/' + a1(colLetter(cols.code) + n));
      if ((cur.values?.[0]?.[0] ?? '') !== r[cols.code]) throw new Error('Sheet changed since you loaded it. Reload the page.');
      await api(token, ':batchUpdate', {
        method: 'POST',
        body: JSON.stringify({
          valueInputOption: 'RAW', // RAW = stored as plain text, never evaluated as a formula
          data: [...cols.status, ...cols.text].map(j => ({ range: `'${TAB.replace(/'/g, "''")}'!${colLetter(j)}${n}`, values: [[r[j].trim()]] })),
        }),
      });
      setState(s => ({ ...s, [i]: 'saved' }));
    } catch (e) {
      setState(s => ({ ...s, [i]: 'dirty' }));
      alert(e.message);
    }
  }

  if (!token) return (
    <>
      <h2>CIE Script &amp; Assignment Tracker</h2>
      <button onClick={signIn}>Sign in with Google</button>
      {err && <p className="err">{err}</p>}
    </>
  );
  if (!data) return err ? <p className="err">{err} <button onClick={signIn}>Sign in again</button></p> : <p>Loading…</p>;

  const { headers, cols } = data;
  const options = col => [...new Set(rows.map(r => r[col]))].filter(Boolean).sort();
  const q = f.q.toLowerCase();
  const visible = rows
    .map((r, i) => [r, i])
    .filter(([r]) => (!f.prog || r[cols.prog] === f.prog) && (!f.sem || r[cols.sem] === f.sem) && (!q || r.join(' ').toLowerCase().includes(q)));

  return (
    <>
      <h2>CIE Script &amp; Assignment Tracker</h2>
      <div className="bar">
        <select value={f.prog} onChange={e => setF({ ...f, prog: e.target.value })}>
          <option value="">All programmes</option>
          {options(cols.prog).map(v => <option key={v}>{v}</option>)}
        </select>
        <select value={f.sem} onChange={e => setF({ ...f, sem: e.target.value })}>
          <option value="">All semesters</option>
          {options(cols.sem).map(v => <option key={v}>{v}</option>)}
        </select>
        <input placeholder="Search course code / title" value={f.q} onChange={e => setF({ ...f, q: e.target.value })} />
        <span>{visible.length} courses</span>
        {err && <span className="err">{err}</span>}
        {DEMO && <span className="err">Demo data — set up .env to connect your Google Sheet.</span>}
      </div>
      <div className="wrap">
        <table>
          <thead><tr>{headers.map((h, j) => <th key={j}>{h}</th>)}<th /></tr></thead>
          <tbody>
            {visible.map(([r, i]) => (
              <tr key={i} className={state[i] === 'saving' ? 'dirty' : state[i]}>
                {r.map((v, j) =>
                  cols.status.includes(j) ? <Status key={j} v={v} onChange={v => setCell(i, j, v)} />
                  : cols.text.includes(j) ? <td key={j}><input type="text" value={v} onChange={e => setCell(i, j, e.target.value)} /></td>
                  : <td key={j}>{v}</td>
                )}
                <td>
                  <button disabled={state[i] === 'saving'} onClick={() => save(i)}>
                    {state[i] === 'saving' ? 'Saving…' : state[i] === 'saved' ? 'Saved ✓' : 'Save'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Status({ v, onChange }) {
  const c = parseCell(v);
  const set = p => onChange(formatCell({ ...c, ...p }));
  return (
    <td className="st">
      <label><input type="checkbox" checked={c.hard} onChange={e => set({ hard: e.target.checked })} /> Hard copy sent</label>
      <label><input type="checkbox" checked={c.soft} onChange={e => set({ soft: e.target.checked })} /> Soft copy sent</label>
      {c.soft && <input type="text" placeholder="Drive link(s)" value={c.link} onChange={e => set({ link: e.target.value })} />}
    </td>
  );
}
