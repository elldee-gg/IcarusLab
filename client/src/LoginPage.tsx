import { FormEvent, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { api, type Me } from './api';
import { useAuth } from './auth';
export function LoginPage() {
  const { status, me, setMe } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [phrase, setPhrase] = useState('');
  const [forgot, setForgot] = useState(false);
  const [step, setStep] = useState<'login' | 'phrase'>('login');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (status === 'in' && me) {
    if (me.role === 'admin') return <Navigate to="/admin" replace />;
    if (me.mustChangePassword) return <Navigate to="/setup-account" replace />;
    return <Navigate to="/dashboard" replace />;
  }

  async function onLogin(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await api<Me & { step: string }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      if (result.step === 'phrase') {
        setStep('phrase');
        return;
      }
      setMe(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  async function onPhrase(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api<Me>('/api/auth/admin/phrase', { method: 'POST', body: JSON.stringify({ phrase }) });
      setMe(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Phrase check failed');
    } finally {
      setBusy(false);
    }
  }

  async function onForgot(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api<{ message: string }>('/api/auth/forgot', { method: 'POST', body: JSON.stringify({ username }) });
      setMessage(result.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="gate">
      <section className="glass panel login-card">
        <p className="eyebrow">IcarusLab</p>
        <h1>{step === 'phrase' ? 'Admin phrase' : forgot ? 'Forgot password' : 'Sign in'}</h1>
        {step === 'phrase' ? (
          <form onSubmit={onPhrase}>
            <label>
              12 word phrase
              <textarea value={phrase} onChange={(event) => setPhrase(event.target.value)} rows={4} required autoFocus />
            </label>
            {error && <p className="error">{error}</p>}
            <button className="primary" disabled={busy} type="submit">{busy ? 'Checking…' : 'Continue'}</button>
          </form>
        ) : forgot ? (
          <form onSubmit={onForgot}>
            <label>
              Username
              <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required autoFocus />
            </label>
            <p className="hint">This notifies the admin. It does not change the password.</p>
            {message && <p className="ok">{message}</p>}
            {error && <p className="error">{error}</p>}
            <button className="primary" disabled={busy} type="submit">{busy ? 'Sending…' : 'Notify admin'}</button>
            <button className="text" type="button" onClick={() => { setForgot(false); setMessage(''); setError(''); }}>Back to sign in</button>
          </form>
        ) : (
          <form onSubmit={onLogin}>
            <label>
              Username
              <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required autoFocus />
            </label>
            <label>
              Password
              <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
            </label>
            {error && <p className="error">{error}</p>}
            <button className="primary" disabled={busy} type="submit">{busy ? 'Signing in…' : 'Sign in'}</button>
            <button className="text" type="button" onClick={() => { setForgot(true); setError(''); }}>Forgot password</button>
          </form>
        )}
      </section>
    </div>
  );
}
