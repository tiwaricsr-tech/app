import { api, can, session, isAdmin } from '../api.js';
import { icon } from '../icons.js';
import {
  money, num, esc, dateShort, timeAgo, statusBadge, roleBadge, initials, emptyState, skeletonRows,
  toast, modal, confirmDialog, debounce, buttonLoading
} from '../ui.js';

const ROLE_OPTIONS = [
  { value: 'admin', label: 'Administrator', hint: 'Full access · users, inventory, billing, reports' },
  { value: 'manager', label: 'Manager', hint: 'Inventory & billing · cannot manage users' },
  { value: 'staff', label: 'Billing Staff', hint: 'Create bills and view inventory only' }
];

function openUserForm({ user, roles, onSaved }) {
  const isEdit = Boolean(user);
  const u = user || { full_name: '', email: '', phone: '', role: 'staff', status: 'active' };
  let generatedPassword = '';

  modal({
    title: isEdit ? 'Edit user' : 'Add user',
    subtitle: isEdit ? u.email : 'Create an account and assign a role.',
    body: `
      <form id="user-form" class="stack" style="gap:14px" novalidate>
        <div class="form-grid">
          <div class="field span-2">
            <label for="uf-name">Full name <span class="req">*</span></label>
            <input class="input" id="uf-name" value="${esc(u.full_name)}" maxlength="120" required />
          </div>
          <div class="field">
            <label for="uf-email">Email <span class="req">*</span></label>
            <input class="input" id="uf-email" type="email" value="${esc(u.email)}" required />
          </div>
          <div class="field">
            <label for="uf-phone">Phone</label>
            <input class="input" id="uf-phone" value="${esc(u.phone || '')}" />
          </div>
          <div class="field">
            <label for="uf-role">Role</label>
            <select class="select" id="uf-role">
              ${ROLE_OPTIONS.map((r) => `<option value="${r.value}" ${u.role === r.value ? 'selected' : ''}>${r.label}</option>`).join('')}
            </select>
            <span class="hint" id="uf-role-hint"></span>
          </div>
          <div class="field">
            <label for="uf-status">Account status</label>
            <select class="select" id="uf-status" ${isEdit && u.id === session.user.id ? 'disabled' : ''}>
              <option value="active" ${u.status === 'active' ? 'selected' : ''}>Active — can sign in</option>
              <option value="inactive" ${u.status === 'inactive' ? 'selected' : ''}>Inactive — sign-in blocked</option>
            </select>
          </div>
          <div class="field span-2">
            <label for="uf-password">${isEdit ? 'Reset password' : 'Temporary password'} ${isEdit ? '<span class="muted small">(leave blank to keep current)</span>' : '<span class="req">*</span>'}</label>
            <input class="input" id="uf-password" type="text" placeholder="At least 8 characters with a letter and a number" />
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <button type="button" class="btn btn-sm" id="uf-gen">${icon('refresh')} Generate password</button>
              <span class="small muted" id="uf-gen-out"></span>
            </div>
          </div>
        </div>
        <div id="uf-error" class="alert alert-red hidden"></div>
      </form>`,
    footer: `<button class="btn" data-cancel>Cancel</button>
             <button class="btn btn-primary" id="uf-submit">${icon('check')} ${isEdit ? 'Save changes' : 'Create user'}</button>`,
    onMount(root, close) {
      root.querySelector('[data-cancel]').onclick = close;
      const roleSelect = root.querySelector('#uf-role');
      const hint = root.querySelector('#uf-role-hint');
      const syncHint = () => { hint.textContent = ROLE_OPTIONS.find((r) => r.value === roleSelect.value)?.hint || ''; };
      roleSelect.onchange = syncHint; syncHint();

      root.querySelector('#uf-gen').onclick = () => {
        const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ', lower = 'abcdefghijkmnopqrstuvwxyz', digits = '23456789', sym = '!@#$%';
        const all = upper + lower + digits + sym;
        const pick = (set) => set[Math.floor(Math.random() * set.length)];
        generatedPassword = `${pick(upper)}${pick(lower)}${pick(digits)}${pick(sym)}${Array.from({ length: 6 }, () => pick(all)).join('')}`;
        root.querySelector('#uf-password').value = generatedPassword;
        root.querySelector('#uf-gen-out').textContent = 'Share this with the user securely — they can change it after signing in.';
      };

      const errBox = root.querySelector('#uf-error');
      const btn = root.querySelector('#uf-submit');
      const fail = (m) => { errBox.textContent = m; errBox.classList.remove('hidden'); };

      btn.onclick = async () => {
        errBox.classList.add('hidden');
        const payload = {
          full_name: root.querySelector('#uf-name').value.trim(),
          email: root.querySelector('#uf-email').value.trim(),
          phone: root.querySelector('#uf-phone').value.trim(),
          role: roleSelect.value,
          status: root.querySelector('#uf-status').value
        };
        const password = root.querySelector('#uf-password').value;
        if (payload.full_name.length < 2) return fail('Enter the user\u2019s full name.');
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(payload.email)) return fail('Enter a valid email address.');
        if (!isEdit && password.length < 8) return fail('Set a temporary password of at least 8 characters.');
        if (password && (password.length < 8 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password))) {
          return fail('Password must be at least 8 characters and include a letter and a number.');
        }
        if (password) payload.password = password;

        const restore = buttonLoading(btn, isEdit ? 'Saving…' : 'Creating…');
        try {
          const res = isEdit
            ? await api.patch(`/users/${u.id}`, payload)
            : await api.post('/users', payload);
          toast(isEdit ? 'User updated.' : 'User created.', 'success');
          close();
          if (onSaved) onSaved(res.user);
        } catch (err) { restore(); fail(err.message); }
      };
    }
  });
}

export default async function renderUsers({ container }) {
  const state = { search: '', role: '', status: '' };

  container.innerHTML = `
    <div class="page-head">
      <div>
        <h1>User management</h1>
        <p>Activate, deactivate and manage roles. Deactivated users are signed out immediately.</p>
      </div>
      <div class="page-head-actions">
        <button class="btn" id="u-refresh">${icon('refresh')} Refresh</button>
        ${isAdmin() ? `<button class="btn btn-primary" id="u-add">${icon('plus')} Add user</button>` : ''}
      </div>
    </div>
    <div class="stack">
      <div class="stats" id="u-stats"></div>
      <section class="card">
        <div class="toolbar">
          <div class="search-box">
            ${icon('search')}
            <input class="input" id="u-search" placeholder="Search name or email…" />
          </div>
          <select class="select" id="u-role">
            <option value="">All roles</option>
            ${ROLE_OPTIONS.map((r) => `<option value="${r.value}">${r.label}</option>`).join('')}
          </select>
          <select class="select" id="u-status">
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </div>
        <div id="u-body">${skeletonRows(6)}</div>
      </section>
      <section class="card">
        <div class="card-head"><h3>Role permission matrix</h3></div>
        <div class="card-body" id="u-matrix"></div>
      </section>
    </div>`;

  const body = container.querySelector('#u-body');

  const load = async () => {
    body.innerHTML = skeletonRows(6);
    const params = new URLSearchParams();
    if (state.search) params.set('search', state.search);
    if (state.role) params.set('role', state.role);
    if (state.status) params.set('status', state.status);
    try {
      const data = await api.get(`/users?${params}`);
      const s = data.summary;
      container.querySelector('#u-stats').innerHTML = `
        <article class="stat" style="--stat-accent:#1d4ed8;--stat-bg:var(--brand-50)">
          <div class="stat-top"><span class="stat-icon">${icon('users')}</span><span class="stat-label">Total users</span></div>
          <div class="stat-value">${num(s.total)}</div><div class="stat-meta">across all roles</div></article>
        <article class="stat" style="--stat-accent:#059669;--stat-bg:var(--green-bg)">
          <div class="stat-top"><span class="stat-icon">${icon('checkCircle')}</span><span class="stat-label">Active accounts</span></div>
          <div class="stat-value">${num(s.active)}</div><div class="stat-meta">can sign in now</div></article>
        <article class="stat" style="--stat-accent:#dc2626;--stat-bg:var(--red-bg)">
          <div class="stat-top"><span class="stat-icon">${icon('ban')}</span><span class="stat-label">Deactivated</span></div>
          <div class="stat-value">${num(s.inactive)}</div><div class="stat-meta">sign-in blocked</div></article>`;

      if (!data.items.length) {
        body.innerHTML = emptyState({ iconName: 'users', title: 'No users match these filters' });
        return;
      }
      body.innerHTML = `
        <div class="table-wrap">
          <table class="data">
            <thead><tr>
              <th>User</th><th>Role</th><th>Status</th><th class="num">Bills</th><th>Last sign-in</th><th>Joined</th><th class="num">Actions</th>
            </tr></thead>
            <tbody>
              ${data.items.map((u) => `
                <tr>
                  <td>
                    <div class="cell-product">
                      <span class="avatar avatar-sm">${esc(initials(u.full_name))}</span>
                      <div style="min-width:0">
                        <div class="name">${esc(u.full_name)} ${u.id === session.user.id ? '<span class="badge badge-blue" style="margin-left:4px">You</span>' : ''}</div>
                        <div class="sub">${esc(u.email)}</div>
                      </div>
                    </div>
                  </td>
                  <td>${roleBadge(u.role)}</td>
                  <td>${statusBadge(u.status)}</td>
                  <td class="num">${num(u.invoice_count)}</td>
                  <td class="small muted">${u.last_login_at ? timeAgo(u.last_login_at) : 'Never'}</td>
                  <td class="small muted">${dateShort(u.created_at)}</td>
                  <td>
                    <div class="row-actions">
                      ${isAdmin() ? `<button class="btn btn-sm btn-ghost btn-icon" data-edit="${u.id}" title="Edit user">${icon('edit')}</button>` : ''}
                      ${isAdmin() && u.id !== session.user.id ? `
                        <button class="btn btn-sm btn-ghost btn-icon" data-toggle="${u.id}" title="${u.status === 'active' ? 'Deactivate' : 'Activate'}"
                          style="color:${u.status === 'active' ? 'var(--amber)' : 'var(--green)'}">${icon(u.status === 'active' ? 'ban' : 'checkCircle')}</button>
                        <button class="btn btn-sm btn-ghost btn-icon" data-del="${u.id}" title="Delete user" style="color:var(--red)">${icon('trash')}</button>` : ''}
                    </div>
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>`;

      const findUser = (id) => data.items.find((x) => String(x.id) === String(id));

      body.querySelectorAll('[data-edit]').forEach((b) => {
        b.onclick = () => openUserForm({ user: findUser(b.dataset.edit), roles: [], onSaved: load });
      });
      body.querySelectorAll('[data-toggle]').forEach((b) => {
        b.onclick = async () => {
          const u = findUser(b.dataset.toggle);
          const activating = u.status !== 'active';
          const ok = await confirmDialog({
            title: `${activating ? 'Activate' : 'Deactivate'} ${u.full_name}?`,
            message: activating
              ? 'The user will be able to sign in again immediately.'
              : 'The user will be signed out and blocked from signing in. Their billing history is preserved.',
            confirmLabel: activating ? 'Activate user' : 'Deactivate user',
            danger: !activating
          });
          if (!ok) return;
          try {
            await api.patch(`/users/${u.id}`, { status: activating ? 'active' : 'inactive' });
            toast(`${u.full_name} ${activating ? 'activated' : 'deactivated'}.`, 'success');
            load();
          } catch (err) { toast(err.message, 'error'); }
        };
      });
      body.querySelectorAll('[data-del]').forEach((b) => {
        b.onclick = async () => {
          const u = findUser(b.dataset.del);
          const ok = await confirmDialog({
            title: `Delete ${u.full_name}?`,
            message: 'Users with billing history are deactivated instead of deleted so invoices stay attributable.',
            confirmLabel: 'Delete user', danger: true
          });
          if (!ok) return;
          try {
            const res = await api.del(`/users/${u.id}`);
            toast(res.message || 'User deleted.', res.deactivated ? 'info' : 'success');
            load();
          } catch (err) { toast(err.message, 'error'); }
        };
      });
    } catch (err) {
      body.innerHTML = `<div class="card-body"><div class="alert alert-red">${icon('alert')}<div>${esc(err.message)}</div></div></div>`;
    }
  };

  const loadMatrix = async () => {
    const matrix = container.querySelector('#u-matrix');
    const perms = [
      ['products.view', 'View products'], ['products.create', 'Add products'], ['products.update', 'Edit products'],
      ['products.delete', 'Delete / archive'], ['stock.adjust', 'Adjust stock'], ['inventory.view', 'View inventory'],
      ['invoices.view', 'View invoices'], ['invoices.create', 'Create bills'], ['invoices.edit', 'Edit bills'],
      ['invoices.cancel', 'Cancel / refund'], ['reports.view', 'View reports & export'],
      ['users.view', 'View users'], ['users.manage', 'Manage users'], ['categories.manage', 'Manage categories']
    ];
    const roles = [
      { name: 'admin', label: 'Administrator' },
      { name: 'manager', label: 'Manager' },
      { name: 'staff', label: 'Billing Staff' }
    ];
    // Derive from live session permissions for the current role + static matrix for others.
    const staticMatrix = {
      admin: perms.map((p) => p[0]),
      manager: ['products.view', 'products.create', 'products.update', 'products.delete', 'stock.adjust', 'inventory.view',
        'invoices.view', 'invoices.create', 'invoices.edit', 'invoices.cancel', 'reports.view', 'categories.manage'],
      staff: ['products.view', 'inventory.view', 'invoices.view', 'invoices.create']
    };
    matrix.innerHTML = `<div class="table-wrap"><table class="data">
      <thead><tr><th>Permission</th>${roles.map((r) => `<th style="text-align:center">${r.label}</th>`).join('')}</tr></thead>
      <tbody>${perms.map(([code, label]) => `<tr>
        <td class="small">${esc(label)} <span class="mono muted small">${esc(code)}</span></td>
        ${roles.map((r) => `<td style="text-align:center">${staticMatrix[r.name].includes(code)
          ? `<span style="color:var(--green)">${icon('check', 'width="15" height="15"')}</span>`
          : `<span class="muted">${icon('minus', 'width="15" height="15"')}</span>`}</td>`).join('')}
      </tr>`).join('')}</tbody>
    </table></div>`;
  };

  container.querySelector('#u-search').addEventListener('input', debounce((e) => {
    state.search = e.target.value.trim(); load();
  }, 250));
  container.querySelector('#u-role').onchange = (e) => { state.role = e.target.value; load(); };
  container.querySelector('#u-status').onchange = (e) => { state.status = e.target.value; load(); };
  container.querySelector('#u-refresh').onclick = () => { load(); toast('Users refreshed.', 'info'); };
  const addBtn = container.querySelector('#u-add');
  if (addBtn) addBtn.onclick = () => openUserForm({ onSaved: load });

  await Promise.all([load(), loadMatrix()]);
}
