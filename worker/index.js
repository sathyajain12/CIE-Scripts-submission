// One Worker serves the whole portal. People sign in with Google (Google Identity Services on the page);
// the Worker verifies Google's ID token once, then keeps them signed in with its own signed session cookie.
// The signed-in email is looked up in the spreadsheet's "Users" tab (Email | Role), which decides what the
// person can open:
//   Role "PSN" / "ATP" / "BRN" / "NDG"  -> that campus office's data-entry page (only that sheet tab)
//   Role "Director PSN" (etc.)          -> that campus's director review page (read-only + submit/return)
//   Role "Admin"                        -> the read-only admin overview of all campuses
// Several roles share one cell, separated by commas ("PSN, Director ATP"). Every check happens here on the
// server; the page only decides which screen to show.
//
// Review workflow per campus (recorded in the "Workflow" tab): the campus office forwards to the director
// once every Y/N/NA cell is filled -> entries lock -> the director submits (final; the CoE office is emailed)
// or returns with a note (entries unlock for correction). Admins can reopen. Emails go out through the Gmail
// API as the account an admin connects once (coeoffice), its refresh token kept in Workers KV (STORE).
//
// Secrets: GOOGLE_SERVICE_ACCOUNT (the service account's JSON key; it reads and writes the sheet),
// SESSION_SECRET (random; signs session cookies) and GOOGLE_CLIENT_SECRET (OAuth client secret, for the
// Gmail connection). Vars in wrangler.jsonc: SHEET_ID, CAMPUSES, USERS_TAB, WORKFLOW_TAB, GOOGLE_CLIENT_ID,
// COE_EMAIL. Everything outside /api/* is the Vite build, served from static assets.
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { colLetter } from '../src/cell.js';
import { emails } from './email.js';

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets/';
const GOOGLE_CERTS = 'https://www.googleapis.com/oauth2/v3/certs';
const USERS_TTL = 60_000; // re-read the Users tab at most once a minute
const SESSION_HOURS = 12;
const COOKIE = 'cie_session';
const GMAIL_SCOPE = 'openid email https://www.googleapis.com/auth/gmail.send';
const YN = ['CIE Block-1', 'CIE Block-2', 'CIE Block-3', 'Assignments', 'Summative test']; // must all be filled to forward

// Only these columns can be written (matched on the start of the header, ignoring case and punctuation).
const WRITABLE = ['CIE Block-1', 'CIE Block-2', 'CIE Block-3', 'Assignments', 'Summative test', 'Remarks'];
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      const { pathname } = url;
      // Public: the sign-in page needs the client ID; login and logout manage the session cookie.
      if (pathname === '/api/config' && req.method === 'GET') return json({ clientId: env.GOOGLE_CLIENT_ID || '' });
      if (pathname === '/api/login' && req.method === 'POST') return await login(req, env);
      if (pathname === '/api/logout' && req.method === 'POST') return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(req, '', 0) });

      const user = await currentUser(req, env);
      if (pathname === '/api/me' && req.method === 'GET') return json(user);
      if (pathname === '/api/rows' && req.method === 'GET') {
        const tab = allowView(env, user, url.searchParams.get('campus'));
        return json({ ...(await rows(env, tab)), user: user.email });
      }
      if (pathname === '/api/save' && req.method === 'POST') {
        const body = await req.json().catch(() => null);
        return json(await save(env, allowCampus(user, body?.campus), body, user.email));
      }

      // Review workflow
      if (pathname === '/api/workflow' && req.method === 'GET') {
        const tab = allowView(env, user, url.searchParams.get('campus'));
        return json((await workflowStates(env))[tab] || { status: 'draft', history: [] });
      }
      if (pathname.startsWith('/api/workflow/') && req.method === 'POST') {
        const body = (await req.json().catch(() => null)) || {};
        const action = pathname.slice('/api/workflow/'.length);
        return json(await workflowAction(env, req, user, action, body));
      }

      // Admin
      if (pathname === '/api/admin/overview' && req.method === 'GET') {
        requireAdmin(user);
        const [data, states] = await Promise.all([overview(env), workflowStates(env)]);
        return json({ ...data, workflow: states, user: user.email });
      }
      if (pathname === '/api/admin/history' && req.method === 'GET') {
        requireAdmin(user);
        return json(await history(env));
      }
      if (pathname === '/api/admin/email' && req.method === 'GET') {
        requireAdmin(user);
        return json(await emailStatus(env));
      }
      if (pathname === '/api/admin/email/connect' && req.method === 'GET') {
        requireAdmin(user);
        return gmailConnect(req, env, user);
      }
      if (pathname === '/api/admin/email/callback' && req.method === 'GET') {
        requireAdmin(user);
        return gmailCallback(req, env, user);
      }
      if (pathname === '/api/admin/email/test' && req.method === 'POST') {
        requireAdmin(user);
        return json(await sendMail(env, [user.email], 'CIE portal: test email', emails.test({ base: portalUrl(req) })));
      }
      if (pathname === '/api/admin/email/disconnect' && req.method === 'POST') {
        requireAdmin(user);
        await env.STORE?.delete('gmail_refresh_token');
        await env.STORE?.delete('gmail_sender');
        return json({ ok: true });
      }
      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: e.message }, e.status || 500);
    }
  },
};

// ---- Who is this, and what may they open? ---------------------------------------------------------------

const campusList = env => String(env.CAMPUSES || '').split(',').map(s => s.trim()).filter(Boolean);

// { email, campuses: [...], directs: [...], admin }. campuses = campus offices they enter data for;
// directs = campuses they review as director. An email not in the Users tab gets nothing.
async function currentUser(req, env) {
  const email = await signedInEmail(req, env);
  const roles = (await usersTable(env)).get(email.toLowerCase()) || new Set();
  return {
    email,
    campuses: campusList(env).filter(c => roles.has(c.toUpperCase())),
    directs: campusList(env).filter(c => roles.has('DIRECTOR ' + c.toUpperCase())),
    admin: roles.has('ADMIN'),
  };
}

// Campus office only (data entry).
function allowCampus(user, campus) {
  const tab = user.campuses.find(c => c === campus);
  if (!tab) throw httpError(403, `${user.email} does not have access to ${campus ? 'the ' + campus + ' portal' : 'this portal'}.`);
  return tab;
}

// Director of that campus only.
function allowDirector(user, campus) {
  const tab = user.directs.find(c => c === campus);
  if (!tab) throw httpError(403, `${user.email} is not the director for ${campus || 'this campus'}.`);
  return tab;
}

// Read access: the campus office, its director, or an admin.
function allowView(env, user, campus) {
  if (user.campuses.includes(campus) || user.directs.includes(campus) || (user.admin && campusList(env).includes(campus))) return campus;
  throw httpError(403, `${user.email} does not have access to ${campus ? 'the ' + campus + ' portal' : 'this portal'}.`);
}

function requireAdmin(user) {
  if (!user.admin) throw httpError(403, `${user.email} does not have admin access.`);
}

// The Users tab: column A = email, column B = role(s). Header row optional. Cached briefly.
let users; // { at, map: Map<email, Set<ROLE>> }
async function usersTable(env) {
  if (users && Date.now() - users.at < USERS_TTL) return users.map;
  const tab = env.USERS_TAB || 'Users';
  let values;
  try {
    values = (await sheets(env, '/values/' + encodeURIComponent(tabRange(tab, 'A1:B')))).values || [];
  } catch (e) {
    if (noTab(e)) throw httpError(500, `The spreadsheet has no "${tab}" tab listing who may use the portal.`);
    throw e;
  }
  const map = new Map();
  for (const [email = '', role = ''] of values) {
    const key = email.trim().toLowerCase();
    if (!key.includes('@')) continue; // skips the header row and blanks
    const set = map.get(key) || new Set();
    // Roles are comma-separated; "Director PSN" is one role (inner spaces are normalised).
    for (const r of role.split(/[,;]+/)) { const t = r.trim().replace(/\s+/g, ' ').toUpperCase(); if (t) set.add(t); }
    map.set(key, set);
  }
  users = { at: Date.now(), map };
  return map;
}

// Everyone with a given role, e.g. the directors ("DIRECTOR PSN") or the office ("PSN") of a campus.
async function emailsWithRole(env, role) {
  const out = [];
  for (const [email, roles] of await usersTable(env)) if (roles.has(role)) out.push(email);
  return out;
}

// ---- Google sign-in and the session cookie -------------------------------------------------------------

// POST /api/login { credential }: the ID token from Google's sign-in button. It is checked against Google's
// public keys and this portal's client ID; then a session cookie is set for SESSION_HOURS.
let googleKeys;
async function login(req, env) {
  if (!env.GOOGLE_CLIENT_ID || !env.SESSION_SECRET) throw httpError(500, 'Google sign-in is not configured (GOOGLE_CLIENT_ID / SESSION_SECRET).');
  const { credential } = (await req.json().catch(() => null)) || {};
  if (typeof credential !== 'string') throw httpError(400, 'Bad request.');
  let payload;
  try {
    googleKeys ||= createRemoteJWKSet(new URL(GOOGLE_CERTS));
    ({ payload } = await jwtVerify(credential, googleKeys, { issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: env.GOOGLE_CLIENT_ID }));
  } catch {
    throw httpError(401, 'Google sign-in could not be verified. Please try again.');
  }
  if (!payload.email || payload.email_verified !== true) throw httpError(401, 'This Google account has no verified email address.');
  const token = await signSession(env, { email: payload.email.toLowerCase(), exp: Math.floor(Date.now() / 1000) + SESSION_HOURS * 3600 });
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(req, token, SESSION_HOURS * 3600) });
}

// The signed-in email from the session cookie, or a 401 asking the page to show the sign-in button.
// For local testing only, DEV_EMAIL in .dev.vars stands in for the sign-in. It is honoured only on
// localhost, so it can never open the deployed portal even if it were set there by mistake.
async function signedInEmail(req, env) {
  const local = ['localhost', '127.0.0.1'].includes(new URL(req.url).hostname);
  if (env.DEV_EMAIL && local) return env.DEV_EMAIL;
  const session = await readSession(req, env);
  if (!session) throw httpError(401, 'Please sign in with your Google account.');
  return session.email;
}

// Cookie value: base64url(JSON { email, exp }) + "." + base64url(HMAC-SHA256 of that part with SESSION_SECRET).
// HttpOnly (page scripts can't read it), SameSite=Lax (other sites can't post with it), Secure on https.
const hmacKey = env => crypto.subtle.importKey('raw', new TextEncoder().encode(clean(env.SESSION_SECRET)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

async function signSession(env, data) {
  const part = b64url(new TextEncoder().encode(JSON.stringify(data)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env), new TextEncoder().encode(part));
  return part + '.' + b64url(new Uint8Array(sig));
}

async function readSession(req, env) {
  const raw = (req.headers.get('Cookie') || '').split(/;\s*/).find(c => c.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
  const data = await verifyToken(env, raw);
  return data && data.email && !data.purpose ? data : null;
}

// Checks a token made by signSession: correct signature and not expired. Returns its data or null.
async function verifyToken(env, token) {
  if (!env.SESSION_SECRET) return null;
  const [part, sig] = String(token || '').split('.');
  if (!part || !sig) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(env), fromB64url(sig), new TextEncoder().encode(part));
    if (!ok) return null;
    const data = JSON.parse(new TextDecoder().decode(fromB64url(part)));
    return data.exp > Date.now() / 1000 ? data : null;
  } catch {
    return null;
  }
}

function sessionCookie(req, value, maxAge) {
  const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

// ---- Campus data ----------------------------------------------------------------------------------------

// GET /api/rows?campus=PSN -> { values: [[header...], [row...], ...] }
async function rows(env, tab) {
  const j = await sheets(env, '/values/' + encodeURIComponent(tabRange(tab, 'A1:ZZ')));
  return { values: j.values || [] };
}

// POST /api/save { campus, row, code, cells: [{ col, value }] }
// row is the 1-based sheet row and col a 0-based column. The row's course code must still equal `code`,
// so a sorted or edited sheet is never written to the wrong row.
async function save(env, tab, body, who) {
  const { row, code, cells } = body || {};
  if (!Number.isInteger(row) || row < 2 || typeof code !== 'string' || !Array.isArray(cells) || !cells.length || cells.length > 20) {
    throw httpError(400, 'Bad request.');
  }

  // Header, the row, and the review workflow in one read: entries are locked once forwarded or submitted.
  const ranges = [tabRange(tab, '1:1'), tabRange(tab, `${row}:${row}`), tabRange(workflowTab(env), 'A2:F')];
  const read = async list => (await sheets(env, '/values:batchGet?' + new URLSearchParams(list.map(r => ['ranges', r])))).valueRanges;
  let vr;
  try {
    vr = await read(ranges);
  } catch (e) {
    if (!noTab(e)) throw e;
    vr = [...(await read(ranges.slice(0, 2))), { values: [] }]; // no Workflow tab yet: nothing forwarded
  }
  const [head, current, wf] = vr;
  const state = statesFrom(wf.values || [])[tab];
  if (state && LOCKED.includes(state.status)) {
    throw httpError(423, state.status === 'submitted'
      ? `${tab} has been submitted by the director; entries are final.`
      : `${tab} has been forwarded to the director; entries are locked until the director returns them.`);
  }
  const headers = head.values?.[0] || [];
  const values = current.values?.[0] || [];

  const codeCol = headers.findIndex(h => norm(h).startsWith('coursecode'));
  if (codeCol < 0) throw httpError(500, 'Course Code column not found in the sheet.');
  if ((values[codeCol] ?? '') !== code) throw httpError(409, 'Sheet changed since you loaded it. Reload the page.');

  const allowed = new Set(headers.flatMap((h, i) => (WRITABLE.some(w => norm(h).startsWith(norm(w))) ? [i] : [])));
  for (const c of cells) {
    if (!allowed.has(c?.col) || typeof c.value !== 'string' || c.value.length > 1000) throw httpError(400, 'That column cannot be edited.');
  }

  // Only cells whose value actually changes are written, and each of those is logged.
  const changes = cells
    .map(c => ({ col: c.col, old: values[c.col] ?? '', now: c.value.trim() }))
    .filter(c => c.old !== c.now);
  if (!changes.length) return { ok: true, changed: 0 };

  await sheets(env, '/values:batchUpdate', {
    method: 'POST',
    body: JSON.stringify({
      valueInputOption: 'RAW', // stored as plain text, never evaluated as a formula
      data: changes.map(c => ({ range: tabRange(tab, colLetter(c.col) + row), values: [[c.now]] })),
    }),
  });

  // The save already succeeded; a logging failure is reported but doesn't undo it.
  const titleCol = headers.findIndex(h => norm(h).startsWith('coursetitle'));
  const time = istNow();
  try {
    await appendLog(env, changes.map(c => [
      time, tab, String(row), code, titleCol >= 0 ? values[titleCol] ?? '' : '', headers[c.col], c.old, c.now, who,
    ]));
  } catch (e) {
    return { ok: true, changed: changes.length, logError: e.message };
  }
  return { ok: true, changed: changes.length };
}

// Change history lives in its own tab, created with a header row on first use.
const LOG_HEAD = ['Time (IST)', 'Campus', 'Sheet row', 'Course Code', 'Course Title', 'Column', 'Old value', 'New value', 'Source'];
const logTab = env => env.LOG_TAB || 'Change log';
const noTab = e => /Unable to parse range/i.test(e.message);

async function appendLog(env, rows) {
  const append = values => sheets(env, `/values/${encodeURIComponent(tabRange(logTab(env), 'A1'))}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    body: JSON.stringify({ values }),
  });
  try {
    await append(rows);
  } catch (e) {
    if (!noTab(e)) throw e;
    await sheets(env, ':batchUpdate', {
      method: 'POST',
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: logTab(env), gridProperties: { frozenRowCount: 1 } } } }] }),
    });
    await append([LOG_HEAD, ...rows]);
  }
}

// ---- Review workflow ------------------------------------------------------------------------------------
// The Workflow tab is an append-only record: Time (IST) | Campus | Action | By | Note | Email.
// A campus's status is its latest action: forwarded / submitted (locked), returned / reopened (editable);
// no entry = draft.

const WORKFLOW_HEAD = ['Time (IST)', 'Campus', 'Action', 'By', 'Note', 'Email'];
const LOCKED = ['forwarded', 'submitted'];
const workflowTab = env => env.WORKFLOW_TAB || 'Workflow';

function statesFrom(values) {
  const out = {};
  for (const [time, campus, action, by, note, email] of values) {
    if (!campus || !action) continue;
    const entry = { time, action, by, note: note || '', email: email || '' };
    const s = (out[campus] ||= { status: 'draft', history: [] });
    s.history.push(entry);
    s.status = action;
    s.last = entry;
  }
  return out;
}

async function workflowStates(env) {
  try {
    return statesFrom((await sheets(env, '/values/' + encodeURIComponent(tabRange(workflowTab(env), 'A2:F')))).values || []);
  } catch (e) {
    if (noTab(e)) return {};
    throw e;
  }
}

async function appendWorkflow(env, row) {
  const append = values => sheets(env, `/values/${encodeURIComponent(tabRange(workflowTab(env), 'A1'))}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    body: JSON.stringify({ values }),
  });
  try {
    await append([row]);
  } catch (e) {
    if (!noTab(e)) throw e;
    await sheets(env, ':batchUpdate', {
      method: 'POST',
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: workflowTab(env), gridProperties: { frozenRowCount: 1 } } } }] }),
    });
    await append([WORKFLOW_HEAD, row]);
  }
}

// Empty Y/N/NA cells in a campus tab (rows without a course code are ignored).
async function emptyCells(env, tab) {
  const values = (await rows(env, tab)).values;
  const headers = values[0] || [];
  const codeCol = headers.findIndex(h => norm(h).startsWith('coursecode'));
  const cols = YN.map(n => headers.findIndex(h => norm(h).startsWith(norm(n)))).filter(i => i >= 0);
  let empty = 0, courses = 0;
  for (const r of values.slice(1)) {
    if (!String(r[codeCol] ?? '').trim()) continue;
    courses++;
    for (const j of cols) if (!String(r[j] ?? '').trim()) empty++;
  }
  return { empty, courses };
}

// POST /api/workflow/<forward|return|submit|reopen> { campus, note }
async function workflowAction(env, req, user, action, body) {
  const campus = body.campus;
  const note = String(body.note || '').trim().slice(0, 1000);
  const states = await workflowStates(env);
  const status = states[campus]?.status || 'draft';
  const base = portalUrl(req);
  let mail; // { to, subject, text }

  if (action === 'forward') {
    allowCampus(user, campus);
    if (LOCKED.includes(status)) throw httpError(409, `${campus} is already ${status}.`);
    const { empty, courses } = await emptyCells(env, campus);
    if (empty) throw httpError(400, `${empty} entr${empty === 1 ? 'y is' : 'ies are'} still empty. Every Block, Assignments and Summative cell needs Y, N or NA before forwarding.`);
    // Only the campus's actual director(s): the CoE office is left out even though it holds Director roles
    // (it has them to act on a director's behalf, not to receive the review request).
    const coe = (clean(env.COE_EMAIL) || 'coeoffice@sssihl.edu.in').toLowerCase();
    const to = (await emailsWithRole(env, 'DIRECTOR ' + campus.toUpperCase())).filter(e => e !== coe);
    mail = to.length
      ? { to, subject: `CIE submissions: ${campus} campus forwarded for your review`, ...emails.forward({ base, campus, courses, who: user.email, time: istNow() }) }
      : { skipped: `No director is listed for ${campus} in the Users tab, so no email was sent.` };
  } else if (action === 'return') {
    allowDirector(user, campus);
    if (status !== 'forwarded') throw httpError(409, `${campus} is not waiting for review (status: ${status}).`);
    if (!note) throw httpError(400, 'Please describe the discrepancy so the campus office knows what to correct.');
    const to = await emailsWithRole(env, campus.toUpperCase());
    mail = to.length
      ? { to, subject: `CIE submissions: ${campus} entries returned for correction`, ...emails.return({ base, campus, who: user.email, time: istNow(), note }) }
      : { skipped: `No ${campus} campus office user is listed in the Users tab, so no email was sent.` };
  } else if (action === 'submit') {
    allowDirector(user, campus);
    if (status !== 'forwarded') throw httpError(409, `${campus} is not waiting for review (status: ${status}).`);
    const to = [clean(env.COE_EMAIL) || 'coeoffice@sssihl.edu.in'];
    mail = { to, subject: `CIE submissions: ${campus} campus has submitted`, ...emails.submit({ base, campus, who: user.email, time: istNow() }) };
  } else if (action === 'reopen') {
    requireAdmin(user);
    if (!campusList(env).includes(campus)) throw httpError(400, 'Unknown campus.');
    if (!LOCKED.includes(status)) throw httpError(409, `${campus} is not locked (status: ${status}).`);
    const to = await emailsWithRole(env, campus.toUpperCase());
    mail = to.length
      ? { to, subject: `CIE submissions: ${campus} entries reopened`, ...emails.reopen({ base, campus, who: user.email, time: istNow(), note }) }
      : { skipped: `No ${campus} campus office user is listed in the Users tab, so no email was sent.` };
  } else {
    throw httpError(404, 'Not found');
  }

  const actionName = { forward: 'forwarded', return: 'returned', submit: 'submitted', reopen: 'reopened' }[action];
  const result = mail?.to ? await sendMail(env, mail.to, mail.subject, mail) : { sent: false, reason: mail?.skipped || '' };
  const emailNote = result.sent ? `Sent to ${mail.to.join(', ')}` : `Not sent: ${result.reason}`;
  await appendWorkflow(env, [istNow(), campus, actionName, user.email, note, emailNote]);
  return { ok: true, status: actionName, email: emailNote };
}

// ---- Email (Gmail API, as the account an admin connected) -----------------------------------------------

const portalUrl = req => new URL(req.url).origin;

async function emailStatus(env) {
  const sender = await env.STORE?.get('gmail_sender');
  return { connected: !!(sender && (await env.STORE.get('gmail_refresh_token'))), sender: sender || '', storage: !!env.STORE };
}

// GET /api/admin/email/connect: sends the admin to Google to approve "send email" (gmail.send) once.
async function gmailConnect(req, env, user) {
  if (!env.STORE) throw httpError(500, 'Email storage (KV binding STORE) is not configured.');
  if (!env.GOOGLE_CLIENT_SECRET) throw httpError(500, 'Email is not configured (GOOGLE_CLIENT_SECRET).');
  const state = await signSession(env, { email: user.email, purpose: 'gmail', exp: Math.floor(Date.now() / 1000) + 600 });
  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID, redirect_uri: portalUrl(req) + '/api/admin/email/callback', response_type: 'code',
    scope: GMAIL_SCOPE, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
    login_hint: clean(env.COE_EMAIL) || user.email,
  });
  return Response.redirect(auth.toString(), 302);
}

// GET /api/admin/email/callback?code&state: Google sends the admin back here; keep the refresh token.
async function gmailCallback(req, env, user) {
  const url = new URL(req.url);
  const back = msg => Response.redirect(portalUrl(req) + '/admin?email=' + encodeURIComponent(msg), 302);
  if (url.searchParams.get('error')) return back('Google did not grant permission: ' + url.searchParams.get('error'));
  const state = await verifyToken(env, url.searchParams.get('state'));
  if (!state || state.purpose !== 'gmail' || state.email !== user.email) return back('The connection request expired. Please try again.');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: url.searchParams.get('code') || '', client_id: env.GOOGLE_CLIENT_ID, client_secret: clean(env.GOOGLE_CLIENT_SECRET),
      redirect_uri: portalUrl(req) + '/api/admin/email/callback', grant_type: 'authorization_code',
    }),
  });
  const j = await res.json();
  if (!res.ok || !j.refresh_token) return back('Could not connect email: ' + (j.error_description || j.error || 'no refresh token returned'));
  // The ID token comes straight from Google's token endpoint over TLS, so its email can be read directly.
  const sender = JSON.parse(new TextDecoder().decode(fromB64url(String(j.id_token || '').split('.')[1] || 'e30'))).email || '';
  await env.STORE.put('gmail_refresh_token', j.refresh_token);
  await env.STORE.put('gmail_sender', sender);
  gmailToken = null;
  return back('connected');
}

let gmailToken; // { token, exp }
async function gmailAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (gmailToken && gmailToken.exp - 60 > now) return gmailToken.token;
  const refresh = await env.STORE?.get('gmail_refresh_token');
  if (!refresh) return null;
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token: refresh, client_id: env.GOOGLE_CLIENT_ID, client_secret: clean(env.GOOGLE_CLIENT_SECRET), grant_type: 'refresh_token' }),
  });
  const j = await res.json();
  if (!res.ok) {
    if (j.error === 'invalid_grant') { await env.STORE.delete('gmail_refresh_token'); }
    throw new Error(j.error === 'invalid_grant' ? 'the email connection was revoked or expired; an admin must reconnect it' : (j.error_description || j.error));
  }
  gmailToken = { token: j.access_token, exp: now + j.expires_in };
  return gmailToken.token;
}

// Sends an email with HTML and a plain-text alternative ({ html, text } from worker/email.js).
// Never throws: returns { sent, reason } so a workflow step still completes.
async function sendMail(env, to, subject, { html, text }) {
  try {
    if (!env.STORE || !env.GOOGLE_CLIENT_SECRET) return { sent: false, reason: 'email is not configured' };
    const token = await gmailAccessToken(env);
    if (!token) return { sent: false, reason: 'email is not connected yet (an admin can connect it in the admin portal)' };
    const sender = (await env.STORE.get('gmail_sender')) || '';
    const utf8 = s => b64std(new TextEncoder().encode(s));
    const body = s => utf8(s).replace(/.{1,76}/g, '$&\r\n');
    const boundary = 'cie-' + crypto.randomUUID();
    const mime = [
      `From: =?UTF-8?B?${utf8('CIE Scripts Portal')}?= <${sender}>`,
      `To: ${to.join(', ')}`,
      `Subject: =?UTF-8?B?${utf8(subject)}?=`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      body(text),
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      body(html),
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: b64url(new TextEncoder().encode(mime)) }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      return { sent: false, reason: 'Gmail: ' + (j.error?.message || res.statusText) };
    }
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}

// ---- Admin ----------------------------------------------------------------------------------------------

// GET /api/admin/history -> { values: [[header...], [entry...], ...] } (oldest first, as stored)
async function history(env) {
  try {
    const j = await sheets(env, '/values/' + encodeURIComponent(tabRange(logTab(env), 'A1:I')));
    return { values: j.values || [] };
  } catch (e) {
    if (noTab(e)) return { values: [] }; // nothing has been saved yet
    throw e;
  }
}

// GET /api/admin/overview -> { campuses: [{ name, values }], missing: [tab names not in the sheet] }
// CAMPUSES lists the tabs to include (e.g. "PSN,ATP,BRN,NDG"); tabs that don't exist yet are skipped.
async function overview(env) {
  const wanted = campusList(env);
  const meta = await sheets(env, '?fields=sheets.properties.title');
  const titles = new Set(meta.sheets.map(s => s.properties.title));
  const found = wanted.filter(t => titles.has(t));
  if (!found.length) return { campuses: [], missing: wanted };
  const q = new URLSearchParams();
  for (const t of found) q.append('ranges', tabRange(t, 'A1:ZZ'));
  const { valueRanges } = await sheets(env, '/values:batchGet?' + q);
  return {
    campuses: found.map((name, k) => ({ name, values: valueRanges[k].values || [] })),
    missing: wanted.filter(t => !titles.has(t)),
  };
}

// ---- Google Sheets --------------------------------------------------------------------------------------

// "2026-10-22 09:43:05" in India time (fixed UTC+5:30), so log entries sort as text.
function istNow() {
  return new Date(Date.now() + 330 * 60000).toISOString().replace('T', ' ').slice(0, 19);
}

async function sheets(env, path, init = {}) {
  const res = await fetch(SHEETS + env.SHEET_ID + path, {
    ...init,
    headers: { Authorization: 'Bearer ' + (await accessToken(env)), 'Content-Type': 'application/json' },
  });
  const j = await res.json();
  if (res.status === 403 || res.status === 404) {
    throw httpError(502, 'The service account cannot open the sheet. Share the sheet with the service account email as Editor.');
  }
  if (!res.ok) throw httpError(502, 'Google Sheets: ' + (j.error?.message || res.statusText));
  return j;
}

// Service-account sign-in: a JWT signed with the account's private key is exchanged for an access token,
// which is reused until a minute before it expires.
let cached; // { token, exp }
async function accessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.exp - 60 > now) return cached.token;
  if (!env.GOOGLE_SERVICE_ACCOUNT) throw httpError(500, 'Service account key is not configured (GOOGLE_SERVICE_ACCOUNT secret).');

  const sa = JSON.parse(clean(env.GOOGLE_SERVICE_ACCOUNT));
  const enc = o => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = enc({ alg: 'RS256', typ: 'JWT' }) + '.' + enc({ iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 });
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(sa.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + b64url(new Uint8Array(sig)) }),
  });
  const j = await res.json();
  if (!res.ok) throw httpError(502, 'Service account sign-in failed: ' + (j.error_description || j.error));
  cached = { token: j.access_token, exp: now + j.expires_in };
  return cached.token;
}

// Secrets pasted or piped in on Windows can pick up a byte-order mark or a trailing newline; ignore both.
const clean = s => String(s ?? '').replace(/^﻿/, '').trim();
const tabRange = (tab, r) => `'${tab.replace(/'/g, "''")}'!${r}`;
// Standard base64 of bytes, in chunks so long messages don't overflow the argument list.
const b64std = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const b64url = bytes => b64std(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const pemToDer = pem => Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g, '')), c => c.charCodeAt(0));
const httpError = (status, message) => Object.assign(new Error(message), { status });
const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
