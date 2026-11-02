import { api, can } from '../api.js';
import { icon } from '../icons.js';
import {
  money, num, esc, qtyChip, productThumb, emptyState, toast, debounce, buttonLoading, confirmDialog
} from '../ui.js';

const PAYMENTS = [['cash', 'Cash'], ['card', 'Card'], ['upi', 'UPI'], ['bank', 'Bank transfer'], ['credit', 'Credit']];

export default async function renderBilling({ container, navigate, query }) {
  const editId = query?.get('edit');
  let products = [];
  let invoice = null;               // existing invoice when editing
  let lines = [];                   // [{product_id, name, sku, unit_price, quantity, image_url, available}]
  let discountType = 'percent';
  let discountValue = 0;
  let taxRate = 0;
  let customer = { name: '', phone: '', email: '', address: '', notes: '', payment: 'cash' };
  const idempotencyKey = `bill-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  if (!can('invoices.create') && !(editId && can('invoices.edit'))) {
    container.innerHTML = `<div class="card"><div class="card-body"><div class="empty">
      <div class="empty-icon" style="color:var(--red);background:var(--red-bg);border-color:var(--red-line)">${icon('shield')}</div>
      <h4>Billing is not available for your role</h4>
      <p>Your account can view products but cannot create invoices. Contact an administrator if you need billing access.</p>
      <a class="btn btn-primary" href="#/products">Browse products</a></div></div></div>`;
    return;
  }

  container.innerHTML = `<div class="loading-rows"><div class="skeleton" style="height:60px"></div><div class="skeleton" style="height:340px"></div></div>`;

  // load catalogue (+ existing invoice if editing)
  const [productRes, catsRes] = await Promise.all([
    api.get('/products?limit=500&status=active'),
    api.get('/categories').catch(() => ({ items: [] }))
  ]);
  products = productRes.items;

  if (editId) {
    try {
      const res = await api.get(`/invoices/${editId}`);
      invoice = res.invoice;
      if (invoice.status !== 'paid') {
        toast('Only paid invoices can be edited. Opening the invoice instead.', 'error');
        navigate(`invoices/${editId}`);
        return;
      }
      lines = invoice.items.map((it) => {
        const p = products.find((x) => x.id === it.product_id) || {};
        return {
          product_id: it.product_id, name: it.product_name, sku: it.sku,
          unit_price: Number(it.unit_price), quantity: it.quantity,
          image_url: it.image_url, available: (Number(p.quantity) || 0) + it.quantity
        };
      });
      discountType = invoice.discount_type; discountValue = Number(invoice.discount_value);
      taxRate = Number(invoice.tax_rate);
      customer = {
        name: invoice.customer_name || '', phone: invoice.customer_phone || '', email: invoice.customer_email || '',
        address: invoice.customer_address || '', notes: invoice.notes || '', payment: invoice.payment_method || 'cash'
      };
    } catch (err) {
      toast(err.message, 'error');
      navigate('invoices');
      return;
    }
  }

  container.innerHTML = `
    <div class="page-head">
      <div>
        <h1>${editId ? `Edit ${esc(invoice.invoice_no)}` : 'New bill'}</h1>
        <p>${editId ? 'Quantities are re-validated against live stock; the difference is adjusted automatically.' : 'Search products, set quantities and confirm — stock updates instantly.'}</p>
      </div>
      <div class="page-head-actions">
        <a class="btn" href="#/invoices">${icon('invoice')} Billing history</a>
      </div>
    </div>

    <div class="billing">
      <div class="stack">
        <section class="card">
          <div class="card-head">
            <h3>Customer details</h3>
            <span class="badge badge-gray" style="margin-left:auto">Step 1</span>
          </div>
          <div class="card-body">
            <div class="form-grid">
              <div class="field span-2">
                <label for="c-name">Customer name <span class="req">*</span></label>
                <input class="input" id="c-name" placeholder="Walk-in Customer" maxlength="120" value="${esc(customer.name)}" />
              </div>
              <div class="field">
                <label for="c-phone">Phone</label>
                <input class="input" id="c-phone" placeholder="+91 98765 43210" value="${esc(customer.phone)}" />
              </div>
              <div class="field">
                <label for="c-email">Email</label>
                <input class="input" id="c-email" type="email" placeholder="customer@company.com" value="${esc(customer.email)}" />
              </div>
              <div class="field span-2">
                <label for="c-address">Billing address</label>
                <input class="input" id="c-address" placeholder="Street, city, state, PIN" value="${esc(customer.address)}" />
              </div>
            </div>
          </div>
        </section>

        <section class="card">
          <div class="card-head">
            <h3>Add products</h3>
            <span class="badge badge-gray" style="margin-left:auto">Step 2</span>
          </div>
          <div class="toolbar">
            <div class="search-box">
              ${icon('search')}
              <input class="input" id="bp-search" placeholder="Search by name, SKU or category…" />
            </div>
            <select class="select" id="bp-category">
              <option value="">All categories</option>
              ${catsRes.items.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
            </select>
            <span class="small muted" id="bp-count"></span>
          </div>
          <div class="card-body" id="bp-grid"></div>
        </section>

        <section class="card">
          <div class="card-head">
            <h3>Bill items</h3>
            <span class="badge badge-blue" id="bl-count" style="margin-left:auto">0 items</span>
          </div>
          <div class="card-body" id="bl-wrap"></div>
        </section>
      </div>

      <aside class="stack billing-sticky">
        <section class="card">
          <div class="card-head"><h3>Order summary</h3></div>
          <div class="card-body">
            <div class="totals">
              <div class="trow"><span>Subtotal</span><span class="strong" id="t-sub">₹0.00</span></div>
              <div class="trow" style="align-items:center">
                <span>Discount</span>
                <span style="display:flex;gap:6px;align-items:center">
                  <div class="segmented" id="t-disc-type" style="transform:scale(.92);transform-origin:right">
                    <button data-dt="percent" class="${discountType === 'percent' ? 'active' : ''}">%</button>
                    <button data-dt="fixed" class="${discountType === 'fixed' ? 'active' : ''}">₹</button>
                  </div>
                  <input class="input" id="t-disc-value" type="number" min="0" step="0.01" value="${discountValue}" style="width:82px;height:32px;text-align:right" />
                </span>
              </div>
              <div class="trow"><span class="muted">Discount applied</span><span id="t-disc-amt">−₹0.00</span></div>
              <div class="trow" style="align-items:center">
                <span>Tax</span>
                <span style="display:flex;gap:6px;align-items:center">
                  <select class="select" id="t-tax" style="width:104px;height:32px">
                    ${[0, 5, 12, 18, 28].map((r) => `<option value="${r}" ${Number(taxRate) === r ? 'selected' : ''}>${r}% GST</option>`).join('')}
                  </select>
                </span>
              </div>
              <div class="trow"><span class="muted">Tax amount</span><span id="t-tax-amt">₹0.00</span></div>
              <div class="trow grand"><span>Total</span><span id="t-total">₹0.00</span></div>
            </div>

            <div class="field" style="margin-top:16px">
              <label for="t-payment">Payment method</label>
              <select class="select" id="t-payment">
                ${PAYMENTS.map(([v, l]) => `<option value="${v}" ${customer.payment === v ? 'selected' : ''}>${l}</option>`).join('')}
              </select>
            </div>
            <div class="field" style="margin-top:12px">
              <label for="t-notes">Notes</label>
              <textarea class="textarea" id="t-notes" rows="2" placeholder="Delivery instructions, PO reference…">${esc(customer.notes)}</textarea>
            </div>

            <div id="bill-error" class="alert alert-red hidden" style="margin-top:14px"></div>
            <button class="btn btn-primary btn-lg btn-block" id="bill-submit" style="margin-top:14px">
              ${icon(editId ? 'check' : 'invoice')} ${editId ? 'Save changes' : 'Confirm & generate bill'}
            </button>
            ${editId ? `<a class="btn btn-block" href="#/invoices/${editId}" style="margin-top:8px">Cancel editing</a>`
              : `<button class="btn btn-ghost btn-block" id="bill-clear" style="margin-top:8px">Clear bill</button>`}
            <p class="small muted" style="margin-top:12px;text-align:center">Stock is deducted atomically when the bill is confirmed.</p>
          </div>
        </section>

        <section class="card">
          <div class="card-head"><h3>Stock check</h3></div>
          <div class="card-body" id="stock-check">
            <p class="small muted">Add products to see live stock validation.</p>
          </div>
        </section>
      </aside>
    </div>`;

  /* ── product picker ─────────────────────────────────────────────────── */
  const grid = container.querySelector('#bp-grid');
  const renderPicker = () => {
    const search = container.querySelector('#bp-search').value.trim().toLowerCase();
    const catId = container.querySelector('#bp-category').value;
    const filtered = products.filter((p) => {
      const matchesSearch = !search || `${p.name} ${p.sku} ${p.category_name || ''}`.toLowerCase().includes(search);
      const matchesCat = !catId || String(p.category_id) === String(catId);
      return matchesSearch && matchesCat;
    });
    container.querySelector('#bp-count').textContent = `${filtered.length} product${filtered.length === 1 ? '' : 's'}`;
    if (!filtered.length) {
      grid.innerHTML = emptyState({ iconName: 'search', title: 'No matching products', message: 'Try a different search term or category.' });
      return;
    }
    grid.innerHTML = `<div class="billing-catalogue">
      ${filtered.map((p) => {
        const inCart = lines.find((l) => l.product_id === p.id);
        const remaining = Number(p.quantity) - (inCart ? inCart.quantity : 0);
        return `<button class="pick-card" data-pick="${p.id}" ${remaining <= 0 ? 'disabled' : ''}>
          ${productThumb(p)}
          <span style="min-width:0;flex:1">
            <span class="pc-name" style="display:block">${esc(p.name)}</span>
            <span class="pc-meta" style="display:block">${esc(p.sku)} · ${remaining > 0 ? remaining + ' available' : 'out of stock'}</span>
            <span class="pc-price" style="display:block">${money(p.selling_price)}</span>
          </span>
          ${remaining > 0 ? `<span class="badge badge-blue">Add</span>` : ''}
        </button>`;
      }).join('')}
    </div>`;
    grid.querySelectorAll('[data-pick]').forEach((btn) => {
      btn.onclick = () => {
        const product = products.find((p) => String(p.id) === btn.dataset.pick);
        const existing = lines.find((l) => l.product_id === product.id);
        if (existing) {
          if (existing.quantity + 1 > product.quantity) { toast(`Only ${product.quantity} units of ${product.name} in stock.`, 'error'); return; }
          existing.quantity += 1;
        } else {
          lines.push({
            product_id: product.id, name: product.name, sku: product.sku,
            unit_price: Number(product.selling_price), quantity: 1,
            image_url: product.image_url, available: Number(product.quantity)
          });
        }
        renderLines(); renderPicker();
      };
    });
  };

  /* ── bill lines ─────────────────────────────────────────────────────── */
  const linesWrap = container.querySelector('#bl-wrap');
  const renderLines = () => {
    container.querySelector('#bl-count').textContent = `${lines.length} item${lines.length === 1 ? '' : 's'}`;
    if (!lines.length) {
      linesWrap.innerHTML = emptyState({ iconName: 'cart', title: 'No items on this bill', message: 'Pick products from the catalogue above to start billing.' });
      recalc();
      return;
    }
    linesWrap.innerHTML = `<div class="bill-lines">
      ${lines.map((l, i) => `
        <div class="bill-line" data-line="${i}">
          <div style="min-width:0">
            <div class="bl-name">${esc(l.name)}</div>
            <div class="bl-sub">${esc(l.sku)} · ${money(l.unit_price)} each · ${num(l.available)} in stock</div>
          </div>
          <input class="input bl-price" type="number" min="0" step="0.01" value="${l.unit_price}" data-price="${i}" aria-label="Unit price" title="Unit price (editable)" />
          <input class="input" type="number" min="1" step="1" max="${l.available}" value="${l.quantity}" data-qty="${i}" aria-label="Quantity" />
          <button class="btn btn-icon btn-ghost" data-remove="${i}" aria-label="Remove ${esc(l.name)}" title="Remove" style="color:var(--red)">${icon('trash')}</button>
        </div>`).join('')}
    </div>
    <div class="small muted" style="margin-top:10px">Unit price is editable for negotiated pricing. Line totals update automatically.</div>`;

    linesWrap.querySelectorAll('[data-qty]').forEach((input) => {
      input.onchange = () => {
        const i = Number(input.dataset.qty);
        let q = parseInt(input.value, 10);
        if (!Number.isFinite(q) || q < 1) q = 1;
        if (q > lines[i].available) {
          q = lines[i].available;
          toast(`Only ${lines[i].available} units available for ${lines[i].name}.`, 'error');
        }
        lines[i].quantity = q;
        renderLines(); renderPicker();
      };
    });
    linesWrap.querySelectorAll('[data-price]').forEach((input) => {
      input.onchange = () => {
        const i = Number(input.dataset.price);
        const v = Number(input.value);
        if (!Number.isFinite(v) || v < 0) { toast('Price cannot be negative.', 'error'); input.value = lines[i].unit_price; return; }
        lines[i].unit_price = Math.round(v * 100) / 100;
        renderLines();
      };
    });
    linesWrap.querySelectorAll('[data-remove]').forEach((btn) => {
      btn.onclick = () => {
        lines.splice(Number(btn.dataset.remove), 1);
        renderLines(); renderPicker();
      };
    });
    recalc();
  };

  /* ── totals ─────────────────────────────────────────────────────────── */
  const totals = () => {
    const subtotal = lines.reduce((s, l) => s + l.unit_price * l.quantity, 0);
    let discountAmount = 0;
    if (discountType === 'percent') discountAmount = (subtotal * Math.min(100, Math.max(0, discountValue))) / 100;
    else discountAmount = Math.min(subtotal, Math.max(0, discountValue));
    const taxable = subtotal - discountAmount;
    const taxAmount = (taxable * Math.max(0, taxRate)) / 100;
    return {
      subtotal: Math.round(subtotal * 100) / 100,
      discountAmount: Math.round(discountAmount * 100) / 100,
      taxAmount: Math.round(taxAmount * 100) / 100,
      total: Math.round((taxable + taxAmount) * 100) / 100
    };
  };

  const recalc = () => {
    const t = totals();
    container.querySelector('#t-sub').textContent = money(t.subtotal);
    container.querySelector('#t-disc-amt').textContent = `−${money(t.discountAmount)}`;
    container.querySelector('#t-tax-amt').textContent = money(t.taxAmount);
    container.querySelector('#t-total').textContent = money(t.total);

    const check = container.querySelector('#stock-check');
    if (!lines.length) {
      check.innerHTML = `<p class="small muted">Add products to see live stock validation.</p>`;
    } else {
      const issues = lines.filter((l) => l.quantity > l.available);
      check.innerHTML = issues.length
        ? `<div class="alert alert-red">${icon('alert')}<div><div class="alert-title">Not enough stock</div>
            ${issues.map((l) => `<div class="small">${esc(l.name)}: requested ${l.quantity}, available ${l.available}</div>`).join('')}</div></div>`
        : `<div style="display:grid;gap:9px">
            ${lines.map((l) => `<div style="display:flex;justify-content:space-between;gap:10px;align-items:center">
              <span class="small" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(l.name)}</span>
              <span class="small muted">${l.quantity} / ${l.available}</span>
            </div>`).join('')}
          </div>
          <div class="alert alert-green" style="margin-top:12px">${icon('checkCircle')}<div class="small">All quantities available. Stock will be deducted on confirm.</div></div>`;
    }
  };

  /* ── input wiring ───────────────────────────────────────────────────── */
  container.querySelector('#bp-search').addEventListener('input', debounce(renderPicker, 200));
  container.querySelector('#bp-category').onchange = renderPicker;
  container.querySelectorAll('#t-disc-type button').forEach((btn) => {
    btn.onclick = () => {
      discountType = btn.dataset.dt;
      container.querySelectorAll('#t-disc-type button').forEach((b) => b.classList.toggle('active', b === btn));
      recalc();
    };
  });
  container.querySelector('#t-disc-value').addEventListener('input', (e) => {
    discountValue = Math.max(0, Number(e.target.value) || 0);
    recalc();
  });
  container.querySelector('#t-tax').onchange = (e) => { taxRate = Number(e.target.value); recalc(); };

  const clearBtn = container.querySelector('#bill-clear');
  if (clearBtn) {
    clearBtn.onclick = async () => {
      if (!lines.length) return;
      const ok = await confirmDialog({ title: 'Clear this bill?', message: 'All items and customer details will be reset.', confirmLabel: 'Clear bill', danger: true });
      if (!ok) return;
      lines = [];
      customer = { name: '', phone: '', email: '', address: '', notes: '', payment: 'cash' };
      discountValue = 0; taxRate = 0; discountType = 'percent';
      container.querySelector('#c-name').value = '';
      container.querySelector('#c-phone').value = '';
      container.querySelector('#c-email').value = '';
      container.querySelector('#c-address').value = '';
      container.querySelector('#t-notes').value = '';
      container.querySelector('#t-disc-value').value = '0';
      container.querySelectorAll('#t-disc-type button').forEach((b) => b.classList.toggle('active', b.dataset.dt === 'percent'));
      container.querySelector('#t-tax').value = '0';
      renderLines(); renderPicker();
      toast('Bill cleared.', 'info');
    };
  }

  /* ── submit ─────────────────────────────────────────────────────────── */
  container.querySelector('#bill-submit').onclick = async () => {
    const errBox = container.querySelector('#bill-error');
    errBox.classList.add('hidden');
    const fail = (msg) => { errBox.textContent = msg; errBox.classList.remove('hidden'); errBox.scrollIntoView({ behavior: 'smooth', block: 'center' }); };

    const name = container.querySelector('#c-name').value.trim();
    if (!name) return fail('Enter the customer name (use "Walk-in Customer" if unknown).');
    if (!lines.length) return fail('Add at least one product to the bill.');
    const over = lines.filter((l) => l.quantity > l.available);
    if (over.length) return fail(`Not enough stock for ${over.map((l) => l.name).join(', ')}.`);

    const payload = {
      customer_name: name,
      customer_phone: container.querySelector('#c-phone').value.trim(),
      customer_email: container.querySelector('#c-email').value.trim(),
      customer_address: container.querySelector('#c-address').value.trim(),
      notes: container.querySelector('#t-notes').value.trim(),
      discount_type: discountType,
      discount_value: discountValue,
      tax_rate: taxRate,
      payment_method: container.querySelector('#t-payment').value,
      items: lines.map((l) => ({ product_id: l.product_id, quantity: l.quantity, unit_price: l.unit_price })),
      idempotency_key: editId ? undefined : idempotencyKey
    };

    const btn = container.querySelector('#bill-submit');
    const restore = buttonLoading(btn, editId ? 'Saving…' : 'Generating bill…');
    try {
      const res = editId
        ? await api.put(`/invoices/${editId}`, payload)
        : await api.post('/invoices', payload);
      toast(editId ? 'Invoice updated and stock adjusted.' : `Invoice ${res.invoice.invoice_no} created. Stock updated.`, 'success');
      navigate(`invoices/${res.invoice.id}`);
    } catch (err) {
      restore();
      fail(err.message);
      // Refresh live availability after a conflict so quantities can be corrected.
      try {
        const fresh = await api.get('/products?limit=500&status=active');
        products = fresh.items;
        lines.forEach((l) => {
          const p = products.find((x) => x.id === l.product_id);
          if (p) l.available = Number(p.quantity) + (editId ? l.quantity : 0);
        });
        renderLines(); renderPicker();
      } catch { /* ignore */ }
    }
  };

  renderLines();
  renderPicker();
}
