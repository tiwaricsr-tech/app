/**
 * Thin API client. The JWT lives in localStorage and is sent as a bearer token —
 * the server never trusts anything from the client beyond identity, and every
 * stock/billing rule is re-validated server-side inside a transaction.
 */
const TOKEN_KEY = 'stockflow.token';
const USER_KEY = 'stockflow.user';

/**
 * Safe storage.
 *
 * Preview panes render the app inside an iframe with `sandbox="allow-scripts"`,
 * which gives the document an opaque origin — touching `localStorage` there throws
 * a SecurityError and would blank the whole app. So we probe once and transparently
 * fall back to an in-memory store. Same-tab behaviour is identical because the app
 * is a single-page bundle that keeps its token in memory for the session.
 */
const memoryStore = new Map();

const storage = (() => {
  try {
    const probe = '__sf_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return {
      persistent: true,
      get: (k) => { try { return window.localStorage.getItem(k); } catch { return memoryStore.get(k) ?? null; } },
      set: (k, v) => { try { window.localStorage.setItem(k, v); } catch { memoryStore.set(k, v); } },
      remove: (k) => { try { window.localStorage.removeItem(k); } catch { memoryStore.delete(k); } }
    };
  } catch {
    return {
      persistent: false,
      get: (k) => memoryStore.get(k) ?? null,
      set: (k, v) => { memoryStore.set(k, v); },
      remove: (k) => { memoryStore.delete(k); }
    };
  }
})();

export const storagePersistent = storage.persistent;

export const session = {
  get token() { return storage.get(TOKEN_KEY) || ''; },
  set token(v) { v ? storage.set(TOKEN_KEY, v) : storage.remove(TOKEN_KEY); },
  clear() { storage.remove(TOKEN_KEY); storage.remove(USER_KEY); },
  get user() {
    try { return JSON.parse(storage.get(USER_KEY) || 'null'); } catch { return null; }
  },
  set user(u) { u ? storage.set(USER_KEY, JSON.stringify(u)) : storage.remove(USER_KEY); }
};

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message || 'Request failed');
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let onUnauthorized = null;
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

async function request(method, path, body, opts = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = session.token;
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch (networkErr) {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Check your connection and try again.');
  }

  if (res.status === 401 && !opts.silent401) {
    if (onUnauthorized) onUnauthorized();
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    if (!res.ok) throw new ApiError(res.status, 'REQUEST_FAILED', `Request failed (${res.status}).`);
    return res;
  }

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = payload.error || {};
    throw new ApiError(res.status, err.code || 'REQUEST_FAILED', err.message || `Request failed (${res.status}).`, err.details);
  }
  return payload;
}

export const api = {
  get: (path, opts) => request('GET', path, undefined, opts),
  post: (path, body, opts) => request('POST', path, body ?? {}, opts),
  put: (path, body, opts) => request('PUT', path, body ?? {}, opts),
  patch: (path, body, opts) => request('PATCH', path, body ?? {}, opts),
  del: (path, opts) => request('DELETE', path, undefined, opts),

  /** Downloads a binary export with the auth header attached. */
  async download(path, filename) {
    const res = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${session.token}` } });
    if (!res.ok) {
      let message = `Download failed (${res.status}).`;
      try { const j = await res.json(); message = j.error?.message || message; } catch { /* ignore */ }
      throw new ApiError(res.status, 'DOWNLOAD_FAILED', message);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'export';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  },

  /** Opens a PDF in a new tab (with auth) — used for printable invoices. */
  async openPdf(path) {
    const res = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${session.token}` } });
    if (!res.ok) throw new ApiError(res.status, 'PDF_FAILED', 'Could not generate the PDF.');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
};

export const auth = {
  async login(email, password) {
    const data = await api.post('/auth/login', { email, password }, { silent401: true });
    session.token = data.token; session.user = data.user;
    return data.user;
  },
  async register(payload) {
    const data = await api.post('/auth/register', payload, { silent401: true });
    session.token = data.token; session.user = data.user;
    return data.user;
  },
  async me() {
    const data = await api.get('/auth/me');
    session.user = data.user;
    return data.user;
  },
  async refreshMe() { return this.me(); },
  async logout() {
    try { await api.post('/auth/logout'); } catch { /* ignore */ }
    session.clear();
  }
};

export const can = (perm) => {
  const u = session.user;
  if (!u) return false;
  return Array.isArray(u.permissions) && u.permissions.includes(perm);
};
export const isAdmin = () => session.user?.role === 'admin';
