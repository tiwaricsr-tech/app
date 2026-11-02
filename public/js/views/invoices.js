import { api, can, session } from '../api.js';
import { icon } from '../icons.js';
import {
  money, num, esc, dateShort, dateTime, statusBadge, emptyState, skeletonRows,
  toast, confirmDialog, debounce, today, daysAgo
} from '../ui.js';

/* ── invoice list ────────────────────────────────────────────────────────── */
export default async function renderInvoices({ container, navigate }) {
  const state = { search: '', status: '', from: '', to: '', page: 0, pageSize: 20 };

  container.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Invoices</h1>
        <p>Every bill you have created, with live status and printable copies.</p>
      </div>
      <div class="page-head-actions">
        ${can('reports.view') ? `<button class="btn" id="export-invoices">${icon('sheet')} Export Excel</button>` : ''}
        ${can('invoices.create') ? `<a class="btn btn-primary" href="#/billing">${icon('plus')} New bill</a>` : ''}
      </div>
    </div>
    <section class="card">
      <div class="toolbar">
        <div class="search-box">
          ${icon('search')}
          <input class="input" id="i-search" placeholder="Search invoice no, customer or phone…" />
        </div>
        <select class="select" id="i-status">
          <option value="">All statuses</option>
          <option value="paid">Paid</option>
          <option value="cancelled">Cancelled</option>
          <option value="refunded">Refunded</option>
        </select>
        <input class="input" type="date" id="i-from" style="width:auto" title="From date" />
        <input class="input" type="date" id="i-to" style="width:auto" title="To date" />
        <button class="btn btn-sm" id="i-apply">${icon('filter')} Apply</button>
        <button class="btn btn-sm btn-ghost" id="i-clear">Clear</button>
      </div>
      <div id="i-body">${skeletonRows(8)}</div>
    </section>`;

  const body = container.querySelector('#i-body');

  const load = async () => {
    body.innerHTML = skeletonRows(6);
    const params = new URLSearchParams({ limit: String(state.pageSize), offset: String(state.page * state.pageSize) });
    if (state.search) params.set('search', state.search);
    if (state.status) params.set('status', state.status);
    if (state.from) params.set('from', `${state.from}T00:00:00`);
    if (state.to) params.set('to', `${state.to}T23:59:59`);
    try {
      const data = await api.get(`/invoices?${params}`);
      if (!data.items.length) {
        body.innerHTML = emptyState({
          iconName: 'invoice',
          title: state.search || state.status ? 'No invoices match these filters' : 'No invoices yet',
          message: state.search || state.status ? 'Try a different search or status.' : 'Create your first bill to see it here.',
          action: can('invoices.create') ? `<a class="btn btn-primary" href="#/billing">${icon('plus')} Create bill</a>` : ''
        });
        return;
      }
      const totalValue = data.items.filter((i) => i.status === 'paid').reduce((s, i) => s + Number(i.total), 0);
      body.innerHTML = `
        <div class="table-wrap">
          <table class="data">
            <thead><tr>
              <th>Invoice</th><th>Customer</th><th class="num">Items</th><th class="num">Subtotal</th>
              <th class="num">Discount</th><th class="num">Tax</th><th class="num">Total</th><th>Status</th><th class="num">Actions</th>
            </tr></thead>
            <tbody>
              ${data.items.map((inv) => `
                <tr data-open="${inv.id}" style="cursor:pointer">
                  <td>
                    <div class="strong mono small">${esc(inv.invoice_no)}</div>
                    <div class="small muted">${dateShort(inv.created_at)} · ${esc(inv.created_by_name || '—')}</div>
                  </td>
                  <td>
                    <div class="strong small">${esc(inv.customer_name)}</div>
                    <div class="small muted">${esc(inv.customer_phone || inv.customer_email || '—')}</div>
                  </td>
                  <td class="num">${num(inv.item_count)}</td>
                  <td class="num">${money(inv.subtotal)}</td>
                  <td class="num">${Number(inv.discount_amount) > 0 ? '−' + money(inv.discount_amount) : '—'}</td>
                  <td class="num">${Number(inv.tax_amount) > 0 ? money(inv.tax_amount) : '—'}</td>
                  <td class="num strong">${money(inv.total)}</td>
                  <td>${statusBadge(inv.status)}</td>
                  <td>
                    <div class="row-actions">
                      <button class="btn btn-sm btn-ghost btn-icon" data-view="${inv.id}" title="Open">${icon('eye')}</button>
                      <button class="btn btn-sm btn-ghost btn-icon" data-pdf="${inv.id}" title="Download PDF">${icon('download')}</button>
                      ${inv.status === 'paid' && can('invoices.cancel') ? `<button class="btn btn-sm btn-ghost btn-icon" data-cancel="${inv.id}" title="Cancel invoice" style="color:var(--red)">${icon('ban')}</button>` : ''}
                    </div>
                  </td>
                </tr>`).join('')}
            </tbody>
            <tfoot><tr>
              <td colspan="6">Paid value on this page</td>
              <td class="num">${money(totalValue)}</td><td colspan="2"></td>
            </tr></tfoot>
          </table>
        </div>
        <div class="pagination">
          <span>${num(data.total)} invoice${data.total === 1 ? '' : 's'}</span>
          <span class="spacer"></span>
          <button class="btn btn-sm" ${state.page === 0 ? 'disabled' : ''} data-page="${state.page - 1}">${icon('arrowLeft')} Previous</button>
          <span>Page ${state.page + 1} / ${Math.max(1, Math.ceil(data.total / state.pageSize))}</span>
          <button class="btn btn-sm" ${(state.page + 1) * state.pageSize >= data.total ? 'disabled' : ''} data-page="${state.page + 1}">Next ${icon('arrowRight')}</button>
        </div>`;

      body.querySelectorAll('[data-open]').forEach((row) => {
        row.onclick = (e) => {
          if (e.target.closest('button')) return;
          navigate(`invoices/${row.dataset.open}`);
        };
      });
      body.querySelectorAll('[data-view]').forEach((b) => { b.onclick = () => navigate(`invoices/${b.dataset.view}`); });
      body.querySelectorAll('[data-pdf]').forEach((b) => {
        b.onclick = async () => {
          try { await api.openPdf(`/invoices/${b.dataset.pdf}/pdf`); }
          catch (err) { toast(err.message, 'error'); }
        };
      });
      body.querySelectorAll('[data-cancel]').forEach((b) => {
        b.onclick = async () => {
          const res = await confirmDialog({
            title: 'Cancel this invoice?',
            message: 'All sold quantities will be returned to stock immediately and the invoice will be marked cancelled. This cannot be undone.',
            confirmLabel: 'Cancel invoice', cancelLabel: 'Keep invoice', danger: true,
            requireReason: true, reasonPlaceholder: 'Reason for cancellation'
          });
          if (!res || !res.ok) return;
          try {
            await api.post(`/invoices/${b.dataset.cancel}/cancel`, { reason: res.reason });
            toast('Invoice cancelled. Stock restored.', 'success');
            load();
          } catch (err) { toast(err.message, 'error'); }
        };
      });
      body.querySelectorAll('[data-page]').forEach((b) => {
        b.onclick = () => { state.page = Number(b.dataset.page); load(); };
      });
    } catch (err) {
      body.innerHTML = `<div class="card-body"><div class="alert alert-red">${icon('alert')}<div>${esc(err.message)}</div></div></div>`;
    }
  };

  container.querySelector('#i-search').addEventListener('input', debounce((e) => {
    state.search = e.target.value.trim(); state.page = 0; load();
  }, 250));
  container.querySelector('#i-status').onchange = (e) => { state.status = e.target.value; state.page = 0; load(); };
  container.querySelector('#i-apply').onclick = () => {
    state.from = container.querySelector('#i-from').value;
    state.to = container.querySelector('#i-to').value;
    state.page = 0; load();
  };
  container.querySelector('#i-clear').onclick = () => {
    state.search = ''; state.status = ''; state.from = ''; state.to = ''; state.page = 0;
    container.querySelector('#i-search').value = '';
    container.querySelector('#i-status').value = '';
    container.querySelector('#i-from').value = '';
    container.querySelector('#i-to').value = '';
    load();
  };
  const exportBtn = container.querySelector('#export-invoices');
  if (exportBtn) {
    exportBtn.onclick = async () => {
      const stamp = today();
      try {
        await api.download('/invoices/export/xlsx', `stockflow-invoices-${stamp}.xlsx`);
        toast('Sales workbook downloaded.', 'success');
      } catch (err) { toast(err.message, 'error'); }
    };
  }

  await load();
}

/* ── invoice detail / printable view ────────────────────────────────────── */
export async function renderInvoiceDetail({ container, params, navigate }) {
  const { invoice } = await api.get(`/invoices/${params.id}`);
  const isPaid = invoice.status === 'paid';
  const canEdit = isPaid && can('invoices.edit');
  const canCancel = isPaid && can('invoices.cancel');
  const isStaffOwner = session.user.role === 'staff' && invoice.created_by === session.user.id;

  const rowsHtml = invoice.items.map((it, i) => `
    <tr>
      <td class="muted">${i + 1}</td>
      <td><div class="strong">${esc(it.product_name)}</div><div class="small muted mono">${esc(it.sku)}</div></td>
      <td class="num">${num(it.quantity)}</td>
      <td class="num">${money(it.unit_price)}</td>
      <td class="num strong">${money(it.line_total)}</td>
    </tr>`).join('');

  container.innerHTML = `
    <div class="page-head no-print">
      <div>
        <h1 style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <button class="btn btn-icon btn-ghost" id="back" aria-label="Back">${icon('arrowLeft')}</button>
          ${esc(invoice.invoice_no)} ${statusBadge(invoice.status)}
        </h1>
        <p>${esc(invoice.customer_name)} · ${dateTime(invoice.created_at)} · created by ${esc(invoice.created_by_name || '—')}</p>
      </div>
      <div class="page-head-actions">
        <button class="btn" id="print">${icon('printer')} Print</button>
        <button class="btn" id="pdf">${icon('download')} PDF</button>
        ${canEdit ? `<a class="btn btn-soft" href="#/billing?edit=${invoice.id}">${icon('edit')} Edit bill</a>` : ''}
        ${isPaid && can('invoices.cancel') ? `
          <button class="btn btn-soft-red" id="refund">${icon('undo')} Refund</button>
          <button class="btn btn-danger" id="cancel">${icon('ban')} Cancel</button>` : ''}
      </div>
    </div>

    ${!isPaid ? `<div class="alert ${invoice.status === 'cancelled' ? 'alert-red' : 'alert-amber'} no-print" style="margin-bottom:16px">
      ${icon('info')}<div><div class="alert-title">This invoice is ${esc(invoice.status)}</div>
      <div class="small">${esc(invoice.cancelled_reason || '')} · ${invoice.status === 'cancelled' ? `cancelled ${dateTime(invoice.cancelled_at)}` : `refunded ${dateTime(invoice.refunded_at)}`} by ${esc(invoice.cancelled_by_name || 'administrator')}.
      All quantities were returned to stock automatically.</div></div></div>` : ''}

    <div class="invoice-paper watermark">
      ${invoice.status !== 'paid' ? `<div class="stamp ${invoice.status}">${esc(invoice.status)}</div>` : ''}
      <div class="invoice-top">
        <div>
          <div style="display:flex;gap:10px;align-items:center">
            <span class="brand-mark" style="width:34px;height:34px;border-radius:10px">
              <svg viewBox="0 0 64 64" width="22" height="22" aria-hidden="true">
                <path d="M18 40V26l14-8 14 8v14l-14 8-14-8z" fill="none" stroke="white" stroke-width="3.4" stroke-linejoin="round"/>
                <path d="M18 26l14 8 14-8M32 34v14" stroke="white" stroke-width="3.4" stroke-linejoin="round"/>
              </svg>
            </span>
            <div>
              <div style="font-weight:750;font-size:15px">StockFlow Traders Pvt. Ltd.</div>
              <div class="small muted">12, MG Road, Indore, Madhya Pradesh 452001</div>
            </div>
          </div>
          <div class="small muted" style="margin-top:8px">+91 98260 11223 · billing@stockflow.example · GSTIN 23AABCS1429P1ZV</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:19px;font-weight:750;letter-spacing:-.02em;color:var(--brand-700)">TAX INVOICE</div>
          <div class="invoice-no" style="margin-top:4px">${esc(invoice.invoice_no)}</div>
          <div class="small muted">${dateShort(invoice.created_at)}</div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:18px">
        <div>
          <div class="small" style="text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:700;margin-bottom:6px">Billed to</div>
          <div class="strong" style="font-size:14px">${esc(invoice.customer_name)}</div>
          <div class="small muted">${esc(invoice.customer_phone || '')}</div>
          <div class="small muted">${esc(invoice.customer_email || '')}</div>
          <div class="small muted">${esc(invoice.customer_address || '')}</div>
        </div>
        <div style="text-align:right">
          <div class="small" style="text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:700;margin-bottom:6px">Payment</div>
          <div class="small"><span class="muted">Method:</span> <span class="strong" style="text-transform:uppercase">${esc(invoice.payment_method)}</span></div>
          <div class="small"><span class="muted">Status:</span> ${statusBadge(invoice.status)}</div>
          <div class="small"><span class="muted">Billed by:</span> <span class="strong">${esc(invoice.created_by_name || '—')}</span></div>
        </div>
      </div>

      <table class="invoice-table">
        <thead><tr><th style="width:36px">#</th><th>Product</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>

      <div class="invoice-summary">
        <div class="r"><span class="muted">Subtotal</span><span class="strong">${money(invoice.subtotal)}</span></div>
        ${Number(invoice.discount_amount) > 0 ? `<div class="r"><span class="muted">Discount${invoice.discount_type === 'percent' ? ` (${invoice.discount_value}%)` : ''}</span><span>−${money(invoice.discount_amount)}</span></div>` : ''}
        ${Number(invoice.tax_amount) > 0 ? `<div class="r"><span class="muted">Tax (${invoice.tax_rate}%)</span><span>${money(invoice.tax_amount)}</span></div>` : ''}
        <div class="r total"><span>Total</span><span>${money(invoice.total)}</span></div>
      </div>

      ${invoice.notes ? `<div style="margin-top:18px;padding-top:14px;border-top:1px dashed var(--line)"><div class="small" style="font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:4px">Notes</div><div class="small">${esc(invoice.notes)}</div></div>` : ''}

      <div class="small muted" style="margin-top:20px;text-align:center;padding-top:14px;border-top:1px solid var(--line-2)">
        Thank you for your business. This is a computer-generated invoice · StockFlow
      </div>
    </div>

    ${can('inventory.view') ? `<section class="card no-print" style="margin-top:18px">
      <div class="card-head"><h3>Stock impact of this invoice</h3></div>
      <div class="card-body">
        <div class="alert ${isPaid ? 'alert-blue' : 'alert-amber'}">${icon('info')}
          <div class="small">${isPaid
            ? 'These quantities were deducted from stock when the invoice was confirmed.'
            : 'This invoice is closed — every quantity below was returned to stock automatically.'}</div>
        </div>
        <div class="table-wrap" style="margin-top:12px">
          <table class="data">
            <thead><tr><th>Product</th><th class="num">Quantity</th><th>Effect</th></tr></thead>
            <tbody>${invoice.items.map((it) => `
              <tr><td>${esc(it.product_name)} <span class="small muted mono">${esc(it.sku)}</span></td>
              <td class="num">${num(it.quantity)}</td>
              <td>${statusBadge(isPaid ? 'sale' : 'sale_cancel')}</td></tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </section>` : ''}`;

  container.querySelector('#back').onclick = () => navigate('invoices');
  container.querySelector('#print').onclick = () => window.print();
  container.querySelector('#pdf').onclick = async () => {
    try { await api.openPdf(`/invoices/${invoice.id}/pdf`); }
    catch (err) { toast(err.message, 'error'); }
  };

  const cancelBtn = container.querySelector('#cancel');
  if (cancelBtn) {
    cancelBtn.onclick = async () => {
      const res = await confirmDialog({
        title: `Cancel ${invoice.invoice_no}?`,
        message: 'Every sold quantity will be returned to stock and the invoice marked cancelled. The bill stays in history for audit.',
        confirmLabel: 'Cancel invoice', cancelLabel: 'Keep invoice', danger: true,
        requireReason: true, reasonPlaceholder: 'Reason for cancellation'
      });
      if (!res || !res.ok) return;
      try {
        await api.post(`/invoices/${invoice.id}/cancel`, { reason: res.reason });
        toast('Invoice cancelled. Stock restored.', 'success');
        renderInvoiceDetail({ container, params, navigate });
      } catch (err) { toast(err.message, 'error'); }
    };
  }

  const refundBtn = container.querySelector('#refund');
  if (refundBtn) {
    refundBtn.onclick = async () => {
      const res = await confirmDialog({
        title: `Refund ${invoice.invoice_no}?`,
        message: 'The invoice will be marked refunded and all quantities returned to sellable stock.',
        confirmLabel: 'Process refund', danger: false,
        requireReason: true, reasonPlaceholder: 'Reason for refund'
      });
      if (!res || !res.ok) return;
      try {
        await api.post(`/invoices/${invoice.id}/refund`, { reason: res.reason });
        toast('Refund processed. Stock restored.', 'success');
        renderInvoiceDetail({ container, params, navigate });
      } catch (err) { toast(err.message, 'error'); }
    };
  }
}
