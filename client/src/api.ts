export class ApiError extends Error {
  status: number;
  body: Record<string, unknown> | null;

  constructor(status: number, message: string, body: Record<string, unknown> | null) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export type Me = {
  role: 'admin' | 'user';
  username: string;
  displayName: string;
  mustChangePassword: boolean;
  quotaBytes?: number;
  usedBytes?: number;
};

function csrf() {
  const match = document.cookie.match(/(?:^|; )ic_csrf=([^;]*)/);
  return match ? decodeURIComponent(match[1] ?? '') : '';
}

export async function api<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const headers = new Headers(init.headers);
  const method = (init.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    if (!headers.has('X-CSRF-Token')) headers.set('X-CSRF-Token', csrf());
    if (typeof init.body === 'string' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(path, { ...init, headers, credentials: 'include' });
  if (response.status === 401 && retry && path !== '/api/auth/refresh' && path !== '/api/auth/login' && path !== '/api/auth/admin/phrase') {
    const refreshed = await fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'include',
      headers: { 'X-CSRF-Token': csrf() },
    });
    if (refreshed.ok) return api<T>(path, init, false);
  }
  const text = await response.text();
  const data = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  if (response.status === 403 && data?.code === 'setup') window.location.assign('/setup-account');
  if (!response.ok) throw new ApiError(response.status, String(data?.error ?? response.statusText), data);
  return data as T;
}

export async function ensureCsrf() {
  await fetch('/api/auth/csrf', { credentials: 'include' });
}
