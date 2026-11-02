import { session, auth, api, setUnauthorizedHandler, can, isAdmin } from './api.js';
import { icon } from './icons.js';
import { esc, initials, toast, $, $$ } from './ui.js';

import renderLogin, { renderRegister } from './views/auth.js';
import renderDashboard from './views/dashboard.js';
import renderProducts from './views/products.js';
import renderInventory from './views/inventory.js';
import renderBilling from './views/billing.js';
import renderInvoices, { renderInvoiceDetail } from './views/invoices.js';
import renderReports from './views/reports.js';
import renderUsers from './views/users.js';
import renderProfile from './views/profile.js';
import renderSettings from './views/settings.js';
import renderHelp from './views/help.js';

/* ── route table ─────────────────────────────────────────────────────────── */
const ROUTES = [
  { path: 'dashboard', title: 'Dashboard', view: renderDashboard, perm: 'products.view' },
  { path: 'products', title: 'Products', view: renderProducts, perm: 'products.view' },
  { path: 'inventory', title: 'Inventory', view: renderInventory, perm: 'inventory.view' },
  { path: 'billing', title: 'New Bill', view: renderBilling, perm: 'invoices.create' },
  { path: 'invoices', title: 'Invoices', view: renderInvoices, perm: 'invoices.view' },
  { path: 'invoices/:id', title: 'Invoice', view: renderInvoiceDetail, perm: 'invoices.view' },
  { path: 'reports', title: 'Reports', view: renderReports, perm: 'reports.view' },
  { path: 'users', title: 'User Management', view: renderUsers, perm: 'users.view' },
  { path: 'categories', title: 'Categories', view: renderSettings, perm: 'categories.manage' },
  { path: 'profile', title: 'My Profile', view: renderProfile, perm: null },
  { path: 'help', title: 'System Status', view: renderHelp, perm: null }
];

const NAV = [
  { group: 'Workspace', items: [
    { path: 'dashboard', label: 'Dashboard', iconName: 'dashboard', perm: 'products.view' },
    { path: 'products', label: 'Products', iconName: 'products', perm: 'products.view' },
    { path: 'inventory', label: 'Inventory', iconName: 'inventory', perm: 'inventory.view' }
  ] },
  { group: 'Billing', items: [
    { path: 'billing', label: 'New Bill', iconName: 'cart', perm: 'invoices.create' },
    { path: 'invoices', label: 'Invoices', iconName: 'invoice', perm: 'invoices.view' }
  ] },
  { group: 'Insights', items: [
    { path: 'reports', label: 'Reports', iconName: 'reports', perm: 'reports.view' }
  ] },
  { group: 'Administration', items: [
    { path: 'users', label: 'Users', iconName: 'users', perm: 'users.view' },
    { path: 'categories', label: 'Categories', iconName: 'tag', perm: 'categories.manage' }
  ] }
];

/* ── routing helpers ─────────────────────────────────────────────────────── */
const parseHash = () => {
  const raw = (location.hash || '#/dashboard').replace(/^#\/?/, '');
  const [pathPart] = raw.split('?');
  return pathPart.replace(/\/$/, '') || 'dashboard';
};

function matchRoute(pathname) {
  for (const route of ROUTES) {
    if (!route.path.includes(':')) {
      if (route.path === pathname) return { route, params: {} };
      continue;
    }
    const routeParts = route.path.split('/');
    const urlParts = pathname.split('/');
    if (routeParts.length !== urlParts.length) continue;
    const params = {};
    let ok = true;
    routeParts.forEach((p, i) => {
      if (p.startsWith(':')) params[p.slice(1)] = urlParts[i];
      else if (p !== urlParts[i]) ok = false;
    });
    if (ok) return { route, params };
  }
  return null;
}

export const navigate = (path) => { location.hash = `#/${path}`; };

/* In-memory UI cache (sessionStorage/localStorage are unavailable in sandboxed frames). */
const uiState = { lowStock: 0 };

/* ── shell ───────────────────────────────────────────────────────────────── */
function buildShell() {
  const app = document.getElementById('app');
  const user = session.user;
  const lowStockCount = Number(uiState.lowStock || 0);

  app.innerHTML = `
    <div class="shell">
      <aside class="sidebar" id="sidebar">
        <a class="brand" href="#/dashboard">
          <span class="brand-mark">
            <svg viewBox="0 0 64 64" width="26" height="26" aria-hidden="true">
              <path d="M18 40V26l14-8 14 8v14l-14 8-14-8z" fill="none" stroke="white" stroke-width="3.4" stroke-linejoin="round"/>
              <path d="M18 26l14 8 14-8M32 34v14" stroke="white" stroke-width="3.4" stroke-linejoin="round"/>
            </svg>
          </span>
          <span>
            <span class="brand-name">StockFlow</span>
            <span class="brand-sub">Inventory &amp; Billing</span>
          </span>
        </a>
        <nav class="nav" aria-label="Main navigation">
          ${NAV.map((section) => {
            const items = section.items.filter((i) => !i.perm || can(i.perm));
            if (!items.length) return '';
            return `<div class="nav-group">${esc(section.group)}</div>
              ${items.map((item) => `
                <a class="nav-item" href="#/${item.path}" data-nav="${item.path}">
                  ${icon(item.iconName)}
                  <span>${esc(item.label)}</span>
                  ${item.path === 'inventory' ? `<span class="nav-badge" id="nav-low" ${lowStockCount ? '' : 'hidden'}>${lowStockCount}</span>` : ''}
                </a>`).join('')}`;
          }).join('')}
        </nav>
        <div class="sidebar-foot">
          <a class="side-user" href="#/profile" style="text-decoration:none;color:inherit">
            <span class="avatar avatar-sm">${esc(initials(user.full_name))}</span>
            <span class="side-user-info">
              <span class="side-user-name">${esc(user.full_name)}</span>
              <span class="side-user-role">${esc(user.role_label || user.role)}</span>
            </span>
          </a>
          <button class="btn btn-ghost btn-block" id="logout-btn" style="justify-content:flex-start;margin-top:4px">
            ${icon('logout')} Sign out
          </button>
        </div>
      </aside>
      <div class="scrim" data-close-nav></div>
      <div class="main">
        <header class="topbar">
          <button class="btn btn-icon btn-ghost menu-btn" id="menu-btn" aria-label="Open navigation">${icon('menu')}</button>
          <div class="topbar-title" id="topbar-title"></div>
          <div class="topbar-actions">
            <button class="btn btn-ghost btn-icon" id="lowstock-bell" title="Low stock alerts" aria-label="Low stock alerts" style="position:relative">
              ${icon('bell')}
              <span id="bell-dot" style="position:absolute;top:5px;right:6px;width:7px;height:7px;border-radius:50%;background:var(--red);${lowStockCount ? '' : 'display:none'}"></span>
            </button>
            ${can('invoices.create') ? `<a class="btn btn-primary btn-sm" href="#/billing" style="height:34px">${icon('plus')} New bill</a>` : ''}
            <a class="btn btn-icon btn-ghost" href="#/profile" title="${esc(user.full_name)}">
              <span class="avatar avatar-sm">${esc(initials(user.full_name))}</span>
            </a>
          </div>
        </header>
        <main class="content" id="content"></main>
      </div>
    </div>`;

  document.getElementById('logout-btn').onclick = async () => {
    await auth.logout();
    toast('You have been signed out.', 'info');
    if (location.hash === '#/login') window.dispatchEvent(new HashChangeEvent('hashchange'));
    else location.hash = '#/login';
  };
  const menuBtn = document.getElementById('menu-btn');
  menuBtn.onclick = () => document.body.classList.toggle('nav-open');
  document.body.addEventListener('click', (e) => {
    if (e.target.closest('[data-close-nav]') || e.target.closest('.nav-item')) document.body.classList.remove('nav-open');
  });
  document.getElementById('lowstock-bell').onclick = () => navigate('inventory?low=1');
}

function markActiveNav(pathname) {
  $$('.nav-item').forEach((el) => {
    const target = el.dataset.nav;
    const active = pathname === target || (target === 'invoices' && pathname.startsWith('invoices/'));
    el.classList.toggle('active', active);
  });
  const def = matchRoute(pathname);
  const titleEl = document.getElementById('topbar-title');
  if (titleEl) {
    const u = session.user;
    titleEl.innerHTML = `${esc(def ? def.route.title : 'StockFlow')}<small>${esc(u.role_label || u.role)} · ${esc(u.email)}</small>`;
  }
}

async function refreshLowStockBadge() {
  if (!can('inventory.view')) return;
  try {
    const data = await api.get('/inventory/low-stock?limit=100');
    const count = data.count || 0;
    uiState.lowStock = count;
    const badge = document.getElementById('nav-low');
    const dot = document.getElementById('bell-dot');
    if (badge) { badge.textContent = count; badge.hidden = count === 0; }
    if (dot) dot.style.display = count ? '' : 'none';
  } catch { /* silent */ }
}

/* ── render pipeline ─────────────────────────────────────────────────────── */
let currentRender = 0;

async function render() {
  const authenticated = Boolean(session.token && session.user);

  if (!authenticated) {
    const pathname = parseHash();
    const app = document.getElementById('app');
    document.getElementById('boot').style.display = 'none';
    app.hidden = false;
    if (pathname === 'register') return renderRegister(app, navigate);
    if (pathname !== 'login') { location.hash = '#/login'; return; }
    return renderLogin(app, navigate);
  }

  const pathname = parseHash();
  if (pathname === 'login' || pathname === 'register') { location.hash = '#/dashboard'; return; }

  if (!document.getElementById('content')) buildShell();

  const matched = matchRoute(pathname);
  const content = document.getElementById('content');
  markActiveNav(pathname);

  if (!matched) {
    content.innerHTML = `
      <div class="card"><div class="card-body">
        <div class="empty">
          <div class="empty-icon">${icon('alert')}</div>
          <h4>Page not found</h4>
          <p>The page you are looking for does not exist or was moved.</p>
          <a class="btn btn-primary" href="#/dashboard">${icon('dashboard')} Back to dashboard</a>
        </div>
      </div></div>`;
    return;
  }

  const { route, params } = matched;
  if (route.perm && !can(route.perm)) {
    content.innerHTML = `
      <div class="card"><div class="card-body">
        <div class="empty">
          <div class="empty-icon" style="color:var(--red);background:var(--red-bg);border-color:var(--red-line)">${icon('shield')}</div>
          <h4>Access restricted</h4>
          <p>Your role (${esc(session.user.role_label || session.user.role)}) does not have permission to open this page.</p>
          <a class="btn btn-primary" href="#/dashboard">Back to dashboard</a>
        </div>
      </div></div>`;
    return;
  }

  const renderId = ++currentRender;
  content.innerHTML = '<div class="loading-rows" style="padding:0"><div class="skeleton" style="height:96px"></div><div class="skeleton" style="height:220px"></div></div>';
  try {
    const result = route.view({ container: content, params, query: new URLSearchParams((location.hash.split('?')[1] || '')), navigate, refreshShell: () => {
      const headerAvatar = document.querySelector('.topbar-actions .avatar');
      if (headerAvatar) headerAvatar.textContent = initials(session.user.full_name);
      const sideAvatar = document.querySelector('.sidebar .avatar');
      if (sideAvatar) sideAvatar.textContent = initials(session.user.full_name);
      const sideName = document.querySelector('.side-user-name');
      if (sideName) sideName.textContent = session.user.full_name;
    } });
    if (result && typeof result.then === 'function') await result;
  } catch (err) {
    if (renderId !== currentRender) return;
    content.innerHTML = `
      <div class="card"><div class="card-body">
        <div class="empty">
          <div class="empty-icon" style="color:var(--red);background:var(--red-bg);border-color:var(--red-line)">${icon('alert')}</div>
          <h4>Could not load this page</h4>
          <p>${esc(err.message || 'Unexpected error')}</p>
          <button class="btn btn-primary" id="retry-render">${icon('refresh')} Retry</button>
        </div>
      </div></div>`;
    const retry = content.querySelector('#retry-render');
    if (retry) retry.onclick = () => render();
  }
  if (renderId === currentRender) {
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
    refreshLowStockBadge();
  }
}

/* ── boot ────────────────────────────────────────────────────────────────── */
setUnauthorizedHandler(() => {
  if (session.token) {
    session.clear();
    toast('Your session has expired. Please sign in again.', 'error');
    if (location.hash === '#/login') window.dispatchEvent(new HashChangeEvent('hashchange'));
    else location.hash = '#/login';
  }
});

window.__sfBooted = true;
window.addEventListener('hashchange', render);

(async function boot() {
  document.getElementById('boot').style.display = '';
  if (session.token) {
    try {
      await auth.me();
    } catch {
      session.clear();
    }
  }
  document.getElementById('boot').style.display = 'none';
  document.getElementById('app').hidden = false;
  render();
})();

// Global keyboard shortcut: "/" focuses the first search input on the page.
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
    const input = document.querySelector('.search-box input');
    if (input) { e.preventDefault(); input.focus(); }
  }
});
