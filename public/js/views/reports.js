import { api, can } from '../api.js';
import { icon } from '../icons.js';
import {
  money, moneyShort, num, esc, emptyState, skeletonRows, toast, today, daysAgo, buttonLoading, barChart
} from '../ui.js';

const TABS = [
  { key: 'sales', label: 'Daily sales', iconName: 'trendUp', range: true, group: 'day' },
  { key: 'monthly', label: 'Monthly sales', iconName: 'calendar', range: true, group: 'month' },
  { key: 'valuation', label: 'Inventory valuation', iconName: 'box', range: false },
  { key: 'lowstock', label: 'Low stock', iconName: 'alert', range: false },
  { key: 'movement', label: 'Product movement', iconName: 'activity', range: true }
];

export default async function renderReports({ container }) {
  const state = {
    tab: 'sales',
    from: daysAgo(29),
    to: today(),
    group: 'day'
  };

  container.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Reports</h1>
        <p>Reconciled operational reports — export any view to PDF or Excel.</p>
      </div>
      <div class="page-head-actions">
        <button class="btn" id="r-xlsx">${icon('sheet')} Export Excel</button>
        <button class="btn btn-primary" id="r-pdf">${icon('file')} Export PDF</button>
      </div>
    </div>

    <div class="stack">
      <section class="card">
        <div class="toolbar" style="border-bottom:1px solid var(--line-2)">
          <div class="segmented" id="r-tabs" style="flex-wrap:wrap">
            ${TABS.map((t) => `<button data-tab="${t.key}" class="${t.key === 'sales' ? 'active' : ''}" style="display:inline-flex;align-items:center;gap:6px">
              ${icon(t.iconName, 'width="14" height="14"')} ${t.label}</button>`).join('')}
          </div>
        </div>
        <div class="card-body">
          <div class="report-filters" id="r-filters"></div>
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <div>
            <h3 id="r-title">Sales Report</h3>
            <div class="small muted" id="r-subtitle"></div>
          </div>
          <button class="btn btn-sm btn-ghost" id="r-refresh" style="margin-left:auto">${icon('refresh')} Refresh</button>
        </div>
        <div class="card-body" id="r-summary"></div>
        <div id="r-body">${skeletonRows(8)}</div>
      </section>
    </div>`;

  const filtersEl = container.querySelector('#r-filters');
  const bodyEl = container.querySelector('#r-body');
  const summaryEl = container.querySelector('#r-summary');

  const activeTab = () => TABS.find((t) => t.key === state.tab);

  const renderFilters = () => {
    const tab = activeTab();
    filtersEl.innerHTML = `
      ${tab.range ? `
        <div class="field"><label for="r-from">From</label><input class="input" type="date" id="r-from" value="${state.from}" /></div>
        <div class="field"><label for="r-to">To</label><input class="input" type="date" id="r-to" value="${state.to}" /></div>
        ${['sales', 'monthly'].includes(state.tab) ? `<div class="field"><label for="r-group">Group by</label>
          <select class="select" id="r-group">
            <option value="day" ${state.group === 'day' ? 'selected' : ''}>Day</option>
            <option value="month" ${state.group === 'month' ? 'selected' : ''}>Month</option>
          </select></div>` : ''}
        <button class="btn btn-primary" id="r-apply">${icon('filter')} Apply filters</button>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn btn-sm" data-range="7">Last 7 days</button>
          <button class="btn btn-sm" data-range="30">Last 30 days</button>
          <button class="btn btn-sm" data-range="90">Last 90 days</button>
          <button class="btn btn-sm" data-range="365">This year</button>
        </div>` : `<span class="small muted">This report is a live snapshot — no date filter required.</span>`}`;

    const apply = filtersEl.querySelector('#r-apply');
    if (apply) {
      apply.onclick = () => {
        state.from = filtersEl.querySelector('#r-from').value || daysAgo(30);
        state.to = filtersEl.querySelector('#r-to').value || today();
        const groupEl = filtersEl.querySelector('#r-group');
        if (groupEl) state.group = groupEl.value;
        load();
      };
    }
    filtersEl.querySelectorAll('[data-range]').forEach((btn) => {
      btn.onclick = () => {
        const days = Number(btn.dataset.range);
        state.from = daysAgo(days - 1);
        state.to = today();
        renderFilters();
        load();
      };
    });
  };

  const query = () => {
    const params = new URLSearchParams();
    const tab = activeTab();
    if (tab.range) { params.set('from', state.from); params.set('to', state.to); }
    if (['sales', 'monthly'].includes(state.tab)) params.set('groupBy', state.tab === 'monthly' ? 'month' : state.group);
    return params.toString();
  };

  const load = async () => {
    bodyEl.innerHTML = skeletonRows(8);
    summaryEl.innerHTML = '<div class="skeleton" style="height:64px"></div>';
    try {
      const data = await api.get(`/reports/${state.tab}?${query()}`);
      container.querySelector('#r-title').textContent = data.title;
      container.querySelector('#r-subtitle').textContent = data.subtitle || '';
      summaryEl.innerHTML = `<div class="summary-grid">${data.summary.map(([k, v]) => {
        const text = String(v);
        const wide = text.length > 34 ? ' is-wide' : '';
        const size = text.length > 46 ? '11.5px' : text.length > 22 ? '12.5px' : '15.5px';
        return `<div class="summary-cell${wide}"><div class="k">${esc(k)}</div><div class="v" style="font-size:${size}">${esc(text)}</div></div>`;
      }).join('')}</div>`;

      if (state.tab === 'sales' || state.tab === 'monthly') renderSalesTable(data);
      else if (state.tab === 'valuation') renderValuation(data);
      else if (state.tab === 'lowstock') renderLowStock(data);
      else renderMovement(data);
    } catch (err) {
      bodyEl.innerHTML = `<div class="card-body"><div class="alert alert-red">${icon('alert')}<div>${esc(err.message)}</div></div></div>`;
      summaryEl.innerHTML = '';
    }
  };

  const renderSalesTable = (data) => {
    if (!data.rows.length) {
      bodyEl.innerHTML = emptyState({ iconName: 'trendUp', title: 'No sales in this period', message: 'Try widening the date range.' });
      return;
    }
    const maxRev = Math.max(...data.rows.map((r) => Number(r.revenue)));
    bodyEl.innerHTML = `
      <div class="card-body" style="padding-bottom:0">${barChart(data.rows.slice(0, 12).reverse().map((r) => ({ label: r.period, value: Number(r.revenue) })), { valueKey: 'value', labelKey: 'label' })}</div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>Period</th><th class="num">Bills</th><th class="num">Subtotal</th><th class="num">Discount</th><th class="num">Tax</th><th class="num">Revenue</th><th style="width:120px">Share</th></tr></thead>
          <tbody>
            ${data.rows.map((r) => `
              <tr>
                <td class="strong">${esc(r.period)}</td>
                <td class="num">${num(r.bills)}</td>
                <td class="num">${money(r.subtotal)}</td>
                <td class="num">${Number(r.discount) > 0 ? '−' + money(r.discount) : '—'}</td>
                <td class="num">${Number(r.tax) > 0 ? money(r.tax) : '—'}</td>
                <td class="num strong">${money(r.revenue)}</td>
                <td><div class="progress"><i style="width:${(Number(r.revenue) / maxRev) * 100}%"></i></div></td>
              </tr>`).join('')}
          </tbody>
          <tfoot><tr>
            <td>Total</td><td class="num">${num(data.totals.bills)}</td>
            <td class="num">${money(data.totals.subtotal)}</td>
            <td class="num">−${money(data.totals.discount)}</td>
            <td class="num">${money(data.totals.tax)}</td>
            <td class="num">${money(data.totals.revenue)}</td><td></td>
          </tr></tfoot>
        </table>
      </div>
      ${data.topItems && data.topItems.length ? `<div class="card-body" style="border-top:1px solid var(--line-2)">
        <div class="section-head"><span class="section-title">Best sellers in this period</span></div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>Product</th><th>SKU</th><th class="num">Units sold</th><th class="num">Revenue</th></tr></thead>
          <tbody>${data.topItems.map((p) => `<tr><td class="strong small">${esc(p.product_name)}</td><td class="mono small">${esc(p.sku)}</td><td class="num">${num(p.units)}</td><td class="num strong">${money(p.revenue)}</td></tr>`).join('')}</tbody>
        </table></div>
      </div>` : ''}`;
  };

  const renderValuation = (data) => {
    if (!data.items.length) { bodyEl.innerHTML = emptyState({ iconName: 'box', title: 'No active products' }); return; }
    bodyEl.innerHTML = `
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>Product</th><th>SKU</th><th>Category</th><th class="num">Qty</th><th class="num">Purchase</th><th class="num">Selling</th><th class="num">Cost value</th><th class="num">Retail value</th><th class="num">Margin</th></tr></thead>
          <tbody>
            ${data.items.map((p) => `
              <tr>
                <td class="strong small">${esc(p.name)}</td>
                <td class="mono small">${esc(p.sku)}</td>
                <td class="small">${esc(p.category)}</td>
                <td class="num">${num(p.quantity)}</td>
                <td class="num">${money(p.purchase_price)}</td>
                <td class="num">${money(p.selling_price)}</td>
                <td class="num">${money(p.purchase_value)}</td>
                <td class="num strong">${money(p.selling_value)}</td>
                <td class="num" style="color:${p.margin >= 0 ? 'var(--green)' : 'var(--red)'}">${money(p.margin)}</td>
              </tr>`).join('')}
          </tbody>
          <tfoot><tr>
            <td colspan="3">Totals</td><td class="num">${num(data.totals.units)}</td><td colspan="2"></td>
            <td class="num">${money(data.totals.purchase_value)}</td>
            <td class="num">${money(data.totals.selling_value)}</td>
            <td class="num">${money(data.totals.potential_profit)}</td>
          </tr></tfoot>
        </table>
      </div>`;
  };

  const renderLowStock = (data) => {
    if (!data.items.length) {
      bodyEl.innerHTML = emptyState({ iconName: 'checkCircle', title: 'No low stock items', message: 'Every product is above its reorder level.' });
      return;
    }
    bodyEl.innerHTML = `
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>Product</th><th>SKU</th><th>Category</th><th class="num">In stock</th><th class="num">Reorder at</th><th class="num">Suggested restock</th><th class="num">Restock cost</th><th>Status</th></tr></thead>
          <tbody>
            ${data.items.map((p) => {
              const suggested = Math.max(p.low_stock_threshold * 2 - p.quantity, p.low_stock_threshold);
              return `<tr>
                <td class="strong small">${esc(p.name)}</td>
                <td class="mono small">${esc(p.sku)}</td>
                <td class="small">${esc(p.category)}</td>
                <td class="num ${p.quantity === 0 ? 'strong' : ''}" style="color:${p.quantity === 0 ? 'var(--red)' : 'var(--amber)'}">${num(p.quantity)}</td>
                <td class="num muted">${num(p.low_stock_threshold)}</td>
                <td class="num">${num(suggested)}</td>
                <td class="num">${money(suggested * p.purchase_price)}</td>
                <td><span class="badge ${p.quantity === 0 ? 'badge-red' : 'badge-amber'}">${esc(p.status_label)}</span></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
  };

  const renderMovement = (data) => {
    if (!data.rows.length) {
      bodyEl.innerHTML = emptyState({ iconName: 'activity', title: 'No stock movements in this period', message: 'Adjust the dates or record stock changes.' });
      return;
    }
    bodyEl.innerHTML = `
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>Product</th><th>SKU</th><th class="num">Stock in</th><th class="num">Sold</th><th class="num">Returned</th><th class="num">Adjusted</th><th class="num">On hand</th><th style="width:110px">Sell-through</th></tr></thead>
          <tbody>
            ${data.rows.map((r) => {
              const totalIn = Number(r.stock_in) + Number(r.sold);
              const rate = totalIn > 0 ? (Number(r.sold) / totalIn) * 100 : 0;
              return `<tr>
                <td class="strong small">${esc(r.product_name)}</td>
                <td class="mono small">${esc(r.sku)}</td>
                <td class="num" style="color:var(--green)">+${num(r.stock_in)}</td>
                <td class="num" style="color:var(--red)">−${num(r.sold)}</td>
                <td class="num">${num(r.returned) || '—'}</td>
                <td class="num">${Number(r.adjusted) === 0 ? '—' : (Number(r.adjusted) > 0 ? '+' : '') + num(r.adjusted)}</td>
                <td class="num strong">${num(r.current_stock)}</td>
                <td><div class="progress"><i style="width:${Math.min(100, rate)}%"></i></div><div class="small muted" style="margin-top:2px">${rate.toFixed(0)}%</div></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
  };

  container.querySelectorAll('#r-tabs button').forEach((btn) => {
    btn.onclick = () => {
      container.querySelectorAll('#r-tabs button').forEach((b) => b.classList.toggle('active', b === btn));
      state.tab = btn.dataset.tab;
      if (state.tab === 'monthly') state.group = 'month';
      if (state.tab === 'sales') state.group = 'day';
      renderFilters();
      load();
    };
  });

  const doExport = async (format, btn) => {
    const stamp = today();
    const restore = buttonLoading(btn, 'Preparing…');
    try {
      const ext = format === 'xlsx' ? 'xlsx' : 'pdf';
      await api.download(`/reports/${state.tab}/export/${format}?${query()}`, `stockflow-${state.tab}-${stamp}.${ext}`);
      toast(`${format === 'xlsx' ? 'Excel workbook' : 'PDF report'} downloaded.`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    } finally { restore(); }
  };
  container.querySelector('#r-xlsx').onclick = (e) => doExport('xlsx', e.currentTarget);
  container.querySelector('#r-pdf').onclick = (e) => doExport('pdf', e.currentTarget);
  container.querySelector('#r-refresh').onclick = () => { load(); toast('Report refreshed.', 'info'); };

  renderFilters();
  await load();
}
