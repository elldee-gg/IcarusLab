import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ensureCsrf, type Me } from './api';

type AuthState = {
  status: 'loading' | 'in' | 'out';
  me: Me | null;
  refresh: () => Promise<Me | null>;
  logout: () => Promise<void>;
  setMe: (me: Me | null) => void;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<'loading' | 'in' | 'out'>('loading');
  const [me, setMeState] = useState<Me | null>(null);

  async function refresh() {
    await ensureCsrf();
    try {
      const next = await api<Me>('/api/auth/me');
      setMeState(next);
      setStatus('in');
      return next;
    } catch {
      setMeState(null);
      setStatus('out');
      return null;
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function logout() {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      // The local session is cleared either way.
    }
    setMeState(null);
    setStatus('out');
  }

  function setMe(next: Me | null) {
    setMeState(next);
    setStatus(next ? 'in' : 'out');
  }

  return <AuthContext.Provider value={{ status, me, refresh, logout, setMe }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('Auth is missing');
  return value;
}

export function SessionGate({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  if (status === 'loading') {
    return (
      <div className="gate">
        <section className="glass panel">
          <p className="eyebrow">IcarusLab</p>
          <h1>Checking your session…</h1>
        </section>
      </div>
    );
  }
  return children;
}
