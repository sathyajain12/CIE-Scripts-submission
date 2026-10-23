// Admin portal (/admin on the admin Worker, behind Cloudflare Access): read-only overview of every
// campus tab with filters, .xlsx downloads, a printable report, and the change history.
// Presentation is a plain "examination register": tables and text, one accent colour, status colour
// only for exceptions. Styles live under .admin in style.css.
import { useEffect, useState } from 'react';
import Header, { Band, Footer, SignOutLink } from './Header.jsx';
import logo from '../Image/Header logo.png';
import { parseValues, semNum, yn, ynPct } from './sheet.js';

async function postJson(url, body = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (j.error) throw new Error(j.error);
  return j;
}

async function getJson(url) {
  const res = await fetch(url);
  const j = await res.json().catch(() => ({}));
  if (res.status === 404) throw new Error('The admin portal is not available at this address. Open the admin portal link instead.');
  if (j.error) throw new Error(j.error);
  return j;
}

// Excel helpers; the library is only downloaded when someone exports.
const xlsxFile = () => import('write-excel-file/browser').then(m => m.default);
const xlsxHead = text => ({ value: text, fontWeight: 'bold', textColor: '#FFFFFF', backgroundColor: '#0B3D91', alignVertical: 'center', wrap: true });

const LABELS = ['Block 1', 'Block 2', 'Block 3', 'Assignments', 'Summative'];
const PAGE = 50;

// TODO(deadline): there is no submission deadline in the sheet or in wrangler.jsonc yet, so none is shown.
// When the institute fixes one, set it here as 'YYYY-MM-DD' (or serve it from /api/admin/overview).
// That turns on the "Deadline: <date> · N days left" line and the red "Overdue" cells. Do not guess a date.
const DEADLINE = null;

// One Y/N cell -> what it means. A hard copy is stored as "Y"; a soft copy as the drive link.
function status(v) {
  const a = yn(v);
  if (a === 'Y') return /^y$/i.test(v.trim()) ? { k: 'hard', text: 'Y' } : { k: 'soft', text: 'Soft', link: v.match(/https?:\/\/\S+/)?.[0] || v.trim() };
  return { N: { k: 'no', text: 'N' }, NA: { k: 'na', text: 'NA' }, '': { k: 'open', text: 'Pending' } }[a];
}

// complete: every applicable column is Y. notStarted: nothing is Y yet. pending: anything not yet Y.
function rowState(c) {
  const states = c.campus.cols.yn.map(j => yn(c.row[j])).filter(a => a !== 'NA');
  if (!states.length) return 'na';
  if (states.every(a => a === 'Y')) return 'complete';
  return states.some(a => a === 'Y') ? 'partial' : 'notStarted';
}

const today = () => new Date().toISOString().slice(0, 10);
const hhmm = d => d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });

// me: { email, campuses, admin } from /api/me.
export default function Admin({ me }) {
  const [load, setLoad] = useState(0);
  const [data, setData] = useState(null); // { campuses: [{ name, headers, cols, rows }], missing, user, loadedAt }
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [f, setFilters] = useState({ campus: '', prog: '', sem: '', show: 'pending', q: '' });
  const [page, setPage] = useState(1);
  const [view, setView] = useState('overview'); // 'overview' | 'history'
  const setF = p => { setFilters(x => ({ ...x, ...p })); setPage(1); };

  useEffect(() => {
    setErr('');
    getJson('/api/admin/overview')
      .then(j => setData({
        user: j.user,
        missing: j.missing,
        campuses: j.campuses.map(c => ({ name: c.name, ...parseValues(c.values) })),
        loadedAt: new Date(),
        workflow: j.workflow || {}, // review status per campus
      }))
      .catch(e => setErr(e.message));
  }, [load]);

  if (!data) return (
    <div className="admin">
      <Header />
      <main className="admin-main admin-state">
        {err ? (
          <div className="state-box" role="alert">
            <p>{err}</p>
            <button className="btn-secondary" onClick={() => setLoad(n => n + 1)}>Try again</button>
          </div>
        ) : <p className="muted" aria-live="polite">Loading the register…</p>}
      </main>
    </div>
  );

  // Every course across campuses, tagged with its campus.
  const all = data.campuses.flatMap(campus => campus.rows.map(row => ({ campus, row })));
  const inCampus = all.filter(c => !f.campus || c.campus.name === f.campus);
  const options = col => [...new Set(inCampus.map(c => c.row[c.campus.cols[col]]))].filter(Boolean).sort();
  const q = f.q.toLowerCase();
  const list = inCampus.filter(c => {
    const { cols } = c.campus, s = rowState(c);
    return (!f.prog || c.row[cols.prog] === f.prog) && (!f.sem || c.row[cols.sem] === f.sem)
      && (f.show === 'all' || (f.show === 'pending' ? s === 'partial' || s === 'notStarted' : s === f.show))
      && (!q || c.row.join(' ').toLowerCase().includes(q));
  });
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  const cur = Math.min(page, pages);

  const summary = campus => {
    const pairs = campus.rows.map((r, i) => [r, i]);
    const items = campus.rows.map(row => ({ campus, row }));
    return {
      courses: campus.rows.length,
      pct: ynPct(pairs, campus.cols.yn),
      cols: campus.cols.yn.map(j => ynPct(pairs, [j])),
      // Submitted count out of the courses where the column applies (NA excluded), for the summary table.
      counts: campus.cols.yn.map(j => {
        const a = campus.rows.map(r => yn(r[j]));
        return { y: a.filter(x => x === 'Y').length, n: a.filter(x => x !== 'NA').length };
      }),
      notStarted: items.filter(c => rowState(c) === 'notStarted').length,
      complete: items.filter(c => rowState(c) === 'complete').length,
    };
  };
  const sums = data.campuses.map(c => ({ name: c.name, ...summary(c) }));
  const total = {
    courses: all.length,
    pct: (() => {
      let y = 0, n = 0;
      for (const c of all) for (const j of c.campus.cols.yn) { const a = yn(c.row[j]); if (a !== 'NA') { n++; y += a === 'Y'; } }
      return n ? Math.round((y / n) * 100) : 0;
    })(),
    counts: LABELS.map((_, k) => ({ y: sums.reduce((a, s) => a + s.counts[k].y, 0), n: sums.reduce((a, s) => a + s.counts[k].n, 0) })),
    notStarted: sums.reduce((a, s) => a + s.notStarted, 0),
    complete: sums.reduce((a, s) => a + s.complete, 0),
  };
  const anySubmitted = total.counts.some(c => c.y > 0) || total.complete > 0;

  async function download(kind) {
    setBusy(kind);
    try {
      const writeXlsxFile = await xlsxFile();
      const head = xlsxHead;
      const fill = { hard: '#E4F3EA', soft: '#E2F4F4', no: '#FDECEC', na: '#EFEFEF', open: '#FDF0E3' };
      const courseRows = items => [
        ['Campus', 'Programme', 'Semester', 'Course Code', 'Course Title', ...LABELS, 'Remarks'].map(head),
        ...items.map(c => {
          const { cols } = c.campus;
          return [
            c.campus.name, c.row[cols.prog], c.row[cols.sem], c.row[cols.code], cols.title >= 0 ? c.row[cols.title] : '',
            ...cols.yn.map(j => {
              const s = status(c.row[j]);
              return { value: s.k === 'soft' ? s.link : s.text, backgroundColor: fill[s.k] };
            }),
            c.row[cols.remarks],
          ];
        }),
      ];
      const widths = [{ width: 9 }, { width: 38 }, { width: 10 }, { width: 16 }, { width: 36 }, ...LABELS.map(() => ({ width: 14 })), { width: 30 }];

      if (kind === 'list') {
        await writeXlsxFile(courseRows(list), { columns: widths, stickyRowsCount: 1, sheet: 'Courses' })
          .toFile(`CIE-${f.show}-${f.campus || 'all-campuses'}-${today()}.xlsx`);
      } else {
        const summaryRows = [
          ['Campus', 'Courses', 'Complete', 'Not started', ...LABELS.map(l => l + ' %'), 'Overall %'].map(head),
          ...sums.map(s => [s.name, s.courses, s.complete, s.notStarted, ...s.cols, s.pct]),
          [{ value: 'All campuses', fontWeight: 'bold' }, total.courses, total.complete, total.notStarted, ...LABELS.map(() => ''), { value: total.pct, fontWeight: 'bold' }],
        ];
        await writeXlsxFile([
          { sheet: 'Summary', data: summaryRows, columns: [{ width: 16 }, ...Array(4 + LABELS.length).fill({ width: 13 })], stickyRowsCount: 1 },
          ...data.campuses.map(campus => ({
            sheet: campus.name, data: courseRows(campus.rows.map(row => ({ campus, row }))), columns: widths, stickyRowsCount: 1,
          })),
        ]).toFile(`CIE-report-${today()}.xlsx`);
      }
    } catch (e) {
      alert('Could not create the Excel file: ' + e.message);
    } finally {
      setBusy('');
    }
  }

  const refresh = () => { setData(null); setLoad(n => n + 1); };
  const pageRows = list.slice((cur - 1) * PAGE, cur * PAGE);
  const showRemarks = pageRows.some(c => String(c.row[c.campus.cols.remarks] ?? '').trim());
  const deadline = DEADLINE ? new Date(DEADLINE + 'T23:59:59+05:30') : null;
  const overdue = !!deadline && Date.now() > deadline;
  const daysLeft = deadline ? Math.ceil((deadline - Date.now()) / 86400000) : 0;

  return (
    <div className="admin">
      <div className="screen-only">
        <Header />
        <Band
          title="Admin portal"
          sub={`Signed in as ${data.user} · read-only view of all campuses`}
          aside={<>
            {me?.campuses.length > 0 && <a className="band-link" href="/">Switch portal</a>}
            <SignOutLink />
            {view === 'overview' && (
              <button className="btn-on-band" disabled={!!busy} onClick={() => download('report')}>
                {busy === 'report' ? 'Preparing…' : 'Download full report (.xlsx)'}
              </button>
            )}
          </>}
        />
        <main className="admin-main">

          <div className="utabs" role="tablist" aria-label="Admin views">
            <button role="tab" aria-selected={view === 'overview'} onClick={() => setView('overview')}>Overview</button>
            <button role="tab" aria-selected={view === 'history'} onClick={() => setView('history')}>Change history</button>
          </div>

          {view === 'history' ? <History campuses={data.campuses.map(c => c.name)} /> : <>
            <p className="lede">
              <span><b className="tnum">{total.complete}</b> of <span className="tnum">{total.courses}</span> courses fully submitted</span>
              <span className="sep" aria-hidden="true">·</span>
              <span className="updated">
                Last updated <span className="tnum">{hhmm(data.loadedAt)}</span>
                <button className="icon-btn" onClick={refresh} aria-label="Refresh data" title="Refresh data">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg>
                </button>
              </span>
              {deadline && <>
                <span className="sep" aria-hidden="true">·</span>
                <span>Deadline: {deadline.toLocaleDateString('en-IN', { dateStyle: 'medium' })} · {overdue ? 'passed' : `${daysLeft} day${daysLeft === 1 ? '' : 's'} left`}</span>
              </>}
            </p>
            {data.missing.length > 0 && <p className="muted note">Not in the sheet yet: {data.missing.join(', ')}</p>}

            <ReviewPanel campuses={data.campuses.map(c => c.name)} workflow={data.workflow} onChange={refresh} />

            <section className="section" aria-labelledby="sum-h">
              <h2 id="sum-h">Summary</h2>
              <div className="scroll">
                <SummaryTable rows={sums} total={total} bars={anySubmitted} />
              </div>
            </section>

            <section className="section" aria-labelledby="courses-h">
              <h2 id="courses-h">Courses</h2>
              <div className="filters">
                <select aria-label="Campus" value={f.campus} onChange={e => setF({ campus: e.target.value, prog: '', sem: '' })}>
                  <option value="">All campuses</option>
                  {data.campuses.map(c => <option key={c.name}>{c.name}</option>)}
                </select>
                <select aria-label="Programme" value={f.prog} onChange={e => setF({ prog: e.target.value })}>
                  <option value="">All programmes</option>
                  {options('prog').map(v => <option key={v}>{v}</option>)}
                </select>
                <select aria-label="Semester" value={f.sem} onChange={e => setF({ sem: e.target.value })}>
                  <option value="">All semesters</option>
                  {options('sem').map(v => <option key={v} value={v}>Semester {semNum(v)}</option>)}
                </select>
                <select aria-label="Status" value={f.show} onChange={e => setF({ show: e.target.value })}>
                  <option value="pending">Not fully submitted</option>
                  <option value="notStarted">Not started</option>
                  <option value="partial">Partly submitted</option>
                  <option value="complete">Fully submitted</option>
                  <option value="all">All courses</option>
                </select>
                <input className="search" type="search" aria-label="Search course code or title" placeholder="Search course code or title" value={f.q} onChange={e => setF({ q: e.target.value })} />
                <span className="muted showing">Showing <span className="tnum">{list.length}</span> of <span className="tnum">{all.length}</span> courses</span>
                <span className="grow" />
                <button className="btn-secondary" onClick={() => window.print()}>Print report</button>
                <button className="btn-secondary" disabled={!!busy || !list.length} onClick={() => download('list')}>
                  {busy === 'list' ? 'Preparing…' : 'Download this list (.xlsx)'}
                </button>
              </div>

              <div className="scroll">
                <table className="reg">
                  <thead>
                    <tr>
                      <th scope="col">Campus</th><th scope="col">Programme</th><th scope="col" className="n">Sem</th>
                      <th scope="col">Course code</th><th scope="col">Course title</th>
                      {LABELS.map(l => <th key={l} scope="col" className="c">{l}</th>)}
                      {showRemarks && <th scope="col">Remarks</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((c, k) => {
                      const { cols } = c.campus;
                      return (
                        <tr key={c.campus.name + k + c.row[cols.code]}>
                          <td>{c.campus.name}</td>
                          <td>{c.row[cols.prog]}</td>
                          <td className="n" title={c.row[cols.sem]}>{semNum(c.row[cols.sem])}</td>
                          <td className="mono">{c.row[cols.code]}</td>
                          <td>{cols.title >= 0 ? c.row[cols.title] : ''}</td>
                          {cols.yn.map(j => <td key={j} className="c"><Mark v={c.row[j]} overdue={overdue} /></td>)}
                          {showRemarks && <td className="muted">{c.row[cols.remarks]}</td>}
                        </tr>
                      );
                    })}
                    {!list.length && <tr><td className="empty" colSpan={LABELS.length + 5 + (showRemarks ? 1 : 0)}>No courses match these filters.</td></tr>}
                  </tbody>
                </table>
              </div>
              <Pages cur={cur} pages={pages} count={list.length} onPage={setPage} />
            </section>
          </>}
        </main>
        <Footer />
      </div>
      {view === 'overview' && <PrintReport filters={f} list={list} sums={f.campus ? sums.filter(s => s.name === f.campus) : sums} total={f.campus ? null : total} overdue={overdue} />}
    </div>
  );
}

// Status of one course in one column. Only exceptions get colour: a quiet green tick when submitted,
// a grey dash when not, and red "Overdue" once the deadline (if any) has passed.
function Mark({ v, overdue }) {
  const s = status(v);
  if (s.k === 'hard') return <span className="mark ok" role="img" aria-label="Submitted" title="Submitted (hard copy)">✓</span>;
  if (s.k === 'soft') {
    return s.link.startsWith('http')
      ? <a className="mark ok" href={s.link} target="_blank" rel="noreferrer" aria-label="Submitted, soft copy: open drive link" title={'Soft copy: ' + s.link}>✓</a>
      : <span className="mark ok" role="img" aria-label="Submitted" title="Submitted (soft copy)">✓</span>;
  }
  if (s.k === 'na') return <span className="mark na" title="Not applicable">NA</span>;
  if (overdue) return <span className="mark late">Overdue</span>;
  return <span className="mark none" role="img" aria-label="Not submitted" title={s.k === 'no' ? 'Not submitted (marked N)' : 'Not submitted'}>—</span>;
}

// "12 / 206" with an optional thin bar underneath (only once anything has been submitted).
function Count({ y, n, bars }) {
  return (
    <>
      <span className="tnum">{y} / {n}</span>
      {bars && n > 0 && <span className="cbar" aria-hidden="true"><span style={{ width: (y / n) * 100 + '%' }} /></span>}
    </>
  );
}

function SummaryTable({ rows, total, bars }) {
  return (
    <table className="reg summary">
      <thead>
        <tr>
          <th scope="col">Campus</th><th scope="col" className="n">Courses</th>
          {LABELS.map(l => <th key={l} scope="col" className="n">{l}</th>)}
          <th scope="col" className="n">Fully submitted</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(s => (
          <tr key={s.name}>
            <th scope="row">{s.name}</th>
            <td className="n tnum">{s.courses}</td>
            {s.counts.map((c, k) => <td key={k} className="n"><Count {...c} bars={bars} /></td>)}
            <td className="n"><Count y={s.complete} n={s.courses} bars={bars} /></td>
          </tr>
        ))}
        {total && (
          <tr className="total">
            <th scope="row">Total</th>
            <td className="n tnum">{total.courses}</td>
            {total.counts.map((c, k) => <td key={k} className="n"><Count {...c} bars={bars} /></td>)}
            <td className="n"><Count y={total.complete} n={total.courses} bars={bars} /></td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function Pages({ cur, pages, count, onPage }) {
  if (pages < 2) return null;
  return (
    <nav className="pages-bar" aria-label="Pages">
      <span className="muted">Rows <span className="tnum">{(cur - 1) * PAGE + 1}–{Math.min(cur * PAGE, count)}</span> of <span className="tnum">{count}</span></span>
      <span className="grow" />
      <button className="btn-secondary" disabled={cur === 1} onClick={() => onPage(cur - 1)}>Previous</button>
      <span className="muted">Page <span className="tnum">{cur}</span> of <span className="tnum">{pages}</span></span>
      <button className="btn-secondary" disabled={cur === pages} onClick={() => onPage(cur + 1)}>Next</button>
    </nav>
  );
}

// Shown only when printing (Print report / Ctrl+P): the summary table, then the courses in the current
// filter, grouped by campus and programme, in black and white with the same ✓ / — marks.
function PrintReport({ filters: f, list, sums, total, overdue }) {
  const show = { pending: 'Courses not fully submitted', notStarted: 'Courses not started', partial: 'Partly submitted courses', complete: 'Fully submitted courses', all: 'All courses' }[f.show];
  const scope = [f.campus || 'All campuses', f.prog, f.sem && 'Semester ' + f.sem, f.q && `matching "${f.q}"`].filter(Boolean).join(' · ');
  const now = new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  // Campus order as in the sheet, then programmes A–Z, keeping sheet order within a programme.
  const campusOrder = [...new Set(list.map(c => c.campus.name))];
  const sorted = list.map((c, k) => [c, k]).sort(([a, i], [b, j]) =>
    campusOrder.indexOf(a.campus.name) - campusOrder.indexOf(b.campus.name)
    || String(a.row[a.campus.cols.prog]).localeCompare(String(b.row[b.campus.cols.prog]))
    || i - j).map(([c]) => c);
  const groups = [];
  for (const c of sorted) {
    const key = c.campus.name + '\u0000' + c.row[c.campus.cols.prog];
    if (groups.at(-1)?.key !== key) groups.push({ key, campus: c.campus.name, prog: c.row[c.campus.cols.prog], items: [] });
    groups.at(-1).items.push(c);
  }
  const showRemarks = list.some(c => String(c.row[c.campus.cols.remarks] ?? '').trim());
  return (
    <div className="print-only report">
      <img className="report-logo" src={logo} alt="Sri Sathya Sai Institute of Higher Learning" />
      <h1>CIE scripts submission: status report</h1>
      <p className="report-meta">{scope} · {show} ({list.length}) · Generated {now}</p>

      <h2>Summary</h2>
      <SummaryTable rows={sums} total={total} bars={false} />

      <h2>{show}</h2>
      <p className="legend">✓ submitted (hard or soft copy) · — not submitted · NA not applicable{overdue ? ' · Overdue: past the deadline' : ''}</p>
      {list.length ? (
        <table className="reg report-list">
          <thead><tr><th>Course code</th><th>Course title</th><th className="n">Sem</th>{LABELS.map(l => <th key={l} className="c">{l}</th>)}{showRemarks && <th>Remarks</th>}</tr></thead>
          <tbody>
            {groups.map(g => [
              <tr key={g.key} className="report-group"><td colSpan={LABELS.length + 3 + (showRemarks ? 1 : 0)}>{g.campus} · {g.prog || '(No programme)'} · {g.items.length}</td></tr>,
              ...g.items.map((c, k) => {
                const { cols } = c.campus;
                return (
                  <tr key={g.key + k}>
                    <td className="mono">{c.row[cols.code]}</td>
                    <td>{cols.title >= 0 ? c.row[cols.title] : ''}</td>
                    <td className="n">{semNum(c.row[cols.sem])}</td>
                    {cols.yn.map(j => <td key={j} className="c"><Mark v={c.row[j]} overdue={overdue} /></td>)}
                    {showRemarks && <td>{c.row[cols.remarks]}</td>}
                  </tr>
                );
              }),
            ])}
          </tbody>
        </table>
      ) : <p>No courses match these filters.</p>}
    </div>
  );
}

// Change history: every value changed through the faculty portal, newest first, from the "Change log" tab.
function History({ campuses }) {
  const [log, setLog] = useState(null);
  const [err, setErr] = useState('');
  const [h, setH] = useState({ campus: '', column: '', days: '7', q: '' });
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const set = p => { setH(x => ({ ...x, ...p })); setPage(1); };

  useEffect(() => {
    getJson('/api/admin/history')
      .then(j => setLog((j.values || []).slice(1).filter(r => r[0]).reverse()))
      .catch(e => setErr(e.message));
  }, []);

  if (err) return <div className="state-box" role="alert"><p>{err}</p></div>;
  if (!log) return <p className="muted" aria-live="polite">Loading the change history…</p>;

  // Entries are [time, campus, row, code, title, column, old, new, source]; time is "YYYY-MM-DD HH:mm:ss" IST.
  const since = h.days ? new Date(Date.now() + 330 * 60000 - h.days * 86400000).toISOString().replace('T', ' ').slice(0, 19) : '';
  const q = h.q.toLowerCase();
  const columns = [...new Set(log.map(r => r[5]))].filter(Boolean).sort();
  const list = log.filter(r => (!h.campus || r[1] === h.campus) && (!h.column || r[5] === h.column) && (!since || r[0] >= since)
    && (!q || r.join(' ').toLowerCase().includes(q)));
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  const cur = Math.min(page, pages);
  const show = v => (v ? (/^https?:\/\//.test(v) ? 'Soft copy (link)' : v) : <span className="muted">blank</span>);

  async function download() {
    setBusy(true);
    try {
      const writeXlsxFile = await xlsxFile();
      const head = ['Time (IST)', 'Campus', 'Course Code', 'Course Title', 'Column', 'Old value', 'New value', 'Source'].map(xlsxHead);
      await writeXlsxFile([head, ...list.map(r => [r[0], r[1], r[3], r[4], r[5], r[6] || '', r[7] || '', r[8] || ''])], {
        sheet: 'Change history', stickyRowsCount: 1,
        columns: [{ width: 20 }, { width: 9 }, { width: 16 }, { width: 34 }, { width: 22 }, { width: 30 }, { width: 30 }, { width: 15 }],
      }).toFile(`CIE-change-history-${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (e) {
      alert('Could not create the Excel file: ' + e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section" aria-labelledby="hist-h">
      <h2 id="hist-h">Changes made in the faculty portal</h2>
      <div className="filters">
        <select aria-label="Period" value={h.days} onChange={e => set({ days: e.target.value })}>
          <option value="1">Last 24 hours</option>
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="">All time</option>
        </select>
        <select aria-label="Campus" value={h.campus} onChange={e => set({ campus: e.target.value })}>
          <option value="">All campuses</option>
          {campuses.map(c => <option key={c}>{c}</option>)}
        </select>
        <select aria-label="Column" value={h.column} onChange={e => set({ column: e.target.value })}>
          <option value="">All columns</option>
          {columns.map(c => <option key={c}>{c}</option>)}
        </select>
        <input className="search" type="search" aria-label="Search course code, title or value" placeholder="Search course code, title or value" value={h.q} onChange={e => set({ q: e.target.value })} />
        <span className="muted showing">Showing <span className="tnum">{list.length}</span> of <span className="tnum">{log.length}</span> changes</span>
        <span className="grow" />
        <button className="btn-secondary" disabled={busy || !list.length} onClick={download}>{busy ? 'Preparing…' : 'Download (.xlsx)'}</button>
      </div>
      <div className="scroll">
        <table className="reg">
          <thead><tr><th scope="col">Time (IST)</th><th scope="col">Campus</th><th scope="col">Course code</th><th scope="col">Course title</th><th scope="col">Column</th><th scope="col">Change</th><th scope="col">Changed by</th></tr></thead>
          <tbody>
            {list.slice((cur - 1) * PAGE, cur * PAGE).map((r, k) => (
              <tr key={k}>
                <td className="tnum nowrap">{r[0]}</td>
                <td>{r[1]}</td>
                <td className="mono">{r[3]}</td>
                <td>{r[4]}</td>
                <td>{r[5]}</td>
                <td>
                  <span className="old">{show(r[6])}</span>
                  <span className="to" aria-label="changed to">to</span>
                  {/^https?:\/\//.test(r[7] || '') ? <a className="new" href={r[7]} target="_blank" rel="noreferrer">Soft copy (link)</a> : <span className="new">{show(r[7])}</span>}
                </td>
                <td className="muted">{r[8]}</td>
              </tr>
            ))}
            {!list.length && (
              <tr><td className="empty" colSpan={7}>{log.length ? 'No changes match these filters.' : 'No changes recorded yet. Saves made in the faculty portal will appear here.'}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <Pages cur={cur} pages={pages} count={list.length} onPage={setPage} />
    </section>
  );
}

// Review status of each campus (forward -> director submit / return) and the email connection used for
// the notifications. Admins can reopen a forwarded or submitted campus.
const REVIEW_LABEL = { draft: 'Not forwarded', forwarded: 'Awaiting director review', returned: 'Returned for correction', reopened: 'Reopened for editing', submitted: 'Submitted' };

function ReviewPanel({ campuses, workflow, onChange }) {
  const [mail, setMail] = useState(null); // { connected, sender, storage }
  const [msg, setMsg] = useState(() => {
    const p = new URLSearchParams(location.search).get('email');
    return p ? { ok: p === 'connected', text: p === 'connected' ? 'Email connected. Notifications will be sent from this account.' : p } : null;
  });
  const [busy, setBusy] = useState('');

  useEffect(() => {
    if (new URLSearchParams(location.search).has('email')) history.replaceState(null, '', '/admin');
    getJson('/api/admin/email').then(setMail).catch(e => setMsg({ ok: false, text: e.message }));
  }, []);

  async function run(key, fn, okText) {
    setBusy(key);
    setMsg(null);
    try {
      const r = await fn();
      setMsg({ ok: r?.sent !== false, text: r?.sent === false ? 'Not sent: ' + r.reason : okText });
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy('');
    }
  }

  const reopen = campus => {
    const note = prompt(`Reopen ${campus} for editing? The campus office will be able to change entries and must forward to the director again.\n\nOptional note for the campus office:`);
    if (note === null) return;
    run('reopen-' + campus, async () => { const r = await postJson('/api/workflow/reopen', { campus, note }); onChange(); return r; }, `${campus} reopened.`);
  };

  return (
    <section className="section" aria-labelledby="rev-h">
      <h2 id="rev-h">Review and email</h2>
      <div className="scroll">
        <table className="reg">
          <thead><tr><th scope="col">Campus</th><th scope="col">Status</th><th scope="col">Last step</th><th scope="col">Email</th><th scope="col"><span className="sr-only">Action</span></th></tr></thead>
          <tbody>
            {campuses.map(c => {
              const w = workflow[c] || { status: 'draft' };
              return (
                <tr key={c}>
                  <th scope="row">{c}</th>
                  <td><span className={'wf-tag tag-' + w.status}>{REVIEW_LABEL[w.status] || w.status}</span></td>
                  <td>{w.last ? <><span className="tnum">{w.last.time}</span> · {w.last.by}{w.last.note ? <span className="muted"> · “{w.last.note}”</span> : null}</> : <span className="muted">No activity yet</span>}</td>
                  <td className="muted">{w.last?.email || ''}</td>
                  <td>{['forwarded', 'submitted'].includes(w.status) && <button className="btn-secondary btn-sm" disabled={!!busy} onClick={() => reopen(c)}>Reopen</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mail-row">
        <span>
          Email notifications:{' '}
          {mail ? (mail.connected ? <b>sent from {mail.sender}</b> : <b className="wf-need">not connected</b>) : <span className="muted">checking…</span>}
        </span>
        {mail && !mail.connected && <a className="btn-primary btn-link" href="/api/admin/email/connect">Connect email (coeoffice Gmail)</a>}
        {mail?.connected && <>
          <button className="btn-secondary btn-sm" disabled={!!busy} onClick={() => run('test', () => postJson('/api/admin/email/test'), 'Test email sent to you.')}>Send test email</button>
          <button className="btn-secondary btn-sm" disabled={!!busy} onClick={() => run('disc', async () => { await postJson('/api/admin/email/disconnect'); setMail({ ...mail, connected: false }); }, 'Email disconnected.')}>Disconnect</button>
        </>}
      </div>
      {msg && <p className={msg.ok ? 'wf-msg' : 'wf-msg err'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
    </section>
  );
}
