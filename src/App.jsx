// Campus data-entry page: staff mark each course's script submission status (Y / N / NA) per component.
// Every change autosaves through the Worker API (worker/index.js), which acts as a Google service account.
import { useEffect, useRef, useState } from 'react';
import Header, { Band, Footer, SignOutLink } from './Header.jsx';
import { courseState, findCols, semNum, writable, yn } from './sheet.js';

// TODO(deadline): there is no submission deadline in the sheet or config yet, so none is shown.
// When the institute fixes one, set it here as 'YYYY-MM-DD' (or serve it from the API) to show
// "Deadline: <date> · N days left" above the summary. Do not guess a date.
const DEADLINE = null;

// Autosave: changes to one row inside SAVE_DELAY go out as one save; typing saves after TEXT_DELAY of quiet
// (or on blur). At most MAX_PARALLEL saves run at once, with retries, to stay inside the Sheets API quota.
const SAVE_DELAY = 700;
const TEXT_DELAY = 800;
const MAX_PARALLEL = 3;
const RETRIES = 2;

// Display names for sheet headers (the sheet itself is not changed).
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const NAMES = {
  sno: 'S.No.', coursecodecc: 'Course code', coursecode: 'Course code', coursetitle: 'Course title', coursetype: 'Course type',
  semester: 'Semester', campus: 'Campus', ciemax: 'CIE max', cieblock1: 'Block 1', cieblock2: 'Block 2', cieblock3: 'Block 3',
  assignments: 'Assignments', remarks: 'Remarks', programmeshortname: 'Programme',
};
const label = h => NAMES[norm(h)] || (norm(h).startsWith('summativetest') ? 'Summative (I papers)' : h);
const MUTED = ['coursetype', 'semester', 'ciemax'];
const STATUS_FILTERS = { all: 'All courses', incomplete: 'Has empty entries', notStarted: 'Not started', partial: 'Partially done', complete: 'Complete' };
const LOCKED = ['forwarded', 'submitted'];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const hhmm = d => d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });

// GET /api/rows?campus= reads the campus tab; POST /api/save writes some of one row's cells.
// The server checks every request against the signed-in user's campuses.
export async function api(path, body) {
  let j;
  try {
    const res = await fetch('/api/' + path, body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : undefined);
    j = await res.json();
  } catch {
    throw new Error('Could not reach the portal API. If you are running locally, start it with: npm run dev:api');
  }
  if (j.error === 'Please sign in with your Google account.') throw new Error('Your sign-in has expired. Reload the page to sign in again.');
  if (j.error) throw new Error(j.error);
  return j;
}

// campus: the sheet tab ('PSN' …); me: { email, campuses, directs, admin } from /api/me.
// mode 'office' = campus office data entry; 'director' = read-only review with Submit / Return.
export default function App({ campus, me, mode = 'office' }) {
  const [wf, setWf] = useState(null); // review workflow: { status, last, history }
  const [wfLoad, setWfLoad] = useState(0);
  const [load, setLoad] = useState(0); // bump to reload the sheet
  const [data, setData] = useState(null); // { headers, cols }
  const [rows, setRowsState] = useState([]);
  // How each "Y" was given this session: row -> col -> 'hard' | 'soft'. The sheet stores "Y" or the drive link.
  const [via, setViaState] = useState({});
  // Save state per row: { s: 'pending' | 'saving' | 'saved' | 'link' | 'failed', msg, at }
  const [saveState, setSaveState] = useState({});
  const [lastSaved, setLastSaved] = useState(null);
  const [err, setErr] = useState('');
  const [f, setFilters] = useState({ prog: '', sem: '', q: '', status: 'all' });
  const [snap, setSnap] = useState(null); // rows matching the status filter when it was chosen
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(25);
  const [group, setGroup] = useState(true); // group table rows by programme
  const [expanded, setExpanded] = useState({}); // programme -> true when opened; every programme starts collapsed
  const tableTop = useRef();

  // Timers and saves read the latest values through refs, not through stale closures.
  const dataRef = useRef(null), rowsRef = useRef([]), savedRef = useRef([]), viaRef = useRef({}), stateRef = useRef({});
  const timers = useRef({}), chains = useRef({}), slots = useRef({ n: 0, q: [] });
  const setRows = next => { rowsRef.current = next; setRowsState(next); };
  const setVia = next => { viaRef.current = next; setViaState(next); };
  const setRowState = (i, s, msg) => {
    const next = { ...stateRef.current };
    if (s) next[i] = { s, msg, at: Date.now() }; else delete next[i];
    stateRef.current = next;
    setSaveState(next);
  };

  useEffect(() => {
    setErr('');
    api('rows?campus=' + encodeURIComponent(campus))
      .then(({ values = [], user }) => {
        const headers = values[0] || [];
        const cols = findCols(headers);
        const loaded = values.slice(1).map(r => headers.map((_, j) => r[j] ?? ''));
        dataRef.current = { headers, cols };
        savedRef.current = loaded.map(r => [...r]); // what the sheet holds, to work out what changed
        setData({ headers, cols, user }); // user: the signed-in email
        setRows(loaded);
        setVia({});
        stateRef.current = {};
        setSaveState({});
      })
      .catch(e => setErr(e.message));
  }, [load, campus]);

  useEffect(() => {
    api('workflow?campus=' + encodeURIComponent(campus)).then(setWf).catch(e => setErr(e.message));
  }, [wfLoad, campus]);

  // Warn before leaving while anything is unsaved, saving, failed or waiting for a drive link.
  useEffect(() => {
    const onLeave = e => {
      if (Object.keys(timers.current).length || Object.values(stateRef.current).some(x => x.s !== 'saved')) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    addEventListener('beforeunload', onLeave);
    return () => removeEventListener('beforeunload', onLeave);
  }, []);

  // ---- Autosave -------------------------------------------------------------------------------------------
  const needsLink = (i, j) => viaRef.current[i]?.[j] === 'soft' && !String(rowsRef.current[i][j]).trim();
  const changed = i => writable(dataRef.current.cols).filter(j => String(rowsRef.current[i][j]).trim() !== String(savedRef.current[i][j]).trim());

  function schedule(i, delay = SAVE_DELAY) {
    clearTimeout(timers.current[i]);
    if (stateRef.current[i]?.s !== 'saving') setRowState(i, 'pending');
    timers.current[i] = setTimeout(() => flush(i), delay);
  }

  // Saves for one row run one after another, so a later change is never overwritten by an earlier one.
  function flush(i) {
    clearTimeout(timers.current[i]);
    delete timers.current[i];
    chains.current[i] = (chains.current[i] || Promise.resolve()).then(() => send(i));
  }

  function slot(fn) {
    return new Promise((resolve, reject) => {
      const run = () => {
        slots.current.n++;
        fn().then(resolve, reject).finally(() => { slots.current.n--; slots.current.q.shift()?.(); });
      };
      if (slots.current.n < MAX_PARALLEL) run(); else slots.current.q.push(run);
    });
  }

  async function send(i) {
    const { cols } = dataRef.current;
    const r = rowsRef.current[i];
    const cells = changed(i).filter(j => !needsLink(i, j)).map(j => ({ col: j, value: String(r[j]).trim() }));
    if (!cells.length) return finish(i, false);
    setRowState(i, 'saving');
    for (let attempt = 0; ; attempt++) {
      try {
        // The API refuses the write if this row's course code no longer matches (sheet sorted or edited).
        await slot(() => api('save', { campus, row: i + 2, code: r[cols.code], cells }));
        break;
      } catch (e) {
        if (attempt < RETRIES && !/Sheet changed|Bad request|cannot be edited/i.test(e.message)) { await sleep(1500 * (attempt + 1) ** 2); continue; }
        setRowState(i, 'failed', e.message); // the user's entry stays on screen; Retry sends it again
        return;
      }
    }
    for (const c of cells) savedRef.current[i][c.col] = c.value;
    setLastSaved(new Date());
    finish(i, true);
  }

  function finish(i, didSave) {
    if (timers.current[i]) return; // more edits are already waiting
    if (changed(i).some(j => !needsLink(i, j))) return flush(i); // edited again while this save was running
    if (dataRef.current.cols.yn.some(j => needsLink(i, j))) return setRowState(i, 'link');
    setRowState(i, didSave || stateRef.current[i]?.s === 'saved' ? 'saved' : null);
  }

  // ---- Editing ---------------------------------------------------------------------------------------------
  const setCell = (i, j, v) => setRows(rowsRef.current.map((r, k) => (k === i ? r.map((x, m) => (m === j ? v : x)) : r)));
  const setMode = (i, j, mode) => setVia({ ...viaRef.current, [i]: { ...viaRef.current[i], [j]: mode } });
  const pick = (i, j, v, mode) => { setCell(i, j, v); setMode(i, j, mode); schedule(i); };
  const typed = (i, j, v) => { setCell(i, j, v); schedule(i, TEXT_DELAY); };
  const typedDone = i => { if (timers.current[i]) flush(i); };
  const retryAll = () => Object.entries(stateRef.current).filter(([, x]) => x.s === 'failed').forEach(([i]) => flush(+i));

  // "Mark all…" in a programme header: fills empty cells (or all, with overwrite) and autosaves each row.
  function markAll(g, j, v, overwrite) {
    for (const [r, i] of g.rows) {
      if (!overwrite && yn(r[j])) continue;
      setCell(i, j, v);
      setMode(i, j, v === 'Y' ? 'hard' : undefined);
      schedule(i, 300);
    }
  }

  if (!data) return (
    <div className="entry">
      <Header />
      <main className="entry-main admin-state">
        {err ? (
          <div className="state-box" role="alert">
            <p>{err}</p>
            <button className="btn-secondary" onClick={() => setLoad(n => n + 1)}>Try again</button>
          </div>
        ) : <p className="muted" aria-live="polite">Loading courses…</p>}
      </main>
    </div>
  );

  const { headers, cols } = data;
  const find = name => headers.findIndex(h => norm(h) === norm(name));
  const snoCol = headers.findIndex(h => norm(h).startsWith('sno'));
  const campusCol = find('Campus');
  const singleCampus = campusCol < 0 || new Set(rows.map(r => r[campusCol]).filter(Boolean)).size <= 1;
  const options = col => [...new Set(rows.map(r => r[col]))].filter(Boolean).sort();
  const q = f.q.toLowerCase();
  const indexed = rows.map((r, i) => [r, i]);

  // Summary numbers follow the programme/semester filters, not the search box.
  const scoped = indexed.filter(([r]) => (!f.prog || r[cols.prog] === f.prog) && (!f.sem || r[cols.sem] === f.sem));
  const ynStats = cols.yn.map(j => {
    let y = 0, no = 0, na = 0;
    for (const [r] of scoped) { const a = yn(r[j]); y += a === 'Y'; no += a === 'N'; na += a === 'NA'; }
    return { j, y, no, na, open: scoped.length - y - no - na };
  });
  const complete = scoped.filter(([r]) => courseState(r, cols.yn) === 'complete').length;

  // The status filter keeps the rows it matched when chosen, so a row doesn't vanish mid-entry.
  const setF = v => {
    setFilters(v);
    setPage(1);
    const match = v.status === 'incomplete' ? r => cols.yn.some(j => !String(r[j]).trim()) : r => courseState(r, cols.yn) === v.status;
    setSnap(v.status === 'all' ? null : new Set(indexed.filter(([r]) => match(r)).map(([, i]) => i)));
  };
  const byProg = list => {
    const m = new Map();
    for (const it of list) {
      const k = it[0][cols.prog];
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(it);
    }
    return [...m].sort(([a], [b]) => !a - !b || a.localeCompare(b)); // A–Z, rows without a programme last
  };

  const visible = scoped.filter(([r, i]) => (!q || r.join(' ').toLowerCase().includes(q)) && (!snap || snap.has(i)));
  const groups = group
    ? byProg(visible).map(([key, list]) => ({ key, rows: list, collapsed: !expanded[key], complete: list.filter(([r]) => courseState(r, cols.yn) === 'complete').length }))
    : [{ key: '', rows: visible, flat: true }];
  const allPages = paginate(groups, size);
  const pages = allPages.length;
  const cur = Math.min(page, pages);
  const pageItems = allPages[cur - 1];
  // S.No. and Course code first (both stay pinned when the table scrolls sideways), then the sheet's columns.
  const restCols = headers.map((_, j) => j).filter(j => !cols.hidden.includes(j) && j !== snoCol && j !== cols.code
    && !(group && j === cols.prog) && !(singleCampus && j === campusCol));
  const span = restCols.length + 3;
  const toggleGroup = k => setExpanded(e => ({ ...e, [k]: !e[k] }));
  const allCollapsed = group && groups.length > 0 && groups.every(g => g.collapsed);
  const collapseAll = on => { setExpanded(on ? {} : Object.fromEntries(groups.map(g => [g.key, true]))); setPage(1); };
  const goTo = p => {
    setPage(p);
    // Bring the top of the table back into view, below the sticky logo bar.
    const y = tableTop.current.getBoundingClientRect().top + scrollY - (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-h')) || 0) - 12;
    if (scrollY > y) scrollTo({ top: y, behavior: 'smooth' });
  };
  const failed = Object.values(saveState).filter(x => x.s === 'failed').length;
  const deadline = DEADLINE ? new Date(DEADLINE + 'T23:59:59+05:30') : null;
  const daysLeft = deadline ? Math.ceil((deadline - Date.now()) / 86400000) : 0;
  const canSwitch = (me?.campuses.length || 0) + (me?.directs?.length || 0) + (me?.admin ? 1 : 0) > 1;
  // A component counts as filled once it has Y / N / NA (or a soft copy is chosen and its link is pending).
  const filled = (r, i) => cols.yn.filter(j => yn(r[j]) || via[i]?.[j] === 'soft').length;
  const pctOf = (n, total) => (total ? (n / total) * 100 : 0) + '%';
  let navRow = 0; // keyboard grid position of each rendered course row

  // Review workflow: entries can only be edited by the campus office while not forwarded / submitted.
  const locked = LOCKED.includes(wf?.status);
  const readOnly = mode !== 'office' || !wf || locked;
  // Every Y/N/NA cell of every course must be filled before forwarding (a soft copy needs its link).
  const emptyCount = rows.reduce((n, r) => (String(r[cols.code] ?? '').trim() ? n + cols.yn.filter(j => !String(r[j]).trim()).length : n), 0);
  const allSaved = !Object.keys(timers.current).length && Object.values(saveState).every(x => x.s === 'saved');
  const showIncomplete = () => { setF({ ...f, status: 'incomplete' }); setExpanded(Object.fromEntries(byProg(indexed).map(([k]) => [k, true]))); };
  const afterAction = () => setWfLoad(n => n + 1);

  return (
    <div className="entry">
      <Header />
      <Band
        title={mode === 'director' ? 'Director review' : 'CIE script submissions'}
        sub={<>
          {campus} campus
          {' · '}
          {data.user && <>Signed in as {data.user}{mode === 'office' ? ' · ' : ''}</>}
          {mode === 'office' && (lastSaved ? <>Last saved <span className="tnum">{hhmm(lastSaved)}</span></> : 'Nothing saved yet this session')}
        </>}
        aside={<>
          {deadline && (
            <div className={'deadline' + (daysLeft < 0 ? ' closed' : daysLeft <= 3 ? ' soon' : '')}>
              <span className="band-sub">Deadline</span> <b>{deadline.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</b>
              <span aria-hidden="true"> · </span>
              <span className="days tnum">{daysLeft < 0 ? 'Closed' : `${daysLeft} day${daysLeft === 1 ? '' : 's'} left`}</span>
            </div>
          )}
          {canSwitch && <a className="band-link" href="/">Switch portal</a>}
          <SignOutLink />
        </>}
      />
      <main className="entry-main">

        <section className="summary-card" aria-label="Submission summary">
          {ynStats.map(s => {
            const total = scoped.length;
            return (
              <div key={s.j} className="sum-cell">
                <div className="sum-head">{label(headers[s.j])}</div>
                <div className="sum-num"><b className="tnum">{s.y}</b><span className="tnum"> / {total}</span> submitted</div>
                <div className="sbar" role="img" aria-label={`Yes ${s.y}, No ${s.no}, Not applicable ${s.na}, Open ${s.open}`}>
                  <span className="seg-y" style={{ width: pctOf(s.y, total) }} />
                  <span className="seg-n" style={{ width: pctOf(s.no, total) }} />
                  <span className="seg-na" style={{ width: pctOf(s.na, total) }} />
                </div>
                <div className="sum-legend tnum">
                  <span><i className="sq y" />Y {s.y}</span> · <span><i className="sq n" />N {s.no}</span> · <span><i className="sq na" />NA {s.na}</span> · <span className="muted"><i className="sq open" />Open {s.open}</span>
                </div>
              </div>
            );
          })}
          <div className="sum-cell">
            <div className="sum-head">Fully submitted</div>
            <div className="sum-num"><b className="tnum">{complete}</b><span className="tnum"> / {scoped.length}</span> courses</div>
            <div className="sbar" role="img" aria-label={`${complete} of ${scoped.length} courses fully submitted`}>
              <span className="seg-done" style={{ width: pctOf(complete, scoped.length) }} />
            </div>
            <div className="sum-legend tnum">
              <span><i className="sq done" />Complete {complete}</span> · <span className="muted"><i className="sq open" />Remaining {scoped.length - complete}</span>
            </div>
          </div>
        </section>

        {wf && (
          <WorkflowBar
            campus={campus} mode={mode} wf={wf} emptyCount={emptyCount} allSaved={allSaved}
            courses={rows.filter(r => String(r[cols.code] ?? '').trim()).length}
            onShowIncomplete={showIncomplete} onDone={afterAction}
          />
        )}

        <div className="filters toolbar-card">
          <select aria-label="Programme" className={f.prog ? 'active' : undefined} value={f.prog} onChange={e => setF({ ...f, prog: e.target.value })}>
            <option value="">All programmes</option>
            {options(cols.prog).map(v => <option key={v}>{v}</option>)}
          </select>
          <select aria-label="Semester" className={f.sem ? 'active' : undefined} value={f.sem} onChange={e => setF({ ...f, sem: e.target.value })}>
            <option value="">All semesters</option>
            {options(cols.sem).map(v => <option key={v} value={v}>Semester {semNum(v)}</option>)}
          </select>
          <select aria-label="Status" className={f.status !== 'all' ? 'active' : undefined} value={f.status} onChange={e => setF({ ...f, status: e.target.value })}>
            {Object.entries(STATUS_FILTERS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <input className={'search' + (f.q ? ' active' : '')} type="search" aria-label="Search course code or title" placeholder="Search course code or title" value={f.q} onChange={e => setF({ ...f, q: e.target.value })} />
          <span className="muted showing">Showing <span className="tnum">{visible.length}</span> of <span className="tnum">{rows.length}</span> courses</span>
          <span className="grow" />
          {group && groups.length > 0 && (
            <button className="btn-secondary btn-sm" onClick={() => collapseAll(!allCollapsed)}>{allCollapsed ? 'Expand all' : 'Collapse all'}</button>
          )}
          <label className="check">
            <input type="checkbox" checked={group} onChange={e => { setGroup(e.target.checked); setPage(1); }} />
            Group by programme
          </label>
        </div>

        {failed > 0 && (
          <div className="banner-fail" role="alert">
            <span>{failed} row{failed === 1 ? '' : 's'} could not be saved. Your entries are still on screen.</span>
            <button className="btn-secondary btn-sm" onClick={retryAll}>Retry all</button>
          </div>
        )}
        {!readOnly && <p className="tip">Tip: use <kbd>Y</kbd> / <kbd>N</kbd> / <kbd>A</kbd> keys and arrows to enter quickly. <kbd>S</kbd> marks a soft copy, <kbd>Backspace</kbd> clears.</p>}
        {readOnly && <p className="tip">{mode === 'director' ? 'Read-only view of the campus entries.' : 'Entries are locked while the review is in progress.'}</p>}

        <div className="grid-wrap" ref={tableTop}>
          <table className="grid">
            <thead>
              <tr>
                <th scope="col" className="stick c1 n">S.No.</th>
                <th scope="col" className="stick c2">Course code</th>
                {restCols.map(j => <th key={j} scope="col" className={cols.yn.includes(j) ? 'st' + (cols.yn.indexOf(j) % 2 === 0 ? ' ct' : '') : undefined}>{label(headers[j])}</th>)}
                <th scope="col"><span className="sr-only">Save status</span></th>
              </tr>
            </thead>
            <tbody>
              {pageItems.items.map(item => {
                if (item.head) {
                  const g = item.head;
                  return (
                    <tr key={'g:' + g.key + (item.cont ? ':cont' : '')} className="group-row">
                      <td colSpan={span}>
                        <div className="gh">
                          <button className="gh-toggle" onClick={() => toggleGroup(g.key)} aria-expanded={!g.collapsed}>
                            <svg className={'chev' + (g.collapsed ? '' : ' open')} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
                            <span className="gh-name">{g.key || '(No programme)'}</span>
                            {item.cont && <span className="muted">(continued)</span>}
                          </button>
                          <span className="muted tnum">{g.rows.length} course{g.rows.length === 1 ? '' : 's'}</span>
                          <span className="gbar" aria-hidden="true"><span style={{ width: pctOf(g.complete, g.rows.length) }} /></span>
                          <span className="muted tnum">{g.complete} complete</span>
                          {!item.cont && !readOnly && <MarkAll g={g} cols={cols} headers={headers} onApply={markAll} />}
                        </div>
                      </td>
                    </tr>
                  );
                }
                const [r, i] = item.row;
                const nr = navRow++;
                let nc = 0;
                // Row state at a glance: untouched, partly filled (amber edge) or all components set (green edge).
                const done = filled(r, i);
                const rowCls = [item.n % 2 === 0 && 'alt', done === cols.yn.length ? 'rs-full' : done > 0 && 'rs-partial'].filter(Boolean).join(' ');
                return (
                  <tr key={i} className={rowCls || undefined}>
                    <td className="stick c1 n muted" title={snoCol >= 0 ? `Sheet S.No. ${r[snoCol]}` : undefined}>{item.n}</td>
                    <td className="stick c2 mono code">{r[cols.code]}</td>
                    {restCols.map(j => {
                      const v = r[j];
                      if (cols.yn.includes(j)) {
                        const c = nc++;
                        return (
                          <td key={j} className={'st' + (c % 2 === 0 ? ' ct' : '')}>
                            <StatusCell
                              name={label(headers[j])} v={v} via={via[i]?.[j]} nav={[nr, c]} readOnly={readOnly}
                              onPick={(val, mode) => pick(i, j, val, mode)} onLink={val => typed(i, j, val)} onLinkDone={() => typedDone(i)}
                            />
                          </td>
                        );
                      }
                      if (j === cols.remarks) {
                        return (
                          <td key={j}>
                            <input className="rem" type="text" aria-label={`Remarks for ${r[cols.code]}`} placeholder={readOnly ? '' : 'Remarks'} value={v} readOnly={readOnly}
                              onChange={e => typed(i, j, e.target.value)} onBlur={() => typedDone(i)} />
                          </td>
                        );
                      }
                      if (j === cols.sem) return <td key={j} className="dim tnum" title={v}>{semNum(v)}</td>;
                      if (j === cols.title) return <td key={j} className="ctitle">{v}</td>;
                      return <td key={j} className={MUTED.includes(norm(headers[j])) ? 'dim' : undefined}>{v}</td>;
                    })}
                    <td className="ss-cell"><SaveState st={saveState[i]} onRetry={() => flush(i)} /></td>
                  </tr>
                );
              })}
              {!visible.length && <tr><td className="empty" colSpan={span}>No courses match these filters.</td></tr>}
            </tbody>
          </table>
        </div>
        {visible.length > 0 && (
          <nav className="pages-bar" aria-label="Pages">
            <span className="muted">{pageItems.to >= pageItems.from ? <>Rows <span className="tnum">{pageItems.from}–{pageItems.to}</span> of <span className="tnum">{visible.length}</span></> : <><span className="tnum">{visible.length}</span> courses</>}</span>
            <span className="grow" />
            <button className="btn-secondary" disabled={cur === 1} onClick={() => goTo(cur - 1)}>Previous</button>
            <span className="muted">Page <span className="tnum">{cur}</span> of <span className="tnum">{pages}</span></span>
            <button className="btn-secondary" disabled={cur === pages} onClick={() => goTo(cur + 1)}>Next</button>
            <label className="muted per">
              Rows per page
              <select value={size} onChange={e => { setSize(+e.target.value); setPage(1); }}>
                {[10, 25, 50, 100].map(n => <option key={n}>{n}</option>)}
              </select>
            </label>
          </nav>
        )}
      </main>
      <Footer />
    </div>
  );
}

// Split groups into pages of `size` course rows, numbering the rows 1, 2, 3… in display order. Group headers
// don't count towards the size; a group that runs onto the next page gets its header repeated as "(continued)".
// Collapsed groups show only their header.
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
      seen++;
      page.items.push({ row, n: seen });
      n++; page.to = seen;
    }
  }
  return pages;
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
    setPos(b.bottom + 240 > innerHeight ? { left, bottom: innerHeight - b.top + 6 } : { left, top: b.bottom + 6 });
  }

  return { pos, anchor, pop, toggle, close: () => setPos(null) };
}

const ARROWS = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };

// Y / N / NA for one component of one course: a radio group that is one Tab stop and takes keys.
// Y is either a hard copy (stored "Y") or a soft copy (stored as the drive link, typed into the cell).
// readOnly: shows the value but ignores clicks and keys (arrow keys still move between cells).
function StatusCell({ name, v, via, nav, readOnly, onPick, onLink, onLinkDone }) {
  const a = yn(v);
  const linkMode = via === 'soft' || (a === 'Y' && !/^y$/i.test(v.trim()));
  const sel = a === 'Y' || linkMode ? 'Y' : a; // 'Y' | 'N' | 'NA' | ''
  const mode = via || (linkMode ? 'soft' : sel === 'Y' ? 'hard' : undefined);
  const url = linkMode && v.match(/https?:\/\/\S+/)?.[0];
  const p = usePop();
  const groupRef = useRef();
  const choose = (val, m) => { onPick(val, m); p.close(); groupRef.current?.focus(); };

  function onKey(e) {
    if (e.altKey || e.ctrlKey || e.metaKey || e.target !== groupRef.current) return;
    const k = e.key.toLowerCase();
    if (readOnly && !ARROWS[e.key]) return;
    if (k === 'y') choose('Y', 'hard');
    else if (k === 's') choose(linkMode ? v : '', 'soft');
    else if (k === 'n') choose('N');
    else if (k === 'a') choose('NA');
    else if (k === 'backspace' || k === 'delete') choose('');
    else if (ARROWS[e.key]) {
      const [dr, dc] = ARROWS[e.key];
      document.querySelector(`[data-nav="${nav[0] + dr}-${nav[1] + dc}"]`)?.focus();
    } else return;
    e.preventDefault();
  }

  const radio = (key, text, word, onClick, ref) => (
    <button ref={ref} type="button" role="radio" tabIndex={-1} className={'opt-' + key.toLowerCase()} aria-checked={sel === key} aria-label={`${name}: ${word}`} aria-disabled={readOnly || undefined} onClick={readOnly ? undefined : onClick}>{text}</button>
  );

  return (
    <>
      <div ref={groupRef} className={'yn3' + (readOnly ? ' ro' : '')} role="radiogroup" aria-label={name} aria-readonly={readOnly || undefined} tabIndex={0} data-nav={`${nav[0]}-${nav[1]}`} data-empty={!sel} onKeyDown={onKey}>
        {radio('Y', 'Y', mode === 'soft' ? 'Yes, soft copy' : 'Yes', p.toggle, p.anchor)}
        {radio('N', 'N', 'No', () => choose(sel === 'N' ? '' : 'N'))}
        {radio('NA', 'NA', 'Not applicable', () => choose(sel === 'NA' ? '' : 'NA'))}
      </div>
      {linkMode && (
        <div className="link-row">
          <input
            autoFocus={via === 'soft' && !v}
            className={'link-in' + (v.trim() ? '' : ' need')}
            type="text"
            aria-label={`${name}: drive link for the soft copy`}
            placeholder="Paste drive link"
            value={v}
            readOnly={readOnly}
            onChange={e => onLink(e.target.value)}
            onBlur={onLinkDone}
          />
          {url && <a className="open-link" href={url} target="_blank" rel="noreferrer">Open</a>}
        </div>
      )}
      {p.pos && (
        <div ref={p.pop} className="pop" style={p.pos} role="dialog" aria-label={`${name}: how was it submitted?`}>
          <div className="pop-title">{name}: how was it submitted?</div>
          <div className="seg">
            <button className={mode === 'hard' ? 'on' : ''} onClick={() => choose('Y', 'hard')}>Hard copy</button>
            <button className={mode === 'soft' ? 'on' : ''} onClick={() => choose(linkMode ? v : '', 'soft')}>Soft copy</button>
          </div>
          <p className="hint">Soft copy: paste the drive link in this cell.</p>
          {sel && <div className="pop-foot"><button className="link-btn" onClick={() => choose('')}>Clear</button></div>}
        </div>
      )}
    </>
  );
}

// Per-row autosave indicator.
function SaveState({ st, onRetry }) {
  if (!st) return null;
  if (st.s === 'pending' || st.s === 'saving') return <span className="ss muted" role="status">Saving…</span>;
  if (st.s === 'saved') return <span key={st.at} className="ss ok" role="status">✓ Saved</span>;
  if (st.s === 'link') return <span className="ss warn" role="status">Drive link needed</span>;
  return <button className="ss fail" onClick={onRetry} title={st.msg}>Failed — retry</button>;
}

// Programme header menu: set one column for every course in the programme (empty cells only, unless overwrite).
function MarkAll({ g, cols, headers, onApply }) {
  const p = usePop();
  const [col, setCol] = useState(cols.yn[0]);
  const [val, setVal] = useState('Y');
  const [over, setOver] = useState(false);
  const count = g.rows.filter(([r]) => over || !yn(r[col])).length;
  const valName = { Y: 'Y (hard copy)', N: 'N', NA: 'NA' }[val];
  const apply = () => {
    const where = g.key || '(No programme)';
    const what = over ? 'Existing entries will be overwritten.' : 'Only empty cells are filled.';
    if (!confirm(`Set ${label(headers[col])} = ${valName} for ${count} course${count === 1 ? '' : 's'} in ${where}?\n${what}`)) return;
    onApply(g, col, val, over);
    p.close();
  };
  return (
    <>
      <button ref={p.anchor} className="btn-secondary btn-sm" onClick={p.toggle} aria-haspopup="dialog">Mark all…</button>
      {p.pos && (
        <div ref={p.pop} className="pop" style={p.pos} role="dialog" aria-label={`Mark all courses in ${g.key || 'this programme'}`}>
          <div className="pop-title">Mark all courses in this programme</div>
          <label className="field">Component
            <select value={col} onChange={e => setCol(+e.target.value)}>
              {cols.yn.map(j => <option key={j} value={j}>{label(headers[j])}</option>)}
            </select>
          </label>
          <label className="field">Value
            <select value={val} onChange={e => setVal(e.target.value)}>
              <option value="Y">Y (hard copy)</option>
              <option value="N">N</option>
              <option value="NA">NA</option>
            </select>
          </label>
          <label className="check"><input type="checkbox" checked={over} onChange={e => setOver(e.target.checked)} /> Overwrite existing entries</label>
          <button className="btn-primary" disabled={!count} onClick={apply}>
            Set {label(headers[col])} = {val} for {count} course{count === 1 ? '' : 's'}
          </button>
        </div>
      )}
    </>
  );
}

// Review status and actions, above the course list.
//  Campus office: "Forward to director" appears only when every Y/N/NA cell is filled and all saves are done.
//  Director: "Submit (no discrepancy)" or "Return for correction" (a note is required) once forwarded.
const STATUS_LABEL = { draft: 'Not forwarded', forwarded: 'Awaiting director review', returned: 'Returned for correction', reopened: 'Reopened for editing', submitted: 'Submitted' };

function WorkflowBar({ campus, mode, wf, emptyCount, allSaved, courses, onShowIncomplete, onDone }) {
  const [busy, setBusy] = useState('');
  const [returning, setReturning] = useState(false);
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState(null); // { ok, text }
  const { status, last } = wf;

  async function act(action, body = {}) {
    setBusy(action);
    setMsg(null);
    try {
      const r = await api('workflow/' + action, { campus, ...body });
      setMsg({ ok: true, text: { forwarded: 'Forwarded to the director.', submitted: 'Submitted. The CoE office has been notified.', returned: 'Returned to the campus office for correction.' }[r.status] + ' Email: ' + r.email });
      setReturning(false);
      setNote('');
      onDone();
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy('');
    }
  }

  const who = last ? <> by <b>{last.by}</b> on <span className="tnum">{last.time}</span></> : null;
  let text;
  if (status === 'forwarded') {
    text = mode === 'director'
      ? <>Forwarded{who}. Check the entries below, then submit them or return them for correction.</>
      : <>Forwarded to the director{who}. Entries are locked until the director submits or returns them.</>;
  } else if (status === 'submitted') {
    text = <>Submitted by the director{who}. The entries are final.</>;
  } else if (status === 'returned') {
    text = <>Returned for correction{who}.{mode === 'office' ? ' Please correct the entries and forward again.' : ''}</>;
  } else if (status === 'reopened') {
    text = <>Reopened for editing by the CoE office{who}.</>;
  } else {
    text = mode === 'director' ? <>The {campus} campus office has not forwarded the entries yet.</> : <>Not yet forwarded to the director.</>;
  }

  let actions = null;
  if (mode === 'office' && !LOCKED.includes(status)) {
    if (emptyCount > 0) {
      actions = <>
        <span className="wf-need"><b className="tnum">{emptyCount}</b> entr{emptyCount === 1 ? 'y is' : 'ies are'} still empty</span>
        <button className="btn-secondary" onClick={onShowIncomplete}>Show courses with empty entries</button>
      </>;
    } else if (!allSaved) {
      actions = <span className="muted">Saving your last changes…</span>;
    } else {
      actions = (
        <button className="btn-primary" disabled={!!busy} onClick={() => {
          if (confirm(`Forward the ${campus} entries (${courses} courses) to the director?\n\nThe entries will be locked until the director submits them or returns them for correction.`)) act('forward');
        }}>{busy === 'forward' ? 'Forwarding…' : 'Forward to director'}</button>
      );
    }
  } else if (mode === 'director' && status === 'forwarded' && !returning) {
    actions = <>
      <button className="btn-secondary" disabled={!!busy} onClick={() => setReturning(true)}>Return for correction</button>
      <button className="btn-primary" disabled={!!busy} onClick={() => {
        if (confirm(`Submit the ${campus} CIE entries?\n\nThis confirms there is no discrepancy. The entries become final and the CoE office is notified.`)) act('submit');
      }}>{busy === 'submit' ? 'Submitting…' : 'Submit (no discrepancy)'}</button>
    </>;
  }

  return (
    <section className={'wf-bar wf-' + status} aria-label="Review status">
      <div className="wf-main">
        <div className="wf-status"><span className="wf-tag">{STATUS_LABEL[status] || status}</span><span>{text}</span></div>
        {last?.note && (status === 'returned' || status === 'reopened') && <p className="wf-note"><b>Note:</b> {last.note}</p>}
        {msg && <p className={msg.ok ? 'wf-msg' : 'wf-msg err'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
      </div>
      {actions && <div className="wf-actions">{actions}</div>}
      {returning && (
        <div className="wf-return">
          <label htmlFor="wf-note">What needs correcting? The campus office will receive this note by email.</label>
          <textarea id="wf-note" rows={3} value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Block 2 for BPAM-301HV should be N, the scripts were not received." />
          <div className="wf-actions">
            <button className="btn-secondary" disabled={!!busy} onClick={() => { setReturning(false); setNote(''); }}>Cancel</button>
            <button className="btn-primary" disabled={!!busy || !note.trim()} onClick={() => act('return', { note })}>{busy === 'return' ? 'Sending…' : 'Return to campus office'}</button>
          </div>
        </div>
      )}
    </section>
  );
}
