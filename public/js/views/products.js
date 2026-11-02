import { api, can } from '../api.js';
import { icon } from '../icons.js';
import {
  money, num, esc, dateShort, qtyChip, statusBadge, productThumb, emptyState, skeletonRows,
  toast, modal, confirmDialog, debounce, buttonLoading, productThumb as thumb, readFileAsDataUrl
} from '../ui.js';

let cache = { categories: [], lowThresholdDefault: 10 };

const stockChip = (p) => qtyChip(p.quantity, p.low_stock_threshold);

/* ── product form modal ──────────────────────────────────────────────────── */
export function openProductForm({ product, onSaved }) {
  const isEdit = Boolean(product);
  const p = product || {
    name: '', sku: '', category_id: '', description: '', purchase_price: '', selling_price: '',
    low_stock_threshold: 10, status: 'active', image_url: null, quantity: 0
  };
  let imageData = null;
  let removeImage = false;

  modal({
    title: isEdit ? 'Edit product' : 'Add product',
    subtitle: isEdit ? `${p.name} · ${p.sku}` : 'Create a catalogue item and set its opening stock.',
    size: 'modal-wide',
    body: `
      <form id="product-form" class="stack" style="gap:16px" novalidate>
        <div class="form-grid">
          <div class="field span-2">
            <label for="pf-name">Product name <span class="req">*</span></label>
            <input class="input" id="pf-name" name="name" maxlength="160" placeholder="e.g. ProBook 14&quot; Laptop" required value="${esc(p.name)}" />
          </div>
          <div class="field">
            <label for="pf-sku">SKU <span class="req">*</span></label>
            <input class="input mono" id="pf-sku" name="sku" maxlength="40" placeholder="ELEC-1001" required value="${esc(p.sku)}" style="text-transform:uppercase" />
            <span class="hint">2–40 characters, letters/numbers/-/./_</span>
          </div>
          <div class="field">
            <label for="pf-category">Category</label>
            <select class="select" id="pf-category" name="category_id">
              <option value="">Uncategorised</option>
              ${cache.categories.map((c) => `<option value="${c.id}" ${String(p.category_id) === String(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label for="pf-purchase">Purchase price <span class="req">*</span></label>
            <input class="input" id="pf-purchase" name="purchase_price" type="number" min="0" step="0.01" required value="${p.purchase_price === null ? '' : p.purchase_price}" />
          </div>
          <div class="field">
            <label for="pf-selling">Selling price <span class="req">*</span></label>
            <input class="input" id="pf-selling" name="selling_price" type="number" min="0" step="0.01" required value="${p.selling_price === null ? '' : p.selling_price}" />
          </div>
          <div class="field">
            <label for="pf-threshold">Low stock threshold</label>
            <input class="input" id="pf-threshold" name="low_stock_threshold" type="number" min="0" step="1" value="${p.low_stock_threshold}" />
            <span class="hint">Alert when stock hits this level</span>
          </div>
          <div class="field">
            <label for="pf-status">Status</label>
            <select class="select" id="pf-status" name="status">
              <option value="active" ${p.status !== 'archived' ? 'selected' : ''}>Active — sellable</option>
              <option value="archived" ${p.status === 'archived' ? 'selected' : ''}>Archived — hidden from billing</option>
            </select>
          </div>
          ${isEdit ? '' : `<div class="field">
            <label for="pf-opening">Opening stock</label>
            <input class="input" id="pf-opening" name="opening_stock" type="number" min="0" step="1" value="0" />
            <span class="hint">Recorded as an "Opening stock" movement</span>
          </div>`}
          <div class="field span-2">
            <label for="pf-description">Description</label>
            <textarea class="textarea" id="pf-description" name="description" rows="2" placeholder="Optional notes about this product">${esc(p.description || '')}</textarea>
          </div>
        </div>

        <div class="field">
          <label>Product image</label>
          <div style="display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap">
            <div id="pf-image-preview">${p.image_url ? `<img class="thumb thumb-lg" src="${esc(p.image_url)}" alt="" />` : `<div class="thumb thumb-lg thumb-ph">${esc((p.name || '?')[0])}</div>`}</div>
            <div style="display:grid;gap:7px">
              <input type="file" id="pf-image" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" class="hidden" />
              <button type="button" class="btn btn-sm" id="pf-image-btn">${icon('upload')} ${p.image_url ? 'Replace image' : 'Upload image'}</button>
              ${p.image_url ? `<button type="button" class="btn btn-sm btn-soft-red" id="pf-image-remove">${icon('trash')} Remove</button>` : ''}
              <span class="hint">PNG/JPG/WEBP · max 1.6 MB</span>
            </div>
          </div>
        </div>

        <div id="pf-error" class="alert alert-red hidden"></div>
      </form>`,
    footer: `
      <button class="btn" data-cancel>Cancel</button>
      <button class="btn btn-primary" id="pf-submit">${icon('check')} ${isEdit ? 'Save changes' : 'Create product'}</button>`,
    onMount(root, close) {
      root.querySelector('[data-cancel]').onclick = close;
      const fileInput = root.querySelector('#pf-image');
      const preview = root.querySelector('#pf-image-preview');
      root.querySelector('#pf-image-btn').onclick = () => fileInput.click();
      fileInput.onchange = async () => {
        const file = fileInput.files[0];
        if (!file) return;
        try {
          imageData = await readFileAsDataUrl(file);
          removeImage = false;
          preview.innerHTML = `<img class="thumb thumb-lg" src="${imageData}" alt="" />`;
        } catch (err) { toast(err.message, 'error'); }
      };
      const removeBtn = root.querySelector('#pf-image-remove');
      if (removeBtn) removeBtn.onclick = () => {
        imageData = null; removeImage = true;
        preview.innerHTML = `<div class="thumb thumb-lg thumb-ph">?</div>`;
        toast('Image will be removed when you save.', 'info');
      };

      const errBox = root.querySelector('#pf-error');
      const submitBtn = root.querySelector('#pf-submit');
      const fail = (msg) => { errBox.textContent = msg; errBox.classList.remove('hidden'); errBox.scrollIntoView({ block: 'nearest' }); };

      const submit = async () => {
        errBox.classList.add('hidden');
        const fd = new FormData(root.querySelector('#product-form'));
        const payload = {
          name: String(fd.get('name') || '').trim(),
          sku: String(fd.get('sku') || '').trim().toUpperCase(),
          category_id: fd.get('category_id') ? Number(fd.get('category_id')) : null,
          description: String(fd.get('description') || '').trim(),
          purchase_price: Number(fd.get('purchase_price')),
          selling_price: Number(fd.get('selling_price')),
          low_stock_threshold: Number(fd.get('low_stock_threshold') || 0),
          status: fd.get('status') || 'active'
        };
        if (payload.name.length < 2) return fail('Enter a product name (at least 2 characters).');
        if (!/^[A-Z0-9][A-Z0-9\-_.]{1,39}$/.test(payload.sku)) return fail('Enter a valid SKU: 2–40 characters using letters, numbers, dash, underscore or dot.');
        if (!Number.isFinite(payload.purchase_price) || payload.purchase_price < 0) return fail('Enter a valid purchase price.');
        if (!Number.isFinite(payload.selling_price) || payload.selling_price < 0) return fail('Enter a valid selling price.');
        if (payload.low_stock_threshold < 0) return fail('Low stock threshold cannot be negative.');

        if (!isEdit) payload.opening_stock = Math.max(0, Number(fd.get('opening_stock') || 0));
        if (imageData) payload.image_url = imageData;
        else if (removeImage) payload.image_url = '';

        const restore = buttonLoading(submitBtn, isEdit ? 'Saving…' : 'Creating…');
        try {
          const res = isEdit
            ? await api.patch(`/products/${p.id}`, payload)
            : await api.post('/products', payload);
          toast(isEdit ? 'Product updated.' : 'Product created.', 'success');
          close();
          if (onSaved) onSaved(res.product);
        } catch (err) {
          restore();
          fail(err.message);
        }
      };
      submitBtn.onclick = submit;
      root.querySelector('#product-form').onsubmit = (e) => { e.preventDefault(); submit(); };
    }
  });
}

/* ── stock adjust modal ─────────────────────────────────────────────────── */
export function openStockAdjust({ product, mode = 'in', onDone }) {
  const isIn = mode !== 'out';
  modal({
    title: isIn ? 'Increase stock' : 'Decrease stock',
    subtitle: `${product.name} · currently ${num(product.quantity)} units`,
    body: `
      <form id="adj-form" class="stack" style="gap:14px">
        <div class="alert ${isIn ? 'alert-green' : 'alert-amber'}">
          ${icon(isIn ? 'plus' : 'minus')}
          <div><div class="alert-title">${isIn ? 'Stock received' : 'Stock issued'}</div>
          <div class="small">${isIn ? 'Adds units and records a stock-in movement.' : 'Removes units. Stock can never go below zero.'}</div></div>
        </div>
        <div class="field">
          <label for="adj-qty">Quantity <span class="req">*</span></label>
          <input class="input" id="adj-qty" type="number" min="1" step="1" value="1" required />
          <span class="hint">Available now: <strong>${num(product.quantity)}</strong> units</span>
        </div>
        <div class="field">
          <label for="adj-note">Note</label>
          <input class="input" id="adj-note" maxlength="180" placeholder="${isIn ? 'e.g. Purchase order PO-2291 received' : 'e.g. Damaged units written off'}" />
        </div>
        <div id="adj-error" class="alert alert-red hidden"></div>
      </form>`,
    footer: `<button class="btn" data-cancel>Cancel</button>
             <button class="btn ${isIn ? 'btn-primary' : 'btn-danger'}" id="adj-submit">${icon(isIn ? 'plus' : 'minus')} ${isIn ? 'Add to stock' : 'Remove from stock'}</button>`,
    onMount(root, close) {
      root.querySelector('[data-cancel]').onclick = close;
      const qtyInput = root.querySelector('#adj-qty');
      const errBox = root.querySelector('#adj-error');
      const btn = root.querySelector('#adj-submit');
      const submit = async () => {
        errBox.classList.add('hidden');
        const quantity = parseInt(qtyInput.value, 10);
        if (!Number.isFinite(quantity) || quantity <= 0) { errBox.textContent = 'Enter a quantity greater than zero.'; errBox.classList.remove('hidden'); return; }
        if (!isIn && quantity > Number(product.quantity)) {
          errBox.textContent = `Only ${product.quantity} unit(s) available. Stock cannot go negative.`;
          errBox.classList.remove('hidden'); return;
        }
        const restore = buttonLoading(btn, 'Updating…');
        try {
          const res = await api.post('/inventory/adjust', {
            product_id: product.id, type: mode, quantity,
            note: root.querySelector('#adj-note').value.trim() || undefined
          });
          toast(`${isIn ? 'Added' : 'Removed'} ${quantity} unit(s). New stock: ${num(res.quantity_after)}.`, 'success');
          close();
          if (onDone) onDone(res);
        } catch (err) {
          restore();
          errBox.textContent = err.message;
          errBox.classList.remove('hidden');
        }
      };
      btn.onclick = submit;
      root.querySelector('#adj-form').onsubmit = (e) => { e.preventDefault(); submit(); };
      setTimeout(() => { qtyInput.focus(); qtyInput.select(); }, 80);
    }
  });
}

/* ── product detail drawer ──────────────────────────────────────────────── */
async function openProductDetail(productId, { onChanged }) {
  const { product, movements } = await api.get(`/products/${productId}`);
  const m = modal({
    title: product.name,
    subtitle: `${product.sku} · ${product.category_name || 'Uncategorised'}`,
    size: 'modal-wide',
    body: `
      <div class="stack" style="gap:18px">
        <div style="display:flex;gap:16px;flex-wrap:wrap">
          ${product.image_url ? `<img class="thumb thumb-lg" style="width:86px;height:86px" src="${esc(product.image_url)}" alt="" />` : `<div class="thumb thumb-lg thumb-ph" style="width:86px;height:86px;font-size:22px">${esc(product.name[0])}</div>`}
          <div style="flex:1;min-width:200px;display:grid;gap:7px">
            <div style="display:flex;gap:7px;flex-wrap:wrap">${statusBadge(product.status)} ${stockChip(product)}</div>
            <div class="small muted">${esc(product.description || 'No description provided.')}</div>
            <div class="small"><span class="muted">Reorder level:</span> <span class="strong">${num(product.low_stock_threshold)} units</span></div>
          </div>
        </div>
        <div class="summary-grid">
          <div class="summary-cell"><div class="k">In stock</div><div class="v">${num(product.quantity)}</div></div>
          <div class="summary-cell"><div class="k">Purchase price</div><div class="v">${money(product.purchase_price)}</div></div>
          <div class="summary-cell"><div class="k">Selling price</div><div class="v">${money(product.selling_price)}</div></div>
          <div class="summary-cell"><div class="k">Stock value (cost)</div><div class="v">${money(product.stock_value_purchase)}</div></div>
        </div>
        ${can('stock.adjust') ? `<div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-soft-green" data-adj="in">${icon('plus')} Increase stock</button>
          <button class="btn btn-soft-red" data-adj="out">${icon('minus')} Decrease stock</button>
          ${can('products.update') ? `<button class="btn" data-edit style="margin-left:auto">${icon('edit')} Edit product</button>` : ''}
        </div>` : ''}
        <div>
          <div class="section-head"><span class="section-title">Recent stock movements</span><span class="badge badge-gray">${movements.length}</span></div>
          ${movements.length ? `<div class="timeline">${movements.map((mv) => `
            <div class="tl-item">
              <span class="tl-dot ${mv.type === 'in' ? 'in' : mv.type === 'out' ? 'out' : ['sale_cancel', 'sale_refund'].includes(mv.type) ? 'cancel' : 'sale'}">${icon(mv.type === 'in' ? 'plus' : mv.type === 'out' ? 'minus' : 'cart')}</span>
              <div>
                <div class="tl-title">${esc(mv.note || mv.type)} ${statusBadge(mv.type)}</div>
                <div class="tl-sub">${esc(mv.user_name || 'System')} · ${new Date(mv.created_at).toLocaleString('en-IN')} · ${num(mv.quantity_before)} → ${num(mv.quantity_after)} <span class="tl-qty ${mv.quantity_change > 0 ? 'pos' : 'neg'}">(${mv.quantity_change > 0 ? '+' : ''}${num(mv.quantity_change)})</span></div>
              </div>
            </div>`).join('')}</div>` : emptyState({ iconName: 'activity', title: 'No movements yet', message: 'Stock changes will be listed here.' })}
        </div>
      </div>`,
    footer: `<button class="btn" data-close>Close</button>`,
    onMount(root, close) {
      const refresh = () => { close(); if (onChanged) onChanged(); };
      root.querySelectorAll('[data-adj]').forEach((btn) => {
        btn.onclick = () => openStockAdjust({ product, mode: btn.dataset.adj, onDone: refresh });
      });
      const editBtn = root.querySelector('[data-edit]');
      if (editBtn) editBtn.onclick = () => {
        close();
        openProductForm({ product, onSaved: () => onChanged && onChanged() });
      };
    }
  });
  return m;
}

/* ── main view ──────────────────────────────────────────────────────────── */
export default async function renderProducts({ container, navigate, query }) {
  const state = {
    search: query?.get('q') || '',
    category_id: query?.get('category') || '',
    low: query?.get('low') === '1',
    sort: 'name',
    dir: 'asc',
    page: 0,
    pageSize: 25
  };

  container.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Products</h1>
        <p>Your catalogue with pricing, stock on hand and reorder levels.</p>
      </div>
      <div class="page-head-actions">
        <button class="btn" id="refresh-products">${icon('refresh')} Refresh</button>
        ${can('products.create') ? `<button class="btn btn-primary" id="add-product">${icon('plus')} Add product</button>` : ''}
      </div>
    </div>
    <section class="card">
      <div class="toolbar">
        <div class="search-box">
          ${icon('search')}
          <input class="input" id="p-search" placeholder="Search by name, SKU or category…  (press /)" value="${esc(state.search)}" />
        </div>
        <select class="select" id="p-category"><option value="">All categories</option></select>
        <label class="checkbox" style="white-space:nowrap"><input type="checkbox" id="p-low" ${state.low ? 'checked' : ''} /> Low stock only</label>
        <div class="toolbar-spacer"></div>
        <span class="small muted" id="p-count">—</span>
      </div>
      <div id="p-table">${skeletonRows(7)}</div>
    </section>`;

  const tableWrap = container.querySelector('#p-table');

  const load = async () => {
    const params = new URLSearchParams();
    if (state.search) params.set('q', state.search);
    if (state.category_id) params.set('category', state.category_id);
    if (state.low) params.set('low', '1');
    try {
      const [cats, products] = await Promise.all([
        api.get('/categories'),
        api.get(`/products?search=${encodeURIComponent(state.search)}&category_id=${encodeURIComponent(state.category_id)}&low=${state.low}&sort=${state.sort}&dir=${state.dir}&limit=${state.pageSize}&offset=${state.page * state.pageSize}`)
      ]);
      cache.categories = cats.items;
      const catSelect = container.querySelector('#p-category');
      const current = state.category_id;
      catSelect.innerHTML = `<option value="">All categories</option>${cats.items.map((c) =>
        `<option value="${c.id}" ${String(current) === String(c.id) ? 'selected' : ''}>${esc(c.name)} (${c.product_count})</option>`).join('')}`;

      const from = products.total ? state.page * state.pageSize + 1 : 0;
      const to = Math.min(products.total, (state.page + 1) * state.pageSize);
      container.querySelector('#p-count').textContent = products.total
        ? `${from}–${to} of ${products.total} product${products.total === 1 ? '' : 's'}`
        : 'No products';
      renderTable(products.items, products.total);
    } catch (err) {
      tableWrap.innerHTML = `<div class="card-body"><div class="alert alert-red">${icon('alert')}<div>${esc(err.message)}</div></div></div>`;
    }
  };

  const renderTable = (items, total = 0) => {
    if (!items.length) {
      tableWrap.innerHTML = emptyState({
        iconName: 'products',
        title: state.search || state.low ? 'No products match these filters' : 'No products yet',
        message: state.search || state.low ? 'Try a different search or clear the filters.' : 'Add your first product to start tracking stock.',
        action: can('products.create') ? `<button class="btn btn-primary" id="empty-add">${icon('plus')} Add product</button>` : ''
      });
      const emptyAdd = tableWrap.querySelector('#empty-add');
      if (emptyAdd) emptyAdd.onclick = () => openProductForm({ onSaved: load });
      return;
    }

    tableWrap.innerHTML = `
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th class="sortable" data-sort="name">Product ${sortInd('name', state)}</th>
              <th>SKU</th>
              <th>Category</th>
              <th class="num sortable" data-sort="purchase_price">Purchase ${sortInd('purchase_price', state)}</th>
              <th class="num sortable" data-sort="selling_price">Selling ${sortInd('selling_price', state)}</th>
              <th class="num sortable" data-sort="quantity">Stock ${sortInd('quantity', state)}</th>
              <th>Status</th>
              <th class="num">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${items.map((p) => `
              <tr data-id="${p.id}">
                <td>
                  <div class="cell-product">
                    ${productThumb(p)}
                    <div style="min-width:0">
                      <div class="name">${esc(p.name)}</div>
                      <div class="sub">Updated ${dateShort(p.updated_at)}</div>
                    </div>
                  </div>
                </td>
                <td><span class="mono small">${esc(p.sku)}</span></td>
                <td class="small">${esc(p.category_name || '—')}</td>
                <td class="num">${money(p.purchase_price)}</td>
                <td class="num strong">${money(p.selling_price)}</td>
                <td class="num">
                  <div style="display:flex;align-items:center;gap:8px;justify-content:flex-end">
                    ${can('stock.adjust') ? `<div class="stepper">
                      <button data-dec="${p.id}" title="Decrease stock" aria-label="Decrease stock">−</button>
                      <span class="val">${num(p.quantity)}</span>
                      <button data-inc="${p.id}" title="Increase stock" aria-label="Increase stock">+</button>
                    </div>` : stockChip(p)}
                  </div>
                  ${p.is_low_stock ? `<div class="small" style="color:var(--amber);margin-top:3px;text-align:right">Reorder at ${num(p.low_stock_threshold)}</div>` : ''}
                </td>
                <td>${statusBadge(p.status)}${p.is_low_stock && p.status === 'active' ? ' <span class="badge badge-amber">Low</span>' : ''}</td>
                <td>
                  <div class="row-actions">
                    <button class="btn btn-sm btn-ghost btn-icon" data-view="${p.id}" title="View details">${icon('eye')}</button>
                    ${can('products.update') ? `<button class="btn btn-sm btn-ghost btn-icon" data-edit="${p.id}" title="Edit">${icon('edit')}</button>` : ''}
                    ${can('products.delete') ? `<button class="btn btn-sm btn-ghost btn-icon" data-del="${p.id}" title="Delete / archive" style="color:var(--red)">${icon('trash')}</button>` : ''}
                  </div>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      ${total > state.pageSize ? `
      <div class="pager">
        <button class="btn btn-sm" id="p-prev" ${state.page === 0 ? 'disabled' : ''}>${icon('arrowLeft')} Previous</button>
        <span class="small muted">Page ${state.page + 1} of ${Math.max(1, Math.ceil(total / state.pageSize))}</span>
        <button class="btn btn-sm" id="p-next" ${(state.page + 1) * state.pageSize >= total ? 'disabled' : ''}>Next ${icon('arrowRight')}</button>
      </div>` : ''}`;

    const find = (id) => items.find((x) => String(x.id) === String(id));

    const prevBtn = tableWrap.querySelector('#p-prev');
    const nextBtn = tableWrap.querySelector('#p-next');
    if (prevBtn) prevBtn.onclick = () => { state.page = Math.max(0, state.page - 1); load(); };
    if (nextBtn) nextBtn.onclick = () => { state.page += 1; load(); };
    tableWrap.querySelectorAll('[data-inc]').forEach((b) => {
      b.onclick = () => openStockAdjust({ product: find(b.dataset.inc), mode: 'in', onDone: load });
    });
    tableWrap.querySelectorAll('[data-dec]').forEach((b) => {
      b.onclick = () => openStockAdjust({ product: find(b.dataset.dec), mode: 'out', onDone: load });
    });
    tableWrap.querySelectorAll('[data-view]').forEach((b) => {
      b.onclick = () => openProductDetail(b.dataset.view, { onChanged: load });
    });
    tableWrap.querySelectorAll('[data-edit]').forEach((b) => {
      b.onclick = () => openProductForm({ product: find(b.dataset.edit), onSaved: load });
    });
    tableWrap.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async () => {
        const product = find(b.dataset.del);
        const confirmed = await confirmDialog({
          title: `Delete ${product.name}?`,
          message: 'Products with sales or stock history are archived instead of deleted, so your invoices and movement ledger stay intact.',
          confirmLabel: 'Delete product',
          danger: true
        });
        if (!confirmed) return;
        try {
          const res = await api.del(`/products/${product.id}`);
          toast(res.message || 'Product deleted.', res.archived ? 'info' : 'success');
          load();
        } catch (err) { toast(err.message, 'error'); }
      };
    });
    tableWrap.querySelectorAll('[data-sort]').forEach((th) => {
      th.onclick = () => {
        const key = th.dataset.sort;
        if (state.sort === key) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
        else { state.sort = key; state.dir = key === 'name' ? 'asc' : 'desc'; }
        state.page = 0;
        load();
      };
    });
  };

  const sortInd = (key, s) => (s.sort === key ? `<span class="sort-ind">${s.dir === 'asc' ? '▲' : '▼'}</span>` : '');

  /* filters */
  container.querySelector('#p-search').addEventListener('input', debounce((e) => {
    state.search = e.target.value.trim();
    state.page = 0;
    load();
  }, 260));
  container.querySelector('#p-category').onchange = (e) => { state.category_id = e.target.value; state.page = 0; load(); };
  container.querySelector('#p-low').onchange = (e) => { state.low = e.target.checked; state.page = 0; load(); };
  container.querySelector('#refresh-products').onclick = () => { load(); toast('Catalogue refreshed.', 'info'); };
  const addBtn = container.querySelector('#add-product');
  if (addBtn) addBtn.onclick = () => openProductForm({ onSaved: load });

  if (query?.get('low') === '1') {
    container.querySelector('#p-low').checked = true;
    state.low = true;
  }

  await load();
}
