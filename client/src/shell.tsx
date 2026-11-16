import { useEffect, useState, type ReactNode } from 'react';
import { Link, Navigate, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Menu, Search, X } from 'lucide-react';
import { type Me } from './api';
import { useAuth } from './auth';
import { formatBytes } from './format';

const NARROW = '(max-width: 800px)';

export function Heading({ children }: { children: ReactNode }) {
  return <h2>{children}</h2>;
}

export function Panel({ title, className, children }: { title?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={['glass', 'panel', className].filter(Boolean).join(' ')}>
      {title != null && <Heading>{title}</Heading>}
      {children}
    </section>
  );
}

export function Stat({ label, value, detail }: { label: string; value: ReactNode; detail?: ReactNode }) {
  return (
    <article className="glass panel slim">
      <span className="eyebrow">{label}</span>
      <strong>{value}</strong>
      {detail ? <span className="hint">{detail}</span> : null}
    </article>
  );
}

export type NavItem = { to: string; label: ReactNode; active: (pathname: string) => boolean };

export function SideNav({ items }: { items: NavItem[] }) {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return (
    <>
      {items.map((item) => (
        <Link key={item.to} to={item.to} aria-current={item.active(pathname) ? 'page' : undefined} className={item.active(pathname) ? 'active' : ''}>{item.label}</Link>
      ))}
      <button className="nav-logout" type="button" onClick={() => void logout().then(() => navigate('/'))}>Log out</button>
    </>
  );
}

export function AppFrame({ brand, tools, nav, children }: { brand: ReactNode; tools?: ReactNode; nav: ReactNode; children: ReactNode }) {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const query = window.matchMedia(NARROW);
    const apply = () => {
      setNarrow(query.matches);
      if (!query.matches) setOpen(false);
    };
    apply();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, []);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.body.classList.add('menu-open');
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.classList.remove('menu-open');
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="app-shell">
      <header className="topbar glass">
        <button
          className="icon menu-toggle"
          type="button"
          aria-label={open ? 'Close menu' : 'Open menu'}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <X size={16} /> : <Menu size={16} />}
        </button>
        {brand}
        {tools}
      </header>
      <div className="body">
        {narrow && open && <button className="menu-scrim" type="button" aria-label="Close menu" onClick={() => setOpen(false)} />}
        <nav className={`sidebar glass${open ? ' open' : ''}`} inert={narrow && !open ? true : undefined} onClick={() => setOpen(false)}>
          {nav}
        </nav>
        <div className="workspace">{children}</div>
      </div>
    </div>
  );
}

const USER_NAV: NavItem[] = [
  { to: '/dashboard', label: 'My files', active: (path) => path === '/dashboard' || path.startsWith('/dashboard/folder/') || path.startsWith('/dashboard/search') },
  { to: '/calendar', label: 'Calendar', active: (path) => path.startsWith('/calendar') },
  { to: '/dashboard/shared', label: 'Shared with me', active: (path) => path.startsWith('/dashboard/shared') },
  { to: '/dashboard/trash', label: 'Trash', active: (path) => path.startsWith('/dashboard/trash') },
  { to: '/dashboard/settings', label: 'Settings', active: (path) => path.startsWith('/dashboard/settings') },
];

export function UserLayout() {
  const { status, me } = useAuth();
  if (status === 'out') return <Navigate to="/" replace />;
  if (me?.role !== 'user') return <Navigate to="/admin" replace />;
  if (me.mustChangePassword) return <Navigate to="/setup-account" replace />;
  return (
    <AppFrame
      brand={<Link to="/dashboard" className="brand">IcarusLab</Link>}
      tools={<UserTools me={me} />}
      nav={<SideNav items={USER_NAV} />}
    >
      <Outlet />
    </AppFrame>
  );
}

function UserTools({ me }: { me: Me }) {
  return (
    <>
      <FileSearch />
      <div className="cluster">
        <Quota me={me} />
        <span className="who">{me.displayName || me.username}</span>
      </div>
    </>
  );
}

function FileSearch() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const urlQuery = params.get('q') ?? '';
  const [query, setQuery] = useState(urlQuery);
  useEffect(() => { setQuery(urlQuery); }, [urlQuery]);
  return (
    <form className="search" onSubmit={(event) => { event.preventDefault(); navigate(`/dashboard/search?q=${encodeURIComponent(query)}`); }}>
      <Search size={16} />
      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search your files" aria-label="Search files" />
    </form>
  );
}

function Quota({ me }: { me: Me }) {
  if (me.quotaBytes == null || me.usedBytes == null) return null;
  const ratio = Math.min(1, me.usedBytes / me.quotaBytes);
  return (
    <div className="quota" title={`${formatBytes(me.usedBytes)} of ${formatBytes(me.quotaBytes)}`}>
      <span>{formatBytes(me.usedBytes)} of {formatBytes(me.quotaBytes)}</span>
      <div className="bar"><div style={{ width: `${ratio * 100}%` }} /></div>
    </div>
  );
}
