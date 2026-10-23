import { useEffect, useRef } from 'react';
import logo from '../Image/Header logo.png';

export default function Header({ children }) {
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
      {children}
    </header>
  );
}

// Institute-blue title band under the header, finished with a saffron and gold double rule.
// The emblem sits in it as a faint watermark (CSS). `aside` goes on the right (deadline, main action).
export function Band({ title, sub, aside }) {
  return (
    <div className="band">
      <div className="band-inner">
        <div>
          <h1>{title}</h1>
          {sub && <p className="band-sub">{sub}</p>}
        </div>
        {aside && <div className="band-aside">{aside}</div>}
      </div>
    </div>
  );
}

export function Footer() {
  return (
    <footer className="site-foot">
      <div className="foot-name">Sri Sathya Sai Institute of Higher Learning</div>
      <div className="foot-sub">CIE Scripts Submission Portal</div>
    </footer>
  );
}

// Ends the portal session and returns to the sign-in page. Google is told not to sign the person
// straight back in automatically.
export async function signOut() {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  window.google?.accounts?.id?.disableAutoSelect();
  location.href = '/';
}

export function SignOutLink() {
  return <button type="button" className="band-link" onClick={signOut}>Sign out</button>;
}
