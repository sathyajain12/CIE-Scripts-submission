// One link for everyone. People sign in with Google; /api/me then says which campuses (and admin) the
// signed-in email may open, from the spreadsheet's Users tab. One destination opens directly; several get a
// short chooser. /campus/<CODE> and /admin are the pages; the server re-checks every request.
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import Header, { Band, Footer, SignOutLink } from './Header.jsx';
import './style.css';

const Admin = lazy(() => import('./Admin.jsx')); // only admins download it

function Shell({ title = 'CIE script submissions', sub, aside, children }) {
  return (
    <div className="entry">
      <Header />
      <Band title={title} sub={sub} aside={aside} />
      <main className="entry-main">{children}</main>
      <Footer />
    </div>
  );
}

// Loads Google Identity Services once.
let gisPromise;
const loadGis = () => (gisPromise ||= new Promise((resolve, reject) => {
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.async = true;
  s.onload = resolve;
  s.onerror = () => reject(new Error('Could not load Google sign-in. Check your internet connection and reload.'));
  document.head.appendChild(s);
}));

// "Sign in with Google": Google returns an ID token, which /api/login verifies and swaps for a session cookie.
function SignIn({ onSignedIn }) {
  const btn = useRef();
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      const { clientId } = await fetch('/api/config').then(r => r.json());
      if (!clientId) throw new Error('Google sign-in is not configured for this portal yet.');
      await loadGis();
      if (!live) return;
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: async ({ credential }) => {
          setBusy(true);
          setErr('');
          try {
            const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential }) });
            const j = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(j.error || 'Sign-in failed. Please try again.');
            onSignedIn();
          } catch (e) {
            setErr(e.message);
            setBusy(false);
          }
        },
      });
      window.google.accounts.id.renderButton(btn.current, { theme: 'outline', size: 'large', text: 'signin_with', shape: 'rectangular', width: 300 });
    })().catch(e => live && setErr(e.message));
    return () => { live = false; };
  }, []);

  return (
    <Shell sub="Sri Sathya Sai Institute of Higher Learning">
      <div className="signin">
        <h2>Sign in</h2>
        <p className="muted">Use your SSSIHL Google account. You will be taken to the portal for your campus.</p>
        <div ref={btn} className="gbtn-slot" aria-busy={busy} />
        {busy && <p className="muted" aria-live="polite">Signing you in…</p>}
        {err && <p className="signin-err" role="alert">{err}</p>}
      </div>
    </Shell>
  );
}

function Root() {
  const [me, setMe] = useState(null); // { email, campuses: [...], admin }
  const [needSignIn, setNeedSignIn] = useState(false);
  const [err, setErr] = useState('');
  const [load, setLoad] = useState(0);

  useEffect(() => {
    setErr('');
    fetch('/api/me')
      .then(async res => {
        const j = await res.json().catch(() => ({}));
        if (res.status === 401) return setNeedSignIn(true);
        if (j.error) throw new Error(j.error);
        if (!res.ok) throw new Error('Could not reach the portal. Please reload the page.');
        setNeedSignIn(false);
        setMe(j);
      })
      .catch(e => setErr(e.message));
  }, [load]);

  if (needSignIn) return <SignIn onSignedIn={() => setLoad(n => n + 1)} />;
  if (err) return <Shell><div className="state-box" role="alert"><p>{err}</p></div></Shell>;
  if (!me) return <Shell><p className="muted" aria-live="polite">Loading…</p></Shell>;

  const choices = [
    ...me.campuses.map(c => ({ href: '/campus/' + c, label: `${c} campus`, note: 'Mark script submissions' })),
    ...(me.directs || []).map(c => ({ href: '/director/' + c, label: `${c} director review`, note: 'Review and submit the campus entries' })),
    ...(me.admin ? [{ href: '/admin', label: 'Admin overview', note: 'All campuses, reports and change history' }] : []),
  ];
  const path = location.pathname.replace(/\/+$/, '').toLowerCase() || '/';
  const show = href => {
    if (location.pathname !== href) history.replaceState(null, '', href);
    if (href === '/admin') return <Suspense fallback={null}><Admin me={me} /></Suspense>;
    const [, kind, campus] = href.split('/');
    return <App key={href} campus={campus} me={me} mode={kind === 'director' ? 'director' : 'office'} />;
  };

  const match = choices.find(c => c.href.toLowerCase() === path);
  if (match) return show(match.href);
  if (choices.length === 1) return show(choices[0].href);

  if (!choices.length) {
    return (
      <Shell sub={`Signed in as ${me.email}`} aside={<SignOutLink />}>
        <div className="state-box" role="alert">
          <p>Your email <b>{me.email}</b> is not registered for any campus portal yet.</p>
          <p className="muted">Please ask the CoE office to add you, then reload this page. If you signed in with the wrong account, sign out and try again.</p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell sub={`Signed in as ${me.email} · choose a portal`} aside={<SignOutLink />}>
      <ul className="choices">
        {choices.map(c => (
          <li key={c.href}><a href={c.href}><b>{c.label}</b><span className="muted">{c.note}</span></a></li>
        ))}
      </ul>
    </Shell>
  );
}

createRoot(document.getElementById('root')).render(<Root />);
