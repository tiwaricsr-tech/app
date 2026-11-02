import { auth, api, session } from '../api.js';
import { icon } from '../icons.js';
import { esc, toast, buttonLoading } from '../ui.js';

const heroPanel = () => `
  <section class="auth-hero">
    <div class="auth-brand">
      <span class="brand-mark" style="background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.24);box-shadow:none">
        <svg viewBox="0 0 64 64" width="24" height="24" aria-hidden="true">
          <path d="M18 40V26l14-8 14 8v14l-14 8-14-8z" fill="none" stroke="white" stroke-width="3.4" stroke-linejoin="round"/>
          <path d="M18 26l14 8 14-8M32 34v14" stroke="white" stroke-width="3.4" stroke-linejoin="round"/>
        </svg>
      </span>
      <span>
        <span class="brand-name">StockFlow</span>
        <span class="brand-sub">Inventory &amp; Billing</span>
      </span>
    </div>

    <div>
      <h2>Every unit counted. Every bill accounted for.</h2>
      <p class="lead">A single workspace for your catalogue, stock movements, billing and reports — with automatic, transaction-safe stock deduction on every invoice.</p>
      <div class="auth-features">
        <div class="auth-feature"><span class="fi">${icon('inventory')}</span><span><b>Live stock control</b><span>Movement ledger with negative-stock protection</span></span></div>
        <div class="auth-feature"><span class="fi">${icon('invoice')}</span><span><b>Professional billing</b><span>Unique invoices, discounts, printable PDFs</span></span></div>
        <div class="auth-feature"><span class="fi">${icon('reports')}</span><span><b>Reports that reconcile</b><span>Daily &amp; monthly sales, valuation, movement — export to PDF/Excel</span></span></div>
        <div class="auth-feature"><span class="fi">${icon('shield')}</span><span><b>Role-based access</b><span>Admins manage users; staff only bill and view</span></span></div>
      </div>
    </div>

    <div class="auth-foot">© ${new Date().getFullYear()} StockFlow · Secure JWT sessions · Server-side stock validation</div>
  </section>`;

export default function renderLogin(app, navigate) {
  app.innerHTML = `
    <div class="auth-wrap">
      ${heroPanel()}
      <section class="auth-panel">
        <div class="auth-card">
          <h1>Welcome back</h1>
          <p class="sub">Sign in to manage inventory and billing.</p>
          <form class="auth-form" id="login-form" novalidate>
            <div class="field">
              <label for="email">Email address</label>
              <input class="input" id="email" name="email" type="email" autocomplete="username" placeholder="you@company.com" required />
            </div>
            <div class="field">
              <label for="password">Password</label>
              <div style="position:relative">
                <input class="input" id="password" name="password" type="password" autocomplete="current-password" placeholder="••••••••" required style="padding-right:42px" />
                <button type="button" class="btn btn-ghost btn-icon btn-sm" id="toggle-pw" aria-label="Show password"
                  style="position:absolute;right:4px;top:5px;color:var(--muted)">${icon('eye')}</button>
              </div>
            </div>
            <div id="login-error" class="alert alert-red hidden"></div>
            <button class="btn btn-primary btn-lg btn-block" type="button" id="login-btn">Sign in</button>
          </form>
          <div class="auth-switch">Don't have an account? <a href="#/register">Create one</a></div>

          <div class="demo-creds">
            <h5>Demo accounts — click to fill</h5>
            ${[
              ['Administrator', 'admin@stockflow.app', 'Admin@1234', 'badge-blue'],
              ['Manager', 'manager@stockflow.app', 'Manager@1234', 'badge-violet'],
              ['Billing Staff', 'staff@stockflow.app', 'Staff@1234', 'badge-gray']
            ].map(([role, email, pw, cls]) => `
              <div class="demo-row">
                <span class="badge ${cls}">${esc(role)}</span>
                <code>${esc(email)}</code>
                <button class="btn btn-sm" type="button" data-fill="${esc(email)}|${esc(pw)}">Use</button>
              </div>`).join('')}
          </div>
        </div>
      </section>
    </div>`;

  const form = document.getElementById('login-form');
  const errBox = document.getElementById('login-error');
  const btn = document.getElementById('login-btn');

  document.getElementById('toggle-pw').onclick = () => {
    const input = document.getElementById('password');
    input.type = input.type === 'password' ? 'text' : 'password';
  };

  form.querySelectorAll('[data-fill]').forEach((el) => {
    el.onclick = () => {
      const [email, pw] = el.dataset.fill.split('|');
      document.getElementById('email').value = email;
      document.getElementById('password').value = pw;
      document.getElementById('password').focus();
    };
  });

  // Sandboxed preview iframes omit `allow-forms`, which blocks native form submission.
  // Attach the handler to the button (a "submit" button still fires click) and cancel
  // the default submit so the blocked navigation never happens.
  form.addEventListener('submit', (e) => { e.preventDefault(); });
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    errBox.classList.add('hidden');
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    if (!email || !password) {
      errBox.textContent = 'Enter your email and password.';
      errBox.classList.remove('hidden');
      return;
    }
    const restore = buttonLoading(btn, 'Signing in…');
    try {
      const user = await auth.login(email, password);
      toast(`Welcome back, ${user.full_name.split(' ')[0]}.`, 'success');
      // Navigate in place — never reload: in a sandboxed preview iframe there is no
      // persistent storage, so a reload would discard the freshly issued token.
      if (location.hash === '#/dashboard') window.dispatchEvent(new HashChangeEvent('hashchange'));
      else location.hash = '#/dashboard';
    } catch (err) {
      restore();
      errBox.textContent = err.message;
      errBox.classList.remove('hidden');
    }
  });

  document.getElementById('email').focus();
  return { navigate };
}

export function renderRegister(app, navigate) {
  app.innerHTML = `
    <div class="auth-wrap">
      ${heroPanel()}
      <section class="auth-panel">
        <div class="auth-card">
          <h1>Create your account</h1>
          <p class="sub">New accounts start with the <strong>Billing Staff</strong> role. An administrator can change your role or permissions later.</p>
          <form class="auth-form" id="register-form" novalidate>
            <div class="field">
              <label for="full_name">Full name</label>
              <input class="input" id="full_name" name="full_name" autocomplete="name" placeholder="Ananya Rao" required />
            </div>
            <div class="field">
              <label for="email">Work email</label>
              <input class="input" id="email" name="email" type="email" autocomplete="username" placeholder="you@company.com" required />
            </div>
            <div class="field">
              <label for="phone">Phone <span class="muted small">(optional)</span></label>
              <input class="input" id="phone" name="phone" autocomplete="tel" placeholder="+91 98765 43210" />
            </div>
            <div class="field">
              <label for="password">Password</label>
              <input class="input" id="password" name="password" type="password" autocomplete="new-password" placeholder="At least 8 characters" required />
              <span class="hint">Use at least 8 characters with a letter and a number.</span>
            </div>
            <div class="field">
              <label for="confirm">Confirm password</label>
              <input class="input" id="confirm" name="confirm" type="password" autocomplete="new-password" placeholder="Repeat password" required />
            </div>
            <div id="register-error" class="alert alert-red hidden"></div>
            <button class="btn btn-primary btn-lg btn-block" type="button" id="register-btn">Create account</button>
          </form>
          <div class="auth-switch">Already registered? <a href="#/login">Sign in</a></div>
        </div>
      </section>
    </div>`;

  const form = document.getElementById('register-form');
  const errBox = document.getElementById('register-error');
  const btn = document.getElementById('register-btn');
  const fail = (msg) => { errBox.textContent = msg; errBox.classList.remove('hidden'); };

  form.addEventListener('submit', (e) => { e.preventDefault(); });
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    errBox.classList.add('hidden');
    const payload = {
      full_name: document.getElementById('full_name').value.trim(),
      email: document.getElementById('email').value.trim(),
      phone: document.getElementById('phone').value.trim(),
      password: document.getElementById('password').value
    };
    const confirm = document.getElementById('confirm').value;
    if (payload.full_name.length < 2) return fail('Enter your full name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(payload.email)) return fail('Enter a valid email address.');
    if (payload.password.length < 8) return fail('Password must be at least 8 characters.');
    if (!/[A-Za-z]/.test(payload.password) || !/[0-9]/.test(payload.password)) return fail('Password must include a letter and a number.');
    if (payload.password !== confirm) return fail('Passwords do not match.');

    const restore = buttonLoading(btn, 'Creating account…');
    try {
      const user = await auth.register(payload);
      toast(`Account created. Welcome, ${user.full_name.split(' ')[0]}.`, 'success');
      if (location.hash === '#/dashboard') window.dispatchEvent(new HashChangeEvent('hashchange'));
      else location.hash = '#/dashboard';
    } catch (err) {
      restore();
      fail(err.message);
    }
  });

  return { navigate };
}

export async function hasAdmin() {
  try {
    const data = await api.get('/auth/setup-status');
    return Boolean(data.has_admin);
  } catch { return true; }
}

export const currentSession = () => session.user;
