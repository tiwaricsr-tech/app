import { api, session } from '../api.js';
import { icon } from '../icons.js';
import { esc, toast } from '../ui.js';

/** System status / self-check page. */
export default async function renderHelp({ container }) {
  const [health, setup] = await Promise.all([
    api.get('/health').catch((e) => ({ error: e.message })),
    api.get('/auth/setup-status').catch(() => ({}))
  ]);

  const checks = [
    { label: 'API reachable', ok: !health.error, detail: health.error || `${health.driver} · v${health.version}` },
    { label: 'Database connection', ok: !health.error, detail: health.driver === 'postgres' ? 'Supabase PostgreSQL' : 'Embedded SQLite (local/preview mode)' },
    { label: 'Authenticated session', ok: Boolean(session.token), detail: session.user ? `${session.user.email} · ${session.user.role_label}` : 'Not signed in' },
    { label: 'Role-based access control', ok: Array.isArray(session.user?.permissions), detail: `${session.user?.permissions?.length || 0} permissions granted` }
  ];

  container.innerHTML = `
    <div class="page-head">
      <div>
        <h1>System status</h1>
        <p>Live health checks, security posture and a quick guide to how the system behaves.</p>
      </div>
      <div class="page-head-actions">
        <button class="btn" id="recheck">${icon('refresh')} Re-run checks</button>
      </div>
    </div>

    <div class="stack">
      <section class="card">
        <div class="card-head"><h3>Health checks</h3></div>
        <div class="card-body" style="display:grid;gap:10px">
          ${checks.map((c) => `
            <div style="display:flex;gap:11px;align-items:center;padding:10px 12px;border:1px solid ${c.ok ? 'var(--green-line)' : 'var(--red-line)'};background:${c.ok ? 'var(--green-bg)' : 'var(--red-bg)'};border-radius:10px">
              <span style="color:${c.ok ? 'var(--green)' : 'var(--red)'};display:flex">${icon(c.ok ? 'checkCircle' : 'alert', 'width="18" height="18"')}</span>
              <div style="flex:1">
                <div class="strong small">${esc(c.label)}</div>
                <div class="small muted">${esc(c.detail)}</div>
              </div>
              <span class="badge ${c.ok ? 'badge-green' : 'badge-red'}">${c.ok ? 'OK' : 'Issue'}</span>
            </div>`).join('')}
        </div>
      </section>

      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr))">
        <section class="card">
          <div class="card-head"><h3>How stock stays correct</h3></div>
          <div class="card-body stack" style="gap:13px">
            ${[
              ['Every movement is logged', 'Stock never changes without an immutable entry in the movement ledger, including the quantity before and after.'],
              ['Transactions, not hope', 'Creating, editing, cancelling or refunding a bill updates the invoice, its lines and the stock together inside one database transaction.'],
              ['No negative stock', 'A guarded atomic UPDATE plus a DB CHECK constraint means a sale can never push quantity below zero, even under concurrency.'],
              ['No double deduction', 'Status transitions are conditional (paid → cancelled once) and each bill submission carries an idempotency key.']
            ].map(([t, d]) => `
              <div style="display:flex;gap:10px">
                <span style="color:var(--brand-600);flex:none;margin-top:2px">${icon('shield', 'width="16" height="16"')}</span>
                <div><div class="small strong">${esc(t)}</div><div class="small muted">${esc(d)}</div></div>
              </div>`).join('')}
          </div>
        </section>

        <section class="card">
          <div class="card-head"><h3>Deployment notes</h3></div>
          <div class="card-body stack" style="gap:12px">
            <div class="alert alert-blue" style="margin:0">${icon('info')}<div class="small">
              This instance is running on <strong>${esc(health.driver || 'unknown')}</strong>. Set <span class="mono">DATABASE_URL</span> to a Supabase Postgres connection string to run on the production schema in <span class="mono">/supabase/schema.sql</span> with Row Level Security from <span class="mono">/supabase/rls.sql</span>.
            </div></div>
            <div class="kv small">
              <div class="kv-row"><span class="k">Auth</span><span class="v">JWT bearer · bcrypt hashes</span></div>
              <div class="kv-row"><span class="k">User roles defined</span><span class="v">${setup.has_admin ? 'admin, manager, staff' : 'initialising'}</span></div>
              <div class="kv-row"><span class="k">Service-role key</span><span class="v">server-side only</span></div>
              <div class="kv-row"><span class="k">Stock validation</span><span class="v">server-side, transactional</span></div>
            </div>
            <p class="small muted">Demo sign-in details are on the login screen. Administrators can create further accounts under <a href="#/users">Users</a>.</p>
          </div>
        </section>
      </div>

      <section class="card">
        <div class="card-head"><h3>Keyboard shortcuts &amp; tips</h3></div>
        <div class="card-body">
          <div class="form-grid">
            ${[
              ['/', 'Focus the search box on any list page'],
              ['Esc', 'Close a dialog'],
              ['Stock stepper', 'Use + / − in the product table to adjust stock instantly'],
              ['Unit price', 'Editable on each bill line for negotiated pricing'],
              ['Print', 'Open an invoice and press Print for an A4 copy, or download the PDF']
            ].map(([k, d]) => `
              <div style="display:flex;gap:10px;align-items:flex-start">
                <kbd class="mono" style="background:var(--surface-2);border:1px solid var(--line);border-bottom-width:2px;border-radius:6px;padding:2px 7px;font-size:11.5px;flex:none">${esc(k)}</kbd>
                <span class="small muted">${esc(d)}</span>
              </div>`).join('')}
          </div>
        </div>
      </section>
    </div>`;

  container.querySelector('#recheck').onclick = () => { toast('Re-running checks…', 'info'); renderHelp({ container }); };
}
