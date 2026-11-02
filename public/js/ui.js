import { icon } from './icons.js';

/* ── formatting ──────────────────────────────────────────────────────────── */
const currencyFmt = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const compactFmt = new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 });

export const money = (n) => currencyFmt.format(Number(n) || 0);
/** Compact Indian-format currency for KPI/summary text (e.g. ₹10.34L). */
export const moneyGrouped = (n) => {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 10000000) return `₹${(v / 10000000).toFixed(2)}Cr`;
  if (Math.abs(v) >= 100000) return `₹${(v / 100000).toFixed(2)}L`;
  return `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
};

export const moneyShort = (n) => {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 100000) return `₹${compactFmt.format(v)}`;
  return `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
};
export const num = (n) => (Number(n) || 0).toLocaleString('en-IN');
export const pct = (n, digits = 1) => `${(Number(n) || 0).toFixed(digits)}%`;

export const dateShort = (iso) => iso ? new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
export const dateTime = (iso) => iso ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
export const timeAgo = (iso) => {
  if (!iso) return '—';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return dateShort(iso);
};
export const today = () => new Date().toISOString().slice(0, 10);
export const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

/* ── DOM helpers ─────────────────────────────────────────────────────────── */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Escapes untrusted text before interpolation into HTML templates. */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export const initials = (name) => String(name || '?')
  .trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();

export function debounce(fn, wait = 280) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}

/* ── toasts ──────────────────────────────────────────────────────────────── */
export function toast(message, type = 'success', title) {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  const iconName = type === 'error' ? 'alert' : type === 'info' ? 'info' : 'checkCircle';
  el.innerHTML = `${icon(iconName)}<div class="toast-body">${title ? `<div class="toast-title">${esc(title)}</div>` : ''}<div class="toast-msg">${esc(message)}</div></div>`;
  root.appendChild(el);
  const kill = () => { el.classList.add('out'); setTimeout(() => el.remove(), 200); };
  setTimeout(kill, type === 'error' ? 6000 : 3600);
  el.addEventListener('click', kill);
}

/* ── modal ───────────────────────────────────────────────────────────────── */
let openModals = 0;

/**
 * Opens a modal. Returns { close, root }.
 * `render(close)` returns HTML string; `onMount(root, close)` wires events.
 */
export function modal({ title, subtitle, body, footer, size = '', onMount, onClose, dismissible = true }) {
  const root = document.getElementById('modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal ${size}" role="dialog" aria-modal="true" aria-label="${esc(title || 'Dialog')}">
      <div class="modal-head">
        <div>
          <h3>${esc(title || '')}</h3>
          ${subtitle ? `<div class="modal-sub">${esc(subtitle)}</div>` : ''}
        </div>
        ${dismissible ? `<button class="btn btn-icon btn-ghost" data-close aria-label="Close">${icon('x')}</button>` : ''}
      </div>
      <div class="modal-body">${body || ''}</div>
      ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
    </div>`;
  root.appendChild(backdrop);
  openModals += 1;
  document.body.style.overflow = 'hidden';

  const close = () => {
    backdrop.remove();
    openModals = Math.max(0, openModals - 1);
    if (!openModals) document.body.style.overflow = '';
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape' && dismissible && !e.defaultPrevented) close(); };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop && dismissible) close();
  });
  backdrop.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) close();
  });
  const modalEl = backdrop.querySelector('.modal');
  if (onMount) onMount(modalEl, close);
  const firstInput = modalEl.querySelector('input:not([type=hidden]):not([type=file]), select, textarea');
  if (firstInput) setTimeout(() => firstInput.focus(), 60);
  return { close, root: modalEl };
}

export function confirmDialog({ title = 'Are you sure?', message, confirmLabel = 'Confirm', danger = false, cancelLabel = 'Cancel', requireReason = false, reasonPlaceholder = 'Reason (optional)' } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const m = modal({
      title,
      body: `
        <p class="muted" style="font-size:13.5px;line-height:1.6">${esc(message || '')}</p>
        ${requireReason ? `<div class="field" style="margin-top:14px"><label for="reason-input">${esc(reasonPlaceholder)}</label>
          <textarea class="textarea" id="reason-input" rows="2" placeholder="e.g. Customer cancelled the order"></textarea></div>` : ''}`,
      footer: `<button class="btn" data-cancel>${esc(cancelLabel)}</button>
               <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-confirm>${esc(confirmLabel)}</button>`,
      size: '',
      onMount(root, close) {
        root.querySelector('[data-cancel]').onclick = () => { settled = true; close(); resolve(false); };
        root.querySelector('[data-confirm]').onclick = () => {
          const reasonEl = root.querySelector('#reason-input');
          settled = true; close(); resolve({ ok: true, reason: reasonEl ? reasonEl.value.trim() : '' });
        };
      },
      onClose() { if (!settled) resolve(false); }
    });
    return m;
  });
}

/* ── small render helpers ────────────────────────────────────────────────── */
export const statusBadge = (status) => {
  const map = {
    paid: ['badge-green', 'Paid'], active: ['badge-green', 'Active'], completed: ['badge-green', 'Completed'],
    cancelled: ['badge-red', 'Cancelled'], inactive: ['badge-gray', 'Inactive'],
    refunded: ['badge-amber', 'Refunded'], archived: ['badge-gray', 'Archived'],
    low: ['badge-amber', 'Low stock'], out_of_stock: ['badge-red', 'Out of stock'],
    in: ['badge-green', 'Stock in'], out: ['badge-amber', 'Stock out'], sale: ['badge-blue', 'Sale'],
    sale_cancel: ['badge-violet', 'Sale cancelled'], sale_refund: ['badge-violet', 'Refund'],
    adjustment: ['badge-gray', 'Adjustment'], return: ['badge-violet', 'Return']
  };
  const [cls, label] = map[status] || ['badge-gray', status];
  return `<span class="badge ${cls}"><span class="dot"></span>${esc(label)}</span>`;
};

export const roleBadge = (role) => {
  const map = { admin: ['badge-blue', 'Administrator'], manager: ['badge-violet', 'Manager'], staff: ['badge-gray', 'Billing Staff'] };
  const [cls, label] = map[role] || ['badge-gray', role];
  return `<span class="badge ${cls}">${esc(label || role)}</span>`;
};

export function qtyChip(quantity, threshold) {
  const q = Number(quantity) || 0;
  const t = Number(threshold) || 0;
  if (q <= 0) return `<span class="qty-chip out">0</span>`;
  if (q <= t) return `<span class="qty-chip low">${num(q)}</span>`;
  return `<span class="qty-chip ok">${num(q)}</span>`;
}

export function productThumb(product, extraClass = '') {
  if (product && product.image_url) {
    return `<img class="thumb ${extraClass}" src="${esc(product.image_url)}" alt="" loading="lazy" />`;
  }
  const letter = String((product && product.name) || '?').trim()[0] || '?';
  return `<div class="thumb thumb-ph ${extraClass}" aria-hidden="true">${esc(letter.toUpperCase())}</div>`;
}

export const emptyState = ({ iconName = 'box', title, message, action }) => `
  <div class="empty">
    <div class="empty-icon">${icon(iconName)}</div>
    <h4>${esc(title)}</h4>
    <p>${esc(message || '')}</p>
    ${action || ''}
  </div>`;

export const skeletonRows = (rows = 6) => `<div class="loading-rows">${Array.from({ length: rows }, (_, i) =>
  `<div class="skeleton" style="height:40px;opacity:${1 - i * 0.09}"></div>`).join('')}</div>`;

export function buttonLoading(btn, label = 'Working…') {
  if (!btn) return () => {};
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner${btn.classList.contains('btn-primary') || btn.classList.contains('btn-danger') ? '' : ' spinner-dark'}"></span>${esc(label)}`;
  return () => { btn.disabled = false; btn.innerHTML = original; };
}

/* ── charts (inline SVG, no dependencies) ────────────────────────────────── */
export function lineChart(points, { height = 168, labelKey = 'day', valueKey = 'revenue', formatter = moneyShort } = {}) {
  const w = 720;
  const h = height;
  const pad = { l: 46, r: 12, t: 14, b: 24 };
  const values = points.map((p) => Number(p[valueKey]) || 0);
  const max = Math.max(1, ...values);
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;
  const x = (i) => pad.l + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v) => pad.t + innerH - (v / max) * innerH;

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(values[i]).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)},${pad.t + innerH} L${x(0).toFixed(1)},${pad.t + innerH} Z`;
  const gridLines = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const gy = pad.t + innerH - f * innerH;
    return `<line x1="${pad.l}" y1="${gy}" x2="${w - pad.r}" y2="${gy}" />
            <text class="chart-axis" x="${pad.l - 8}" y="${gy + 3}" text-anchor="end">${esc(formatter(max * f))}</text>`;
  }).join('');
  const ticks = points.map((p, i) => (i % Math.ceil(points.length / 7) === 0 || i === points.length - 1)
    ? `<text class="chart-axis" x="${x(i)}" y="${h - 6}" text-anchor="middle">${esc(new Date(p[labelKey]).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }))}</text>`
    : '').join('');
  const dots = points.map((p, i) => `<circle cx="${x(i)}" cy="${y(values[i])}" r="2.6" fill="#1d4ed8"><title>${esc(p[labelKey])}: ${esc(formatter(values[i]))}</title></circle>`).join('');

  return `<svg class="chart" viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" role="img" aria-label="Sales trend">
    <defs><linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#3b76f6" stop-opacity=".26"/><stop offset="100%" stop-color="#3b76f6" stop-opacity="0"/>
    </linearGradient></defs>
    <g class="chart-grid">${gridLines}</g>
    <path d="${area}" fill="url(#areaGrad)"/>
    <path d="${line}" fill="none" stroke="#1d4ed8" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}${ticks}
  </svg>`;
}

/** Turns 2026-11-01 into "01 Nov" and 2026-11 into "Nov 26" for chart axes. */
export function shortPeriod(label) {
  const str = String(label || '');
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (day) {
    const d = new Date(`${str}T00:00:00Z`);
    return `${day[3]} ${d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })}`;
  }
  const month = /^(\d{4})-(\d{2})$/.exec(str);
  if (month) {
    const d = new Date(`${str}-01T00:00:00Z`);
    return `${d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })} ${day ? '' : month[1].slice(2)}`;
  }
  return str.length > 10 ? `${str.slice(0, 9)}…` : str;
}

export function barChart(items, { height = 190, valueKey = 'value', labelKey = 'label', formatter = moneyShort } = {}) {
  if (!items.length) return emptyState({ title: 'No data yet', message: 'Charts appear once there is activity.' });
  const w = 560; const h = height; const pad = { l: 8, r: 8, t: 12, b: 30 };
  const max = Math.max(1, ...items.map((i) => Number(i[valueKey]) || 0));
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;
  const gap = 10;
  const barW = Math.max(8, (innerW - gap * (items.length - 1)) / items.length);
  const bars = items.map((it, i) => {
    const v = Number(it[valueKey]) || 0;
    const bh = Math.max(3, (v / max) * innerH);
    const x = pad.l + i * (barW + gap);
    return `<g><rect class="chart-bar" x="${x}" y="${pad.t + innerH - bh}" width="${barW}" height="${bh}" rx="4" fill="#93b4fd">
      <title>${esc(it[labelKey])}: ${esc(formatter(v))}</title></rect>
      <text class="chart-axis" x="${x + barW / 2}" y="${h - 10}" text-anchor="middle">${esc(shortPeriod(it[labelKey]))}</text></g>`;
  }).join('');
  return `<svg class="chart chart-inline" viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Bar chart">${bars}</svg>`;
}

/* ── misc ────────────────────────────────────────────────────────────────── */
export function downloadCsv(filename, rows) {
  const csv = rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

export function readFileAsDataUrl(file, maxBytes = 1.6 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) return reject(new Error('Please choose an image file.'));
    if (file.size > maxBytes) return reject(new Error('Image must be smaller than 1.6 MB.'));
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsDataURL(file);
  });
}
