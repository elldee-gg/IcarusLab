import { FormEvent, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { api, type Me } from './api';
import { useAuth } from './auth';
export function SetupPage() {
  const { status, me, setMe } = useAuth();
  const [displayName, setDisplayName] = useState(me?.displayName ?? '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (status === 'out') return <Navigate to="/" replace />;
  if (me?.role === 'admin') return <Navigate to="/admin" replace />;
  if (me && !me.mustChangePassword) return <Navigate to="/dashboard" replace />;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (password !== confirm) {
      setError('The two passwords do not match');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const next = await api<Me>('/api/auth/setup', { method: 'POST', body: JSON.stringify({ displayName, password }) });
      setMe(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the account');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="gate">
      <section className="glass panel login-card">
        <p className="eyebrow">First sign-in</p>
        <h1>Set up your account</h1>
        <form onSubmit={onSubmit}>
          <label>
            Display name
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} required autoFocus />
          </label>
          <label>
            New password
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={10} required />
          </label>
          <label>
            Confirm password
            <input type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} minLength={10} required />
          </label>
          <p className="hint">Use at least 10 characters. The temporary password cannot be reused.</p>
          {error && <p className="error">{error}</p>}
          <button className="primary" disabled={busy} type="submit">{busy ? 'Saving…' : 'Continue'}</button>
        </form>
      </section>
    </div>
  );
}
