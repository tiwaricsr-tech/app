import { api, session, auth, can } from '../api.js';
import { icon } from '../icons.js';
import { esc, initials, money, num, dateShort, dateTime, statusBadge, roleBadge, toast, buttonLoading } from '../ui.js';

const PERMISSION_LABELS = {
  'products.view': 'View products', 'products.create': 'Add products', 'products.update': 'Edit products',
  'products.delete': 'Delete / archive products', 'stock.adjust': 'Adjust stock', 'inventory.view': 'View inventory',
  'invoices.view': 'View invoices', 'invoices.create': 'Create bills', 'invoices.edit': 'Edit invoices',
  'invoices.cancel': 'Cancel / refund invoices', 'reports.view': 'View reports & export',
  'users.view': 'View users', 'users.manage': 'Manage user accounts', 'categories.manage': 'Manage categories'
};

export default async function renderProfile({ container, refreshShell }) {
  const me = await auth.me();
  const stats = await api.get('/reports/dashboard').catch(() => null);

  container.innerHTML = `
    <div class="page-head">
      <div>
        <h1>My profile</h1>
        <p>Your account details, role permissions and password.</p>
      </div>
    </div>

    <div class="profile-grid">
      <div class="stack">
        <section class="card">
          <div class="card-body" style="display:grid;gap:14px;justify-items:center;text-align:center">
            <span class="avatar">${esc(initials(me.full_name))}</span>
            <div>
              <div style="font-size:17px;font-weight:700;letter-spacing:-.02em">${esc(me.full_name)}</div>
              <div class="small muted">${esc(me.email)}</div>
            </div>
            <div style="display:flex;gap:7px;flex-wrap:wrap;justify-content:center">
              ${roleBadge(me.role)} ${statusBadge(me.status)}
            </div>
            <div class="kv" style="width:100%;text-align:left;margin-top:6px">
              <div class="kv-row"><span class="k">Phone</span><span class="v">${esc(me.phone || '—')}</span></div>
              <div class="kv-row"><span class="k">Member since</span><span class="v">${dateShort(me.created_at)}</span></div>
              <div class="kv-row"><span class="k">Last sign-in</span><span class="v">${me.last_login_at ? dateTime(me.last_login_at) : '—'}</span></div>
              <div class="kv-row"><span class="k">Permissions</span><span class="v">${me.permissions.length}</span></div>
            </div>
          </div>
        </section>

        <section class="card">
          <div class="card-head"><h3>Access level</h3></div>
          <div class="card-body">
            <div class="edit-role">
              ${['admin', 'manager', 'staff'].map((r) => `
                <div style="display:flex;gap:9px;align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--line-2)">
                  <span style="width:18px;flex:none;color:${me.role === r ? 'var(--brand-600)' : 'var(--muted-2)'}">${icon(me.role === r ? 'checkCircle' : 'minus', 'width="16" height="16"')}</span>
                  <div>
                    <div class="small strong">${{ admin: 'Administrator', manager: 'Manager', staff: 'Billing Staff' }[r]}</div>
                    <div class="small muted">${{ admin: 'Full control of users, inventory, billing and reports', manager: 'Inventory and billing; cannot manage users', staff: 'Bills and read-only inventory' }[r]}</div>
                  </div>
                </div>`).join('')}
            </div>
            <p class="small muted" style="margin-top:10px">Only an administrator can change your role.</p>
          </div>
        </section>

        ${stats && can('invoices.view') ? `<section class="card">
          <div class="card-head"><h3>Your billing snapshot</h3></div>
          <div class="card-body summary-grid">
            <div class="summary-cell"><div class="k">All-time revenue</div><div class="v">${money(stats.sales.total_revenue)}</div></div>
            <div class="summary-cell"><div class="k">Bills issued</div><div class="v">${num(stats.sales.total_bills)}</div></div>
            <div class="summary-cell"><div class="k">This month</div><div class="v">${money(stats.sales.month_revenue)}</div></div>
          </div>
        </section>` : ''}
      </div>

      <div class="stack">
        <section class="card">
          <div class="card-head"><h3>Account details</h3></div>
          <div class="card-body">
            <form id="profile-form" class="form-grid">
              <div class="field span-2">
                <label for="pr-name">Full name</label>
                <input class="input" id="pr-name" value="${esc(me.full_name)}" maxlength="120" />
              </div>
              <div class="field">
                <label for="pr-email">Email</label>
                <input class="input" id="pr-email" value="${esc(me.email)}" disabled />
                <span class="hint">Contact an administrator to change your email.</span>
              </div>
              <div class="field">
                <label for="pr-phone">Phone</label>
                <input class="input" id="pr-phone" value="${esc(me.phone || '')}" />
              </div>
              <div class="span-2 form-actions">
                <button class="btn btn-primary" type="button" id="pr-save">${icon('check')} Save profile</button>
              </div>
            </form>
          </div>
        </section>

        <section class="card">
          <div class="card-head"><h3>Change password</h3></div>
          <div class="card-body">
            <form id="password-form" class="form-grid">
              <div class="field span-2">
                <label for="pw-current">Current password</label>
                <input class="input" id="pw-current" type="password" autocomplete="current-password" />
              </div>
              <div class="field">
                <label for="pw-new">New password</label>
                <input class="input" id="pw-new" type="password" autocomplete="new-password" />
              </div>
              <div class="field">
                <label for="pw-confirm">Confirm new password</label>
                <input class="input" id="pw-confirm" type="password" autocomplete="new-password" />
              </div>
              <div class="span-2">
                <div id="pw-error" class="alert alert-red hidden"></div>
                <div class="form-actions" style="margin-top:10px">
                  <button class="btn btn-primary" type="button" id="pw-save">${icon('shield')} Update password</button>
                </div>
              </div>
            </form>
          </div>
        </section>

        <section class="card">
          <div class="card-head"><h3>Your permissions</h3>
            <span class="badge badge-blue" style="margin-left:auto">${me.permissions.length} granted</span></div>
          <div class="card-body">
            <div class="perm-list">
              ${Object.entries(PERMISSION_LABELS).map(([code, label]) => {
                const granted = me.permissions.includes(code);
                return `<span class="badge ${granted ? 'badge-green' : 'badge-gray'}">
                  ${granted ? icon('check', 'width="11" height="11"') : ''} ${esc(label)}</span>`;
              }).join('')}
            </div>
            <p class="small muted" style="margin-top:12px">Permissions are enforced on the server for every request — the interface simply reflects them.</p>
          </div>
        </section>

        <section class="card">
          <div class="card-head"><h3>Session</h3></div>
          <div class="card-body" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <div class="small muted" style="flex:1">Signed in as <strong>${esc(me.email)}</strong> with a signed JWT that expires in 12 hours.</div>
            <button class="btn btn-soft-red" id="sign-out">${icon('logout')} Sign out</button>
          </div>
        </section>
      </div>
    </div>`;

  // Sandboxed iframes block native form submission — drive these from the button.
  const profileForm = container.querySelector('#profile-form');
  profileForm.addEventListener('submit', (e) => { e.preventDefault(); });
  container.querySelector('#pr-save').addEventListener('click', async (e) => {
    e.preventDefault();
    const btn = container.querySelector('#pr-save');
    const restore = buttonLoading(btn, 'Saving…');
    try {
      const res = await api.patch('/auth/me', {
        full_name: container.querySelector('#pr-name').value.trim(),
        phone: container.querySelector('#pr-phone').value.trim()
      });
      session.user = res.user;
      if (refreshShell) refreshShell();
      toast('Profile updated.', 'success');
    } catch (err) { toast(err.message, 'error'); }
    finally { restore(); }
  });

  const pwErr = container.querySelector('#pw-error');
  const passwordForm = container.querySelector('#password-form');
  passwordForm.addEventListener('submit', (e) => { e.preventDefault(); });
  container.querySelector('#pw-save').addEventListener('click', async (e) => {
    e.preventDefault();
    pwErr.classList.add('hidden');
    const current = container.querySelector('#pw-current').value;
    const next = container.querySelector('#pw-new').value;
    const confirm = container.querySelector('#pw-confirm').value;
    const fail = (m) => { pwErr.textContent = m; pwErr.classList.remove('hidden'); };
    if (!current) return fail('Enter your current password.');
    if (next.length < 8) return fail('New password must be at least 8 characters.');
    if (!/[A-Za-z]/.test(next) || !/[0-9]/.test(next)) return fail('Include at least one letter and one number.');
    if (next !== confirm) return fail('New passwords do not match.');

    const btn = container.querySelector('#pw-save');
    const restore = buttonLoading(btn, 'Updating…');
    try {
      await api.post('/auth/change-password', { current_password: current, new_password: next });
      toast('Password updated. Use it next time you sign in.', 'success');
      passwordForm.reset();
    } catch (err) { fail(err.message); }
    finally { restore(); }
  });

  container.querySelector('#sign-out').onclick = async () => {
    await auth.logout();
    if (location.hash === '#/login') window.dispatchEvent(new HashChangeEvent('hashchange'));
    else location.hash = '#/login';
  };
}
