import { api, can } from '../api.js';
import { icon } from '../icons.js';
import {
  money, num, esc, dateTime, qtyChip, statusBadge, productThumb, emptyState, skeletonRows,
  toast, modal, debounce, buttonLoading, today, daysAgo
} from '../ui.js';
import { openStockAdjust } from './products.js';

export default async function renderInventory({ container, navigate, query }) {
  const state = {
    tab: query?.get('low') === '1' ? 'low' : 'movements',
    search: '',
    type: '',
    from: daysAgo(30),
    to: today(),
    product_id: '',
    page: 0,
    pageSize: 40
  };

  container.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Inventory</h1>
        <p>Real-time stock, reorder alerts and the complete movement ledger.</p>
      </div>
      <div class="page-head-actions">
        <button class="btn" id="inv-refresh">${icon('refresh')} Refresh</button>
        ${can('stock.adjust') ? `<button class="btn btn-primary" id="inv-adjust">${icon('plus')} Adjust stock</button>` : ''}
      </div>
    </div>

    <div class="stack">
      <div class="stats" id="inv-stats">
        <div class="stat"><div class="skeleton" style="height:64px"></div></div>
        <div class="stat"><div class="skeleton" style="height:64px"></div></div>
        <div class="stat"><div class="skeleton" style="height:64px"></div></div>
        <div class="stat"><div class="skeleton" style="height:64px"></div></div>
      </div>

      <section class="card">
        <div class="toolbar">
          <div class="segmented" id="inv-tabs">
            <button data-tab="movements" class="${state.tab === 'movements' ? 'active' : ''}">Movement ledger</button>
            <button data-tab="low" class="${state.tab === 'low' ? 'active' : ''}">Low stock</button>
            <button data-tab="stock" class="${state.tab === 'stock' ? 'active' : ''}">Stock on hand</button>
          </div>
          <div class="toolbar-spacer"></div>
          <div class="search-box" style="max-width:280px">
            ${icon('search')}
            <input class="input" id="inv-search" placeholder="Search product or note…" />
          </div>
        </div>
        <div id="inv-filter-row" class="toolbar" style="border-top:0;padding-top:0"></div>
        <div id="inv-body">${skeletonRows(8)}</div>
      </section>
    </div>`;

  const statsEl = container.querySelector('#inv-stats');
  const bodyEl = container.querySelector('#inv-body');
  const filterRow = container.querySelector('#inv-filter-row');

  const loadStats = async () => {
    try {
      const s = await api.get('/inventory/summary');
      statsEl.innerHTML = `
        <article class="stat" style="--stat-accent:#1d4ed8;--stat-bg:var(--brand-50)">
          <div class="stat-top"><span class="stat-icon">${icon('inventory')}</span><span class="stat-label">Total units on hand</span></div>
          <div class="stat-value">${num(s.total_units)}</div>
          <div class="stat-meta">across ${num(s.product_count)} active products</div>
        </article>
        <article class="stat" style="--stat-accent:#7c3aed;--stat-bg:var(--violet-bg)">
          <div class="stat-top"><span class="stat-icon">${icon('box')}</span><span class="stat-label">Inventory cost value</span></div>
          <div class="stat-value">${money(s.purchase_value)}</div>
          <div class="stat-meta">retail ${money(s.selling_value)} · profit ${money(s.potential_profit)}</div>
        </article>
        <article class="stat" style="--stat-accent:${s.low_stock_count ? '#b45309' : '#059669'};--stat-bg:${s.low_stock_count ? 'var(--amber-bg)' : 'var(--green-bg)'}">
          <div class="stat-top"><span class="stat-icon">${icon('alert')}</span><span class="stat-label">Low stock</span></div>
          <div class="stat-value">${num(s.low_stock_count)}</div>
          <div class="stat-meta">at or below reorder level</div>
        </article>
        <article class="stat" style="--stat-accent:${s.out_of_stock_count ? '#dc2626' : '#059669'};--stat-bg:${s.out_of_stock_count ? 'var(--red-bg)' : 'var(--green-bg)'}">
          <div class="stat-top"><span class="stat-icon">${icon('ban')}</span><span class="stat-label">Out of stock</span></div>
          <div class="stat-value">${num(s.out_of_stock_count)}</div>
          <div class="stat-meta">unavailable for billing</div>
        </article>`;
    } catch (err) {
      statsEl.innerHTML = `<div class="alert alert-red">${icon('alert')}<div>${esc(err.message)}</div></div>`;
    }
  };

  const renderFilters = () => {
    if (state.tab === 'movements') {
      filterRow.innerHTML = `
        <select class="select" id="f-type">
          <option value="">All movement types</option>
          ${[['in', 'Stock in'], ['out', 'Stock out'], ['sale', 'Sale'], ['sale_cancel', 'Sale cancelled'], ['sale_refund', 'Refund'], ['adjustment', 'Adjustment']]
            .map(([v, l]) => `<option value="${v}" ${state.type === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <div class="field" style="min-width:0"><input class="input" type="date" id="f-from" value="${state.from}" title="From date" /></div>
        <div class="field" style="min-width:0"><input class="input" type="date" id="f-to" value="${state.to}" title="To date" /></div>
        <button class="btn btn-sm" id="f-apply">${icon('filter')} Apply</button>
        <button class="btn btn-sm btn-ghost" id="f-reset">Reset</button>`;
      filterRow.querySelector('#f-type').onchange = (e) => { state.type = e.target.value; state.page = 0; load(); };
      filterRow.querySelector('#f-apply').onclick = () => {
        state.from = filterRow.querySelector('#f-from').value;
        state.to = filterRow.querySelector('#f-to').value;
        state.page = 0; load();
      };
      filterRow.querySelector('#f-reset').onclick = () => {
        state.type = ''; state.from = daysAgo(30); state.to = today(); state.search = ''; state.page = 0;
        container.querySelector('#inv-search').value = '';
        renderFilters(); load();
      };
    } else {
      filterRow.innerHTML = `<span class="small muted">${state.tab === 'low' ? 'Products at or below their reorder level, most urgent first.' : 'Live quantity on hand for every active product.'}</span>`;
    }
  };

  const load = async () => {
    bodyEl.innerHTML = skeletonRows(8);
    try {
      if (state.tab === 'movements') return await loadMovements();
      if (state.tab === 'low') return await loadLowStock();
      return await loadStockOnHand();
    } catch (err) {
      bodyEl.innerHTML = `<div class="card-body"><div class="alert alert-red">${icon('alert')}<div>${esc(err.message)}</div></div></div>`;
    }
  };

  const loadMovements = async () => {
    const params = new URLSearchParams({ limit: String(state.pageSize), offset: String(state.page * state.pageSize) });
    if (state.type) params.set('type', state.type);
    if (state.search) params.set('search', state.search);
    if (state.product_id) params.set('product_id', state.product_id);
    const data = await api.get(`/inventory/movements?${params}`);
    if (!data.items.length) {
      bodyEl.innerHTML = emptyState({ iconName: 'activity', title: 'No movements found', message: 'Adjust the filters or record a stock change.' });
      return;
    }
    bodyEl.innerHTML = `
      <div class="table-wrap">
        <table class="data">
          <thead><tr>
            <th>When</th><th>Product</th><th>Type</th><th class="num">Change</th>
            <th class="num">Before</th><th class="num">After</th><th>Reference</th><th>By</th>
          </tr></thead>
          <tbody>
            ${data.items.map((m) => `
              <tr>
                <td class="nowrap small">${dateTime(m.created_at)}</td>
                <td><div class="strong small">${esc(m.product_name)}</div><div class="small muted mono">${esc(m.sku)}</div></td>
                <td>${statusBadge(m.type)}</td>
                <td class="num"><span class="strong" style="color:${m.quantity_change > 0 ? 'var(--green)' : 'var(--red)'}">${m.quantity_change > 0 ? '+' : ''}${num(m.quantity_change)}</span></td>
                <td class="num muted">${num(m.quantity_before)}</td>
                <td class="num strong">${num(m.quantity_after)}</td>
                <td class="small muted" style="max-width:220px">${esc(m.note || '—')}</td>
                <td class="small">${esc(m.user_name || 'System')}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      ${pagination(data.total, state, load)}`;
  };

  const loadLowStock = async () => {
    const data = await api.get('/inventory/low-stock?limit=200');
    if (!data.items.length) {
      bodyEl.innerHTML = emptyState({ iconName: 'checkCircle', title: 'Everything is well stocked', message: 'No product is at or below its reorder level right now.' });
      return;
    }
    bodyEl.innerHTML = `
      <div class="card-body" style="padding-bottom:8px">
        <div class="alert alert-amber">${icon('alert')}<div><div class="alert-title">${data.count} item${data.count === 1 ? '' : 's'} need attention</div>
        <div class="small">Reorder these products to avoid missed sales. Stock can never go below zero, so billing will block out-of-stock items.</div></div></div>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>Product</th><th>Category</th><th class="num">In stock</th><th class="num">Reorder at</th><th class="num">Suggested restock</th><th>Status</th><th class="num">Action</th></tr></thead>
          <tbody>
            ${data.items.map((p) => {
              const suggested = Math.max(p.low_stock_threshold * 2 - p.quantity, p.low_stock_threshold);
              return `<tr>
                <td><div class="cell-product">${productThumb(p)}<div><div class="name">${esc(p.name)}</div><div class="sub mono">${esc(p.sku)}</div></div></div></td>
                <td class="small">${esc(p.category_name || '—')}</td>
                <td class="num">${qtyChip(p.quantity, p.low_stock_threshold)}</td>
                <td class="num muted">${num(p.low_stock_threshold)}</td>
                <td class="num">${num(suggested)} units <span class="small muted">(${money(suggested * p.purchase_price)})</span></td>
                <td>${statusBadge(p.severity)}</td>
                <td class="num">${can('stock.adjust') ? `<button class="btn btn-sm btn-soft" data-restock="${p.id}">${icon('plus')} Restock</button>` : '<span class="muted small">—</span>'}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;

    bodyEl.querySelectorAll('[data-restock]').forEach((btn) => {
      btn.onclick = () => {
        const product = data.items.find((x) => String(x.id) === String(btn.dataset.restock));
        openStockAdjust({
          product: { ...product }, mode: 'in',
          onDone: () => { loadStats(); load(); }
        });
      };
    });
  };

  const loadStockOnHand = async () => {
    const params = new URLSearchParams({ limit: '500', status: 'active' });
    if (state.search) params.set('search', state.search);
    const data = await api.get(`/products?${params}`);
    if (!data.items.length) {
      bodyEl.innerHTML = emptyState({ iconName: 'products', title: 'No products found' });
      return;
    }
    bodyEl.innerHTML = `
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>Product</th><th>SKU</th><th>Category</th><th class="num">On hand</th><th class="num">Cost value</th><th class="num">Retail value</th><th>Level</th><th class="num">Action</th></tr></thead>
          <tbody>
            ${data.items.map((p) => {
              const ratio = Math.min(100, (Number(p.quantity) / Math.max(1, Number(p.low_stock_threshold) * 3)) * 100);
              const cls = p.quantity <= 0 ? 'out' : p.quantity <= p.low_stock_threshold ? 'low' : 'ok';
              return `<tr>
                <td><div class="cell-product">${productThumb(p)}<div><div class="name">${esc(p.name)}</div><div class="sub">${esc(p.category_name || 'Uncategorised')}</div></div></div></td>
                <td class="mono small">${esc(p.sku)}</td>
                <td class="small">${esc(p.category_name || '—')}</td>
                <td class="num">${qtyChip(p.quantity, p.low_stock_threshold)}</td>
                <td class="num">${money(p.stock_value_purchase)}</td>
                <td class="num strong">${money(p.stock_value_selling)}</td>
                <td style="min-width:110px"><div class="progress ${cls}"><i style="width:${ratio}%"></i></div></td>
                <td class="num">${can('stock.adjust') ? `<div class="row-actions">
                  <button class="btn btn-sm btn-ghost btn-icon" data-in="${p.id}" title="Increase">+</button>
                  <button class="btn btn-sm btn-ghost btn-icon" data-out="${p.id}" title="Decrease">−</button>
                </div>` : ''}</td>
              </tr>`;
            }).join('')}
          </tbody>
          <tfoot><tr>
            <td colspan="3">Totals</td>
            <td class="num">${num(data.items.reduce((s, p) => s + Number(p.quantity), 0))}</td>
            <td class="num">${money(data.items.reduce((s, p) => s + Number(p.stock_value_purchase), 0))}</td>
            <td class="num">${money(data.items.reduce((s, p) => s + Number(p.stock_value_selling), 0))}</td>
            <td colspan="2"></td>
          </tr></tfoot>
        </table>
      </div>`;

    bodyEl.querySelectorAll('[data-in]').forEach((b) => {
      b.onclick = () => openStockAdjust({ product: data.items.find((x) => String(x.id) === String(b.dataset.in)), mode: 'in', onDone: () => { loadStats(); load(); } });
    });
    bodyEl.querySelectorAll('[data-out]').forEach((b) => {
      b.onclick = () => openStockAdjust({ product: data.items.find((x) => String(x.id) === String(b.dataset.out)), mode: 'out', onDone: () => { loadStats(); load(); } });
    });
  };

  const pagination = (total, s, reload) => {
    const pages = Math.max(1, Math.ceil(total / s.pageSize));
    return `<div class="pagination">
      <span>Showing ${Math.min(total, s.page * s.pageSize + 1)}–${Math.min(total, (s.page + 1) * s.pageSize)} of ${num(total)} movements</span>
      <span class="spacer"></span>
      <button class="btn btn-sm" ${s.page === 0 ? 'disabled' : ''} data-page="${s.page - 1}">${icon('arrowLeft')} Previous</button>
      <span>Page ${s.page + 1} / ${pages}</span>
      <button class="btn btn-sm" ${s.page + 1 >= pages ? 'disabled' : ''} data-page="${s.page + 1}">Next ${icon('arrowRight')}</button>
    </div>`;
  };

  bodyEl.addEventListener('click', (e) => {
    const pageBtn = e.target.closest('[data-page]');
    if (pageBtn) { state.page = Number(pageBtn.dataset.page); load(); }
  });

  /* tab switching */
  container.querySelectorAll('#inv-tabs button').forEach((btn) => {
    btn.onclick = () => {
      container.querySelectorAll('#inv-tabs button').forEach((b) => b.classList.toggle('active', b === btn));
      state.tab = btn.dataset.tab;
      state.page = 0;
      renderFilters();
      load();
    };
  });

  container.querySelector('#inv-search').addEventListener('input', debounce((e) => {
    state.search = e.target.value.trim();
    state.page = 0;
    load();
  }, 280));

  container.querySelector('#inv-refresh').onclick = () => { loadStats(); load(); toast('Inventory refreshed.', 'info'); };

  const adjustBtn = container.querySelector('#inv-adjust');
  if (adjustBtn) {
    adjustBtn.onclick = async () => {
      const { items } = await api.get('/products?limit=500&status=active');
      modal({
        title: 'Adjust stock',
        subtitle: 'Pick a product, then record stock in, stock out or a corrected quantity.',
        body: `
          <form id="adj-pick" class="stack" style="gap:14px">
            <div class="field">
              <label for="ap-product">Product</label>
              <select class="select" id="ap-product">
                <option value="">Select a product…</option>
                ${items.map((p) => `<option value="${p.id}">${esc(p.name)} — ${esc(p.sku)} (${num(p.quantity)} in stock)</option>`).join('')}
              </select>
            </div>
            <div class="form-grid">
              <div class="field">
                <label for="ap-type">Movement</label>
                <select class="select" id="ap-type">
                  <option value="in">Stock in (receive)</option>
                  <option value="out">Stock out (issue)</option>
                  <option value="set">Set exact quantity</option>
                </select>
              </div>
              <div class="field">
                <label for="ap-qty">Quantity</label>
                <input class="input" id="ap-qty" type="number" min="0" step="1" value="1" />
              </div>
            </div>
            <div class="field">
              <label for="ap-note">Note</label>
              <input class="input" id="ap-note" maxlength="180" placeholder="e.g. Supplier delivery, cycle count correction" />
            </div>
            <div id="ap-error" class="alert alert-red hidden"></div>
          </form>`,
        footer: `<button class="btn" data-cancel>Cancel</button><button class="btn btn-primary" id="ap-submit">${icon('check')} Save movement</button>`,
        onMount(root, close) {
          root.querySelector('[data-cancel]').onclick = close;
          const errBox = root.querySelector('#ap-error');
          root.querySelector('#ap-submit').onclick = async () => {
            errBox.classList.add('hidden');
            const productId = root.querySelector('#ap-product').value;
            const type = root.querySelector('#ap-type').value;
            const quantity = parseInt(root.querySelector('#ap-qty').value, 10);
            if (!productId) { errBox.textContent = 'Choose a product.'; errBox.classList.remove('hidden'); return; }
            if (!Number.isFinite(quantity) || quantity < 0 || (type !== 'set' && quantity === 0)) {
              errBox.textContent = 'Enter a valid quantity.'; errBox.classList.remove('hidden'); return;
            }
            const btn = root.querySelector('#ap-submit');
            const restore = buttonLoading(btn, 'Saving…');
            try {
              const res = await api.post('/inventory/adjust', {
                product_id: Number(productId), type, quantity,
                note: root.querySelector('#ap-note').value.trim() || undefined
              });
              toast(`Stock updated: ${res.quantity_before} → ${res.quantity_after} for ${res.sku}.`, 'success');
              close();
              loadStats(); load();
            } catch (err) {
              restore();
              errBox.textContent = err.message; errBox.classList.remove('hidden');
            }
          };
        }
      });
    };
  }

  renderFilters();
  await Promise.all([loadStats(), load()]);
}
