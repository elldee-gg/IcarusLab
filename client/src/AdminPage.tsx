import { FormEvent, useEffect, useState } from 'react';
import { Navigate, Outlet, useOutletContext } from 'react-router-dom';
import { api } from './api';
import { useAuth } from './auth';
import { formatBytes, formatWhen } from './format';
import { AppFrame, Panel, SideNav, Stat, type NavItem } from './shell';
import { AppearanceFields } from './theme';

type UserRow = {
  id: string;
  username: string;
  displayName: string;
  quotaBytes: number;
  usedBytes: number;
  disabled: boolean;
  mustChangePassword: boolean;
  fileCount: number;
};

type Note = { id: string; username: string; createdAt: number; readAt: number | null; userId: string | null };
type Run = { id: string; destination: string; status: string; startedAt: number; finishedAt: number | null; error: string | null; bytesCopied: number };
type Settings = { destination: string; cadence: 'hourly' | 'daily' | 'weekly'; hour: number; minute: number; weekday: number; keep: number; nextRun: number | null };
type Telemetry = {
  sampledAt: number;
  hostname: string;
  platform: string;
  arch: string;
  uptimeSeconds: number;
  cpu: { model: string; percent: number; cores: number[] };
  memory: { usedBytes: number; totalBytes: number };
  processRssBytes: number;
  volumes: { mount: string; usedBytes: number; totalBytes: number; holdsStorage: boolean }[];
  gpus: { name: string; utilization: number | null; memoryUsedBytes: number | null; memoryTotalBytes: number | null; temperatureC: number | null }[];
  gpuNote: string | null;
};

const GIB = 1024 * 1024 * 1024;

export function AdminShell() {
  const { status, me } = useAuth();
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    if (me?.role !== 'admin') return;
    void api<{ notifications: Note[] }>('/api/admin/notifications')
      .then((data) => setUnread(data.notifications.filter((note) => !note.readAt).length))
      .catch(() => setUnread(0));
  }, [me?.role]);

  if (status === 'out') return <Navigate to="/" replace />;
  if (me?.role === 'user') return <Navigate to={me.mustChangePassword ? '/setup-account' : '/dashboard'} replace />;

  const nav: NavItem[] = [
    { to: '/admin', label: 'Dashboard', active: (path) => path === '/admin' },
    { to: '/admin/accounts', label: `Accounts${unread > 0 ? ` (${unread})` : ''}`, active: (path) => path.startsWith('/admin/accounts') },
    { to: '/admin/telemetry', label: 'Telemetry', active: (path) => path.startsWith('/admin/telemetry') },
    { to: '/admin/settings', label: 'Settings', active: (path) => path.startsWith('/admin/settings') },
  ];

  return (
    <AppFrame brand={<span className="brand">IcarusLab admin</span>} nav={<SideNav items={nav} />}>
      <main className="admin">
        <Outlet context={{ setUnread }} />
      </main>
    </AppFrame>
  );
}

export function AdminDashboard() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [disk, setDisk] = useState<{ freeBytes: number; totalBytes: number } | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const [userData, diskData, backupData] = await Promise.all([
        api<{ users: UserRow[] }>('/api/admin/users'),
        api<{ freeBytes: number; totalBytes: number }>('/api/admin/disk'),
        api<{ settings: Settings; runs: Run[] }>('/api/admin/backups'),
      ]);
      setUsers(userData.users);
      setDisk(diskData);
      setSettings(backupData.settings);
      setRuns(backupData.runs);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the dashboard');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function saveBackup(event: FormEvent) {
    event.preventDefault();
    if (!settings) return;
    await api('/api/admin/backups', { method: 'PUT', body: JSON.stringify(settings) });
    await load();
  }

  const used = users.reduce((sum, user) => sum + user.usedBytes, 0);
  const quota = users.reduce((sum, user) => sum + user.quotaBytes, 0);
  const ranked = [...users].sort((a, b) => b.usedBytes - a.usedBytes);

  return (
    <>
      {loading && <p className="hint">Loading…</p>}
      {error && <p className="error">{error}</p>}
      <div className="stat-grid">
        <Stat label="Accounts" value={users.length} />
        <Stat label="Stored" value={formatBytes(used)} detail={`of ${formatBytes(quota)} assigned`} />
        <Stat label="Files" value={users.reduce((sum, user) => sum + user.fileCount, 0)} />
        <Stat label="Free on this disk" value={disk ? formatBytes(disk.freeBytes) : '—'} detail={disk ? `of ${formatBytes(disk.totalBytes)}` : undefined} />
      </div>
      <Panel title="Storage by account">
        {ranked.length === 0 && <p className="empty">No accounts yet.</p>}
        {ranked.map((user) => {
          const percent = user.quotaBytes > 0 ? Math.min(100, (user.usedBytes / user.quotaBytes) * 100) : 0;
          return (
            <div className="usage-row" key={user.id}>
              <div className="usage-name">
                <strong>{user.username}</strong>
                <span>{user.displayName || 'No display name'}{user.disabled ? ' · disabled' : ''}</span>
              </div>
              <div className={`meter${percent >= 90 ? ' hot' : ''}`}><div style={{ width: `${percent}%` }} /></div>
              <span className="usage-figures">{formatBytes(user.usedBytes)} of {formatBytes(user.quotaBytes)} · {user.fileCount} files</span>
            </div>
          );
        })}
      </Panel>
      <Panel title="Backups">
        <p className="hint">Restore with the server stopped: replace data and storage with a finished copy, then start again with the same admin environment variables.</p>
        {settings && (
          <form className="stack" onSubmit={(event) => void saveBackup(event)}>
            <label>Destination folder<input value={settings.destination} onChange={(event) => setSettings({ ...settings, destination: event.target.value })} placeholder="D:\IcarusBackups" /></label>
            <div className="field-grid">
              <label>Cadence
                <select value={settings.cadence} onChange={(event) => setSettings({ ...settings, cadence: event.target.value as Settings['cadence'] })}>
                  <option value="hourly">Hourly</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                </select>
              </label>
              <label>Hour<input type="number" min={0} max={23} value={settings.hour} onChange={(event) => setSettings({ ...settings, hour: Number(event.target.value) })} /></label>
              <label>Minute<input type="number" min={0} max={59} value={settings.minute} onChange={(event) => setSettings({ ...settings, minute: Number(event.target.value) })} /></label>
              <label>Weekday<input type="number" min={0} max={6} value={settings.weekday} onChange={(event) => setSettings({ ...settings, weekday: Number(event.target.value) })} /></label>
              <label>Copies to keep<input type="number" min={1} max={100} value={settings.keep} onChange={(event) => setSettings({ ...settings, keep: Number(event.target.value) })} /></label>
            </div>
            <div className="modal-actions">
              <button type="submit">Save schedule</button>
              <button className="primary" type="button" onClick={() => void api('/api/admin/backups/run', { method: 'POST' }).then(load)}>Back up now</button>
            </div>
            {settings.nextRun && <p className="hint">Next run {formatWhen(settings.nextRun)}</p>}
          </form>
        )}
        {runs.map((run) => (
          <p key={run.id}>{run.status} · {formatWhen(run.startedAt)} · {formatBytes(Number(run.bytesCopied))} · {run.destination}{run.error ? ` · ${run.error}` : ''}</p>
        ))}
      </Panel>
    </>
  );
}

export function AdminAccounts() {
  const { setUnread } = useOutletContext<{ setUnread: (count: number) => void }>();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [username, setUsername] = useState('');
  const [quota, setQuota] = useState(10);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const [userData, noteData] = await Promise.all([
        api<{ users: UserRow[] }>('/api/admin/users'),
        api<{ notifications: Note[] }>('/api/admin/notifications'),
      ]);
      setUsers(userData.users);
      setNotes(noteData.notifications);
      setUnread(noteData.notifications.filter((note) => !note.readAt).length);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load accounts');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function createUser(event: FormEvent) {
    event.preventDefault();
    await api('/api/admin/users', { method: 'POST', body: JSON.stringify({ username, quotaBytes: Math.round(quota * GIB) }) });
    setUsername('');
    await load();
  }

  return (
    <>
      {loading && <p className="hint">Loading…</p>}
      {error && <p className="error">{error}</p>}
      <Panel title="Password requests">
        <p className="hint">A request never changes a password. Reset is a separate button and sets the password back to password.</p>
        {notes.length === 0 && <p>No requests.</p>}
        {notes.map((note) => (
          <div className="admin-row" key={note.id}>
            <span>{note.username}</span>
            <span>{formatWhen(note.createdAt)}{note.readAt ? '' : ' · unread'}</span>
            <button type="button" onClick={() => void api(`/api/admin/notifications/${note.id}/read`, { method: 'POST' }).then(load)}>Mark read</button>
            {note.userId && <button type="button" onClick={() => void api(`/api/admin/users/${note.userId}/reset-password`, { method: 'POST' }).then(load)}>Reset password</button>}
          </div>
        ))}
      </Panel>
      <Panel title="Accounts">
        <form className="create-user" onSubmit={(event) => void createUser(event)}>
          <input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="username" required />
          <input type="number" min={1} value={quota} onChange={(event) => setQuota(Number(event.target.value))} aria-label="Quota in gibibytes" />
          <span className="unit">GiB</span>
          <button className="primary" type="submit">Create user</button>
        </form>
        <p className="hint">New users sign in with the password password, then choose their own.</p>
        {users.map((user) => (
          <div className="person" key={user.id}>
            <strong>{user.username}</strong>
            <span>{user.displayName || 'No display name'}</span>
            <span>{formatBytes(user.usedBytes)} used</span>
            <input type="number" min={1} defaultValue={Math.max(1, Math.round(user.quotaBytes / GIB))} aria-label={`Quota for ${user.username}`} onBlur={(event) => void api(`/api/admin/users/${user.id}`, { method: 'PATCH', body: JSON.stringify({ quotaBytes: Math.round(Number(event.target.value) * GIB) }) }).then(load)} />
            <label className="check"><input type="checkbox" checked={user.disabled} onChange={(event) => void api(`/api/admin/users/${user.id}`, { method: 'PATCH', body: JSON.stringify({ disabled: event.target.checked }) }).then(load)} /> Disabled</label>
            <button type="button" onClick={() => void api(`/api/admin/users/${user.id}/reset-password`, { method: 'POST' }).then(load)}>Reset password</button>
            <button type="button" className="danger" onClick={() => { if (window.confirm(`Delete ${user.username} and all of their files?`)) void api(`/api/admin/users/${user.id}`, { method: 'DELETE' }).then(load); }}>Delete</button>
          </div>
        ))}
      </Panel>
    </>
  );
}

export function AdminTelemetry() {
  const [data, setData] = useState<Telemetry | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let stopped = false;
    async function load() {
      try {
        const next = await api<Telemetry>('/api/admin/telemetry');
        if (!stopped) {
          setData(next);
          setError('');
        }
      } catch (err) {
        if (!stopped) setError(err instanceof Error ? err.message : 'Could not read this computer');
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 3000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <>
      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="hint">Reading this computer…</p>}
      {data && (
        <>
          <p className="hint">{data.hostname} · {data.platform} {data.arch} · up {formatUptime(data.uptimeSeconds)} · updated {formatWhen(data.sampledAt)}</p>
          <div className="stat-grid">
            <MeterCard label="Processor" value={`${data.cpu.percent}%`} detail={data.cpu.model} percent={data.cpu.percent} />
            <MeterCard label="Memory" value={formatBytes(data.memory.usedBytes)} detail={`of ${formatBytes(data.memory.totalBytes)} · IcarusLab ${formatBytes(data.processRssBytes)}`} percent={percentOf(data.memory.usedBytes, data.memory.totalBytes)} />
          </div>
          <Panel title="Processor cores">
            <div className="cores">
              {data.cpu.cores.map((percent, index) => (
                <div key={index} title={`Core ${index + 1}: ${percent}%`}>
                  <div className={`meter${percent >= 90 ? ' hot' : ''}`}><div style={{ width: `${percent}%` }} /></div>
                  <span>{percent}%</span>
                </div>
              ))}
            </div>
          </Panel>
          <Panel title="Storage">
            <p className="hint">Uploads stop when less than 512 MiB would remain on the disk that holds files.</p>
            {data.volumes.map((volume) => (
              <div className="usage-row" key={volume.mount}>
                <div className="usage-name">
                  <strong>{volume.mount}</strong>
                  <span>{volume.holdsStorage ? 'Holds IcarusLab files' : 'Other disk'}</span>
                </div>
                <div className={`meter${percentOf(volume.usedBytes, volume.totalBytes) >= 90 ? ' hot' : ''}`}><div style={{ width: `${percentOf(volume.usedBytes, volume.totalBytes)}%` }} /></div>
                <span className="usage-figures">{formatBytes(volume.usedBytes)} of {formatBytes(volume.totalBytes)}</span>
              </div>
            ))}
          </Panel>
          <Panel title="Graphics">
            {data.gpus.length === 0 && <p className="empty">{data.gpuNote ?? 'No graphics adapters reported.'}</p>}
            {data.gpus.map((gpu, index) => (
              <div className="usage-row" key={`${gpu.name}-${index}`}>
                <div className="usage-name">
                  <strong>{gpu.name}</strong>
                  <span>
                    {gpu.memoryTotalBytes !== null ? `${formatBytes(gpu.memoryUsedBytes ?? 0)} of ${formatBytes(gpu.memoryTotalBytes)}` : 'Memory not reported'}
                    {gpu.temperatureC !== null ? ` · ${gpu.temperatureC}°C` : ''}
                  </span>
                </div>
                <div className={`meter${(gpu.utilization ?? 0) >= 90 ? ' hot' : ''}`}><div style={{ width: `${gpu.utilization ?? 0}%` }} /></div>
                <span className="usage-figures">{gpu.utilization === null ? 'Usage not reported' : `${gpu.utilization}%`}</span>
              </div>
            ))}
          </Panel>
        </>
      )}
    </>
  );
}

function MeterCard({ label, value, detail, percent }: { label: string; value: string; detail: string; percent: number }) {
  return (
    <article className="glass panel slim">
      <span className="eyebrow">{label}</span>
      <strong>{value}</strong>
      <div className={`meter${percent >= 90 ? ' hot' : ''}`}><div style={{ width: `${percent}%` }} /></div>
      <span className="hint">{detail}</span>
    </article>
  );
}

function percentOf(used: number, total: number) {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((used / total) * 1000) / 10);
}

export function AdminSettings() {
  const [allowLan, setAllowLan] = useState(true);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  useEffect(() => {
    void api<{ allowLan: boolean }>('/api/admin/settings')
      .then((settings) => setAllowLan(settings.allowLan))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load settings'));
  }, []);

  async function saveLan(next: boolean) {
    setSaved('');
    setError('');
    setAllowLan(next);
    try {
      const settings = await api<{ allowLan: boolean }>('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ allowLan: next }) });
      setAllowLan(settings.allowLan);
      setSaved('Saved');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save settings');
    }
  }

  return (
    <Panel title="Network">
      <label className="check">
        <input type="checkbox" checked={allowLan} onChange={(event) => void saveLan(event.target.checked)} />
        Allow LAN
      </label>
      <p className="hint">When this is on, other computers on this network can open IcarusLab. When it is off, only this computer is accepted. If you turn it off while using the network address, switch to https://localhost:8443.</p>
      <AppearanceFields />
      {error && <p className="error">{error}</p>}
      {saved && <p className="ok">{saved}</p>}
    </Panel>
  );
}

function formatUptime(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  const days = Math.floor(whole / 86400);
  const hours = Math.floor((whole % 86400) / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
