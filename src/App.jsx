import { useEffect, useRef, useState } from 'react';
import { colLetter } from './cell.js';
import logo from '../Image/Header logo.png';

const { VITE_SHEET_ID: SHEET_ID, VITE_SHEET_TAB: TAB = 'Sheet1', VITE_GOOGLE_CLIENT_ID: CLIENT_ID } = import.meta.env;
const API = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values`;
const a1 = r => encodeURIComponent(`'${TAB.replace(/'/g, "''")}'!${r}`);

const UNCONFIGURED = !SHEET_ID || !CLIENT_ID;

// Columns answered with Y / N (Y asks whether it was a hard or soft copy).
// For "Summative test" a soft copy stores the drive link itself in the cell instead of "Y".
const YN_COLS = ['CIE Block-1', 'CIE Block-2', 'CIE Block-3', 'Assignments', 'Summative test'];

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
  const find = name => headers.findIndex(h => norm(h).startsWith(norm(name)));
  const f = name => {
    const i = find(name);
    if (i < 0) throw new Error('Column not found in sheet: ' + name);
    return i;
  };
  return {
    prog: f('Programme'), sem: f('Semester'), code: f('Course Code'),
    yn: YN_COLS.map(f),
    link: f('Summative test'), remarks: f('Remarks'),
    hidden: [find('Swayam'), find('ESE Max')].filter(i => i >= 0), // kept in the sheet, not shown here
  };
}
const writable = cols => [...cols.yn, cols.remarks];

// Y/N cells hold "Y" | "N" | "" (or a drive link in Summative test). Any other text counts as Y.
const yn = v => (/^n$|^no\b/i.test(v.trim()) ? 'N' : v.trim() ? 'Y' : '');

// % of Y/N cells answered Y across a list of [row, index] pairs.
function ynPct(list, ynCols) {
  const total = list.length * ynCols.length;
  if (!total) return 0;
  let y = 0;
  for (const [r] of list) for (const j of ynCols) y += yn(r[j]) === 'Y';
  return Math.round((y / total) * 100);
}

function Header() {
  const ref = useRef();
  // Table headers stick just below this bar, so publish its height as --header-h.
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => document.documentElement.style.setProperty('--header-h', e.target.offsetHeight + 'px'));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return (
    <header ref={ref} className="top">
      <img src={logo} alt="Sri Sathya Sai Institute of Higher Learning — CIE Scripts Submission Portal" />
    </header>
  );
}

export default function App() {
  const [token, setToken] = useState(null);
  const [data, setData] = useState(null); // { headers, cols }
  const [rows, setRows] = useState([]);
  // How each "Y" was submitted this session: row -> col -> 'hard' | 'soft'. The sheet only stores Y (or the link).
  const [via, setVia] = useState({});
  const [state, setState] = useState({}); // row index -> 'dirty' | 'saving' | 'saved'
  const [err, setErr] = useState('');
  const [f, setFilters] = useState({ prog: '', sem: '', q: '', pending: false });
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(25);
  const setF = v => { setFilters(v); setPage(1); }; // new filters start from page 1
  const [group, setGroup] = useState(true); // group table rows by programme
  const [collapsed, setCollapsed] = useState({}); // programme -> true when its rows are hidden
  const tableTop = useRef();

  function signIn() {
    google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      callback: r => (r.error ? setErr(r.error) : setToken(r.access_token)),
    }).requestAccessToken();
  }

  useEffect(() => {
    if (!token) return;
    api(token, '/' + a1('A1:ZZ'))
      .then(({ values = [] }) => {
        const headers = values[0] || [];
        const cols = findCols(headers);
        setData({ headers, cols });
        setRows(values.slice(1).map(r => headers.map((_, j) => r[j] ?? '')));
        setVia({});
        setState({});
        setErr('');
      })
      .catch(e => setErr(e.message));
  }, [token]);

  const setCell = (i, j, v) => {
    setRows(rs => rs.map((r, k) => (k === i ? r.map((x, m) => (m === j ? v : x)) : r)));
    setState(s => ({ ...s, [i]: 'dirty' }));
  };
  const pickYN = (i, j, v, mode) => {
    setCell(i, j, v);
    setVia(s => ({ ...s, [i]: { ...s[i], [j]: mode } }));
  };

  async function save(i) {
    const { headers, cols } = data, r = rows[i], n = i + 2;
    if (via[i]?.[cols.link] === 'soft' && !r[cols.link].trim()) return alert(`${headers[cols.link]}: enter the drive link for the soft copy.`);
    setState(s => ({ ...s, [i]: 'saving' }));
    try {
      // Guard: someone may have sorted/edited the sheet since we loaded it.
      const cur = await api(token, '/' + a1(colLetter(cols.code) + n));
      if ((cur.values?.[0]?.[0] ?? '') !== r[cols.code]) throw new Error('Sheet changed since you loaded it. Reload the page.');
      await api(token, ':batchUpdate', {
        method: 'POST',
        body: JSON.stringify({
          valueInputOption: 'RAW', // RAW = stored as plain text, never evaluated as a formula
          data: writable(cols).map(j => ({ range: `'${TAB.replace(/'/g, "''")}'!${colLetter(j)}${n}`, values: [[r[j].trim()]] })),
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
      <Header />
      <main className="center">
        <div className="card login">
          <h1>Welcome</h1>
          <p>Track CIE script and assignment submissions for every course, synced live with the department sheet.</p>
          {UNCONFIGURED ? <p className="err">Portal is not configured: set VITE_SHEET_ID and VITE_GOOGLE_CLIENT_ID in .env and restart the server.</p> : (
          <button className="gbtn" onClick={signIn}>
            <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
            Sign in with Google
          </button>
          )}
          {err && <p className="err">{err}</p>}
        </div>
      </main>
    </>
  );
  if (!data) return (
    <>
      <Header />
      <main className="center">
        {err ? <p className="err">{err} <button className="btn" onClick={signIn}>Sign in again</button></p> : <div className="spinner" aria-label="Loading" />}
      </main>
    </>
  );

  const { headers, cols } = data;
  const shown = headers.map((_, j) => j).filter(j => !cols.hidden.includes(j));
  const options = col => [...new Set(rows.map(r => r[col]))].filter(Boolean).sort();
  const q = f.q.toLowerCase();
  const indexed = rows.map((r, i) => [r, i]);

  // Dashboard numbers follow the programme/semester filters, not the search box.
  const scoped = indexed.filter(([r]) => (!f.prog || r[cols.prog] === f.prog) && (!f.sem || r[cols.sem] === f.sem));
  const ynStats = cols.yn.map(j => {
    let y = 0, no = 0;
    for (const [r] of scoped) { const a = yn(r[j]); y += a === 'Y'; no += a === 'N'; }
    return { j, y, no, open: scoped.length - y - no };
  });
  const totalCells = scoped.length * cols.yn.length;
  const pct = totalCells ? Math.round((ynStats.reduce((a, s) => a + s.y, 0) / totalCells) * 100) : 0;
  const notStarted = r => !cols.yn.some(j => yn(r[j]) === 'Y');
  const notStartedCount = scoped.filter(([r]) => notStarted(r)).length;

  const byProg = list => {
    const m = new Map();
    for (const it of list) {
      const k = it[0][cols.prog];
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(it);
    }
    return [...m].sort(([a], [b]) => !a - !b || a.localeCompare(b)); // A–Z, rows without a programme last
  };

  const visible = scoped.filter(([r]) => (!q || r.join(' ').toLowerCase().includes(q)) && (!f.pending || notStarted(r)));
  const groups = group
    ? byProg(visible).map(([key, list]) => ({ key, rows: list, collapsed: !!collapsed[key], pct: ynPct(list, cols.yn) }))
    : [{ key: '', rows: visible, flat: true }];
  const allPages = paginate(groups, size);
  const pages = allPages.length;
  const cur = Math.min(page, pages);
  const pageItems = allPages[cur - 1];
  const tableCols = shown.filter(j => !(group && j === cols.prog)); // the group header already names the programme
  const toggleGroup = k => setCollapsed(c => ({ ...c, [k]: !c[k] }));
  const allCollapsed = group && groups.length > 0 && groups.every(g => g.collapsed);
  const collapseAll = on => { setCollapsed(on ? Object.fromEntries(groups.map(g => [g.key, true])) : {}); setPage(1); };
  const goTo = p => {
    setPage(p);
    // Bring the top of the table back into view, below the sticky logo bar.
    const y = tableTop.current.getBoundingClientRect().top + scrollY - (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-h')) || 0) - 12;
    if (scrollY > y) scrollTo({ top: y, behavior: 'smooth' });
  };
  const bar = n => ({ width: (scoped.length ? (n / scoped.length) * 100 : 0) + '%' });

  return (
    <>
      <Header />
      <main>
        <section className="stats">
          <div className="card hero">
            <Ring pct={pct} />
            <div>
              <div className="eyebrow">Overall progress</div>
              <div className="big">{pct}%</div>
              <div className="muted">of scripts submitted across {scoped.length} course{scoped.length === 1 ? '' : 's'}</div>
            </div>
          </div>
          {ynStats.map(s => (
            <div key={s.j} className="card stat">
              <div className="eyebrow">{headers[s.j]}</div>
              <div className="num">{s.y}<span>/{scoped.length}</span></div>
              <div className="bar-track"><div className="bar-fill" style={bar(s.y)} /></div>
              <div className="split"><span className="kv"><span className="dot yes" />{s.y} yes</span><span className="kv"><span className="dot no" />{s.no} no</span><span className="kv"><span className="dot open" />{s.open} open</span></div>
            </div>
          ))}
          <button className={'card stat pending' + (f.pending ? ' on' : '')} onClick={() => setF({ ...f, pending: !f.pending })}>
            <div className="eyebrow">Not started</div>
            <div className="num">{notStartedCount}</div>
            <div className="muted">{f.pending ? 'Showing only these · click to clear' : 'Click to show only these'}</div>
          </button>
        </section>


        <div className="toolbar">
          <select value={f.prog} onChange={e => setF({ ...f, prog: e.target.value })}>
            <option value="">All programmes</option>
            {options(cols.prog).map(v => <option key={v}>{v}</option>)}
          </select>
          <select value={f.sem} onChange={e => setF({ ...f, sem: e.target.value })}>
            <option value="">All semesters</option>
            {options(cols.sem).map(v => <option key={v} value={v}>Semester {v}</option>)}
          </select>
          <label className="search">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input placeholder="Search course code / title" value={f.q} onChange={e => setF({ ...f, q: e.target.value })} />
          </label>
          <span className="count">{visible.length} course{visible.length === 1 ? '' : 's'}</span>
          <span className="spacer" />
          {group && groups.length > 0 && (
            <button className="btn" onClick={() => collapseAll(!allCollapsed)}>{allCollapsed ? 'Expand all' : 'Collapse all'}</button>
          )}
          <label className="switch">
            <input type="checkbox" checked={group} onChange={e => { setGroup(e.target.checked); setPage(1); }} />
            <span className="track" aria-hidden="true" />
            Group by programme
          </label>
          {err && <span className="err">{err}</span>}
        </div>

        <div className="wrap" ref={tableTop}>
          <table>
            <thead><tr>{tableCols.map(j => <th key={j}>{headers[j]}</th>)}<th /></tr></thead>
            <tbody>
              {pageItems.items.map(item => {
                if (item.head) {
                  const g = item.head;
                  return (
                    <tr key={'g:' + g.key + (item.cont ? ':cont' : '')} className="group-row">
                      <td colSpan={tableCols.length + 1}>
                        <button className="group-btn" onClick={() => toggleGroup(g.key)} aria-expanded={!g.collapsed}>
                          <svg className={'chev' + (g.collapsed ? '' : ' open')} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
                          <span className="group-name">{g.key || '(No programme)'}</span>
                          {item.cont && <span className="muted">(continued)</span>}
                          <span className="group-meta">{g.rows.length} course{g.rows.length === 1 ? '' : 's'}</span>
                          <span className="group-bar"><span style={{ width: g.pct + '%' }} /></span>
                          <span className="group-pct">{g.pct}%</span>
                        </button>
                      </td>
                    </tr>
                  );
                }
                const [r, i] = item.row;
                return (
                  <tr key={i} className={state[i] === 'saving' ? 'dirty' : state[i]}>
                    {tableCols.map(j => {
                      const v = r[j];
                      if (cols.yn.includes(j)) return (
                        <YesNo
                          key={j} label={headers[j]} v={v} via={via[i]?.[j]} linkOnSoft={j === cols.link}
                          onPick={(v, mode) => pickYN(i, j, v, mode)} onLink={v => setCell(i, j, v)}
                        />
                      );
                      if (j === cols.remarks) return <td key={j} className="text"><input className="txt" type="text" placeholder="Remarks (optional)" value={v} onChange={e => setCell(i, j, e.target.value)} /></td>;
                      if (j === cols.code) return <td key={j}><span className="code">{v}</span></td>;
                      return <td key={j}>{v}</td>;
                    })}
                    <td>
                      <button className={'btn' + (state[i] === 'saved' ? ' ok' : state[i] ? ' primary' : '')} disabled={state[i] === 'saving'} onClick={() => save(i)}>
                        {state[i] === 'saving' ? 'Saving…' : state[i] === 'saved' ? 'Saved' : 'Save'}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {!visible.length && <tr><td className="empty" colSpan={tableCols.length + 1}>No courses match these filters.</td></tr>}
            </tbody>
          </table>
        </div>
        {visible.length > 0 && (
          <Pager
            page={cur} pages={pages} from={pageItems.from} to={pageItems.to} size={size} total={visible.length}
            onPage={goTo} onSize={s => { setSize(s); setPage(1); }}
          />
        )}
      </main>
    </>
  );
}

// 1 … 4 5 [6] 7 8 … 20
function pageList(page, pages) {
  const keep = new Set([1, pages, page - 2, page - 1, page, page + 1, page + 2]);
  const out = [];
  for (let p = 1; p <= pages; p++) {
    if (keep.has(p)) out.push(p);
    else if (out[out.length - 1] !== '…') out.push('…');
  }
  return out;
}

// Split groups into pages of `size` course rows. Group headers don't count towards the size; a group that
// runs onto the next page gets its header repeated there as "(continued)". Collapsed groups show only their header.
function paginate(groups, size) {
  const pages = [];
  let page, n = 0, seen = 0;
  const open = () => { page = { items: [], from: seen + 1, to: seen }; pages.push(page); n = 0; };
  open();
  for (const g of groups) {
    if (!g.flat) {
      if (n === size) open();
      page.items.push({ head: g });
    }
    if (g.collapsed) continue;
    for (const row of g.rows) {
      if (n === size) {
        open();
        if (!g.flat) page.items.push({ head: g, cont: true });
      }
      page.items.push({ row });
      n++; seen++; page.to = seen;
    }
  }
  return pages;
}

function Pager({ page, pages, from, to, size, total, onPage, onSize }) {
  return (
    <nav className="pager" aria-label="Pagination">
      <span className="muted">{to >= from ? <>Showing <b>{from}–{to}</b> of <b>{total}</b></> : <><b>{total}</b> courses</>}</span>
      <div className="pages">
        <button className="pg" disabled={page === 1} onClick={() => onPage(page - 1)} >Previous</button>
        {pageList(page, pages).map((p, k) =>
          p === '…' ? <span key={'e' + k} className="pg-gap">…</span>
          : <button key={p} className={'pg' + (p === page ? ' on' : '')} aria-current={p === page ? 'page' : undefined} onClick={() => onPage(p)}>{p}</button>
        )}
        <button className="pg" disabled={page === pages} onClick={() => onPage(page + 1)} >Next</button>
      </div>
      <label className="muted per">
        Rows per page
        <select value={size} onChange={e => onSize(+e.target.value)}>
          {[10, 25, 50, 100].map(n => <option key={n}>{n}</option>)}
        </select>
      </label>
    </nav>
  );
}

function Ring({ pct }) {
  const r = 34, c = 2 * Math.PI * r;
  return (
    <svg className="ring" width="88" height="88" viewBox="0 0 88 88" aria-hidden="true">
      <circle cx="44" cy="44" r={r} className="ring-bg" />
      <circle cx="44" cy="44" r={r} className="ring-fg" strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} />
    </svg>
  );
}

// Popover anchored to a button; closes on outside click, Esc or scroll.
function usePop() {
  const [pos, setPos] = useState(null);
  const anchor = useRef(), pop = useRef();

  useEffect(() => {
    if (!pos) return;
    const onDown = e => !pop.current?.contains(e.target) && !anchor.current?.contains(e.target) && setPos(null);
    const onScroll = e => !pop.current?.contains(e.target) && setPos(null);
    const onKey = e => e.key === 'Escape' && setPos(null);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [pos]);

  function toggle() {
    if (pos) return setPos(null);
    const b = anchor.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(b.left, innerWidth - 288));
    // Flip above the anchor when there isn't room below.
    setPos(b.bottom + 220 > innerHeight ? { left, bottom: innerHeight - b.top + 6 } : { left, top: b.bottom + 6 });
  }

  return { pos, anchor, pop, toggle, close: () => setPos(null) };
}

// Y / N cell. With linkOnSoft, choosing a soft copy turns the cell into a text field for the drive link,
// and the link (not "Y") is what gets saved. A cell loaded with any text other than Y/N is treated as that link.
function YesNo({ label, v, via, linkOnSoft, onPick, onLink }) {
  const a = yn(v);
  const linkMode = linkOnSoft && (via === 'soft' || (a === 'Y' && !/^y$/i.test(v.trim())));
  const mode = via || (linkMode ? 'soft' : undefined);
  const yes = a === 'Y' || linkMode;
  const url = linkMode && v.match(/https?:\/\/\S+/)?.[0];
  const p = usePop();
  const pick = (val, mode) => { onPick(val, mode); p.close(); };

  return (
    <td className="yn">
      <div className="yn-btns">
        <button ref={p.anchor} className={'yn-y' + (yes ? ' on' : '')} onClick={p.toggle} title="Yes — submitted">Y</button>
        <button className={'yn-n' + (a === 'N' ? ' on' : '')} onClick={() => pick(a === 'N' ? '' : 'N')} title="No — not submitted">N</button>
      </div>
      {linkMode ? (
        <>
          <input
            autoFocus={via === 'soft' && !v}
            className={'txt link' + (v.trim() ? '' : ' need')}
            type="text"
            placeholder="Paste drive link"
            value={v}
            onChange={e => onLink(e.target.value)}
          />
          {url && <a className="open" href={url} target="_blank" rel="noreferrer">Open link</a>}
        </>
      ) : yes && via && <span className={'via ' + via}>{via === 'hard' ? 'Hard copy' : 'Soft copy'}</span>}
      {p.pos && (
        <div ref={p.pop} className="pop" style={p.pos}>
          <div className="pop-title">{label}: how was it submitted?</div>
          <div className="seg">
            <button className={mode === 'hard' ? 'on' : ''} onClick={() => pick('Y', 'hard')}>Hard copy</button>
            <button className={mode === 'soft' ? 'on' : ''} onClick={() => pick(linkMode ? v : linkOnSoft ? '' : 'Y', 'soft')}>Soft copy</button>
          </div>
          {linkOnSoft && <p className="hint">Soft copy: paste the drive link in this cell.</p>}
          {(a || linkMode) && <div className="pop-foot"><button className="link-btn" onClick={() => pick('')}>Clear</button></div>}
        </div>
      )}
    </td>
  );
}
