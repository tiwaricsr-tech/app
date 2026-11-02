import { api, can, session } from '../api.js';
import { icon } from '../icons.js';
import {
  money, moneyShort, num, esc, dateShort, timeAgo, qtyChip, statusBadge,
  lineChart, barChart, emptyState, toast
} from '../ui.js';

const statCard = ({ label, value, iconName, accent, bg, meta, chip }) => `
  <article class="stat" style="--stat-accent:${accent};--stat-bg:${bg}">
    <div class="stat-top">
      <span class="stat-icon">${icon(iconName)}</span>
      <span class="stat-label">${esc(label)}</span>
    </div>
    <div class="stat-value">${value}</div>
    <div class="stat-meta">${chip || ''}<span>${meta || ''}</span></div>
  </article>`;

export default async function renderDashboard({ container, navigate }) {
  const user = session.user;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  const data = await api.get('/reports/dashboard');
  const { sales, inventory, trend, low_stock, recent_invoices, top_products, category_split } = data;

  const yesterday = trend.length >= 2 ? trend[trend.length - 2].revenue : 0;
  const todayRev = sales.today_revenue;
  const delta = yesterday > 0 ? ((todayRev - yesterday) / yesterday) * 100 : 0;
  const deltaChip = yesterday === 0 && todayRev === 0
    ? '<span class="stat-chip flat">—</span>'
    : `<span class="stat-chip ${delta >= 0 ? 'up' : 'down'}">${icon(delta >= 0 ? 'trendUp' : 'trendDown', 'width="11" height="11"')} ${Math.abs(delta).toFixed(0)}%</span>`;

  const trendValues = trend.map((t) => t.revenue);
  const maxTrend = Math.max(1, ...trendValues);

  container.innerHTML = `
    <div class="page-head">
      <div>
        <h1>${greeting}, ${esc(user.full_name.split(' ')[0])}</h1>
        <p>Here is what is happening across your inventory and sales today.</p>
      </div>
      <div class="page-head-actions">
        ${can('reports.view') ? `<a class="btn" href="#/reports">${icon('reports')} Reports</a>` : ''}
        ${can('invoices.create') ? `<a class="btn btn-primary" href="#/billing">${icon('cart')} Create bill</a>` : ''}
      </div>
    </div>

    <div class="stack">
      <div class="stats">
        ${statCard({
          label: 'Revenue today', value: money(sales.today_revenue), iconName: 'wallet', accent: '#1d4ed8', bg: 'var(--brand-50)',
          chip: deltaChip, meta: `vs ${moneyShort(yesterday)} yesterday · ${sales.today_bills} bill${sales.today_bills === 1 ? '' : 's'}`
        })}
        ${statCard({
          label: 'This month', value: money(sales.month_revenue), iconName: 'trendUp', accent: '#059669', bg: 'var(--green-bg)',
          meta: `${num(sales.month_bills)} bills · avg ${money(sales.month_bills ? sales.month_revenue / sales.month_bills : 0)}`
        })}
        ${statCard({
          label: 'Inventory value', value: money(inventory.purchase_value), iconName: 'box', accent: '#7c3aed', bg: 'var(--violet-bg)',
          meta: `${num(inventory.units)} units · retail ${moneyShort(inventory.selling_value)}`
        })}
        ${statCard({
          label: 'Low stock items', value: num(inventory.low_stock), iconName: 'alert', accent: inventory.low_stock ? '#b45309' : '#059669',
          bg: inventory.low_stock ? 'var(--amber-bg)' : 'var(--green-bg)',
          meta: inventory.low_stock ? '<a href="#/inventory?low=1">Review reorder list →</a>' : 'All products above reorder level'
        })}
      </div>

      <div class="grid-split grid-split-wide">
        <section class="card">
          <div class="card-head">
            <div>
              <h3>Sales trend</h3>
              <div class="small muted">Paid invoices · last 14 days</div>
            </div>
            <div style="margin-left:auto" class="legend">
              <span><i style="background:#1d4ed8"></i> Revenue</span>
            </div>
          </div>
          <div class="card-body">${lineChart(trend)}</div>
        </section>

        <section class="card">
          <div class="card-head"><h3>Potential profit</h3></div>
          <div class="card-body">
            <div style="font-size:clamp(24px,3vw,32px);font-weight:750;letter-spacing:-.03em">${money(inventory.potential_profit)}</div>
            <p class="muted small" style="margin-top:4px">Retail value of stock minus its purchase cost.</p>
            <div style="margin-top:16px;display:grid;gap:11px">
              <div>
                <div class="small muted" style="display:flex;justify-content:space-between"><span>Cost value</span><span class="strong">${money(inventory.purchase_value)}</span></div>
                <div class="progress" style="margin-top:5px"><i style="width:${Math.min(100, (inventory.purchase_value / Math.max(1, inventory.selling_value)) * 100)}%"></i></div>
              </div>
              <div>
                <div class="small muted" style="display:flex;justify-content:space-between"><span>Retail value</span><span class="strong">${money(inventory.selling_value)}</span></div>
                <div class="progress ok" style="margin-top:5px"><i style="width:100%"></i></div>
              </div>
            </div>
            <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--line-2);display:grid;gap:8px" class="small">
              <div style="display:flex;justify-content:space-between"><span class="muted">Active products</span><span class="strong">${num(inventory.products)}</span></div>
              <div style="display:flex;justify-content:space-between"><span class="muted">Bills all-time</span><span class="strong">${num(sales.total_bills)}</span></div>
              <div style="display:flex;justify-content:space-between"><span class="muted">Cancelled / refunded</span><span class="strong">${num(sales.cancelled)} / ${num(sales.refunded)}</span></div>
            </div>
          </div>
        </section>
      </div>

      <div class="grid-split">
        <section class="card">
          <div class="card-head">
            <h3>Recent invoices</h3>
            ${can('invoices.view') ? `<a class="btn btn-sm btn-ghost" href="#/invoices" style="margin-left:auto">View all ${icon('arrowRight')}</a>` : ''}
          </div>
          ${recent_invoices.length ? `<div class="table-wrap">
            <table class="data">
              <thead><tr><th>Invoice</th><th>Customer</th><th class="num">Total</th><th>Status</th></tr></thead>
              <tbody>
                ${recent_invoices.map((inv) => `
                  <tr class="clickable" data-inv="${inv.id}" style="cursor:pointer">
                    <td><div class="strong mono">${esc(inv.invoice_no)}</div><div class="small muted">${timeAgo(inv.created_at)} · ${esc(inv.created_by_name || '—')}</div></td>
                    <td>${esc(inv.customer_name)}</td>
                    <td class="num strong">${money(inv.total)}</td>
                    <td>${statusBadge(inv.status)}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>` : emptyState({ iconName: 'invoice', title: 'No invoices yet', message: 'Create your first bill to see it here.' })}
        </section>

        <section class="card">
          <div class="card-head">
            <h3>Low stock alerts</h3>
            ${inventory.low_stock ? `<a class="btn btn-sm btn-ghost" href="#/inventory?low=1" style="margin-left:auto">Manage ${icon('arrowRight')}</a>` : ''}
          </div>
          <div class="card-body">
            ${low_stock.length ? `<div style="display:grid;gap:11px">
              ${low_stock.map((p) => `
                <div style="display:flex;align-items:center;gap:10px">
                  <div style="min-width:0;flex:1">
                    <div class="strong small" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(p.name)}</div>
                    <div class="small muted mono">${esc(p.sku)}</div>
                  </div>
                  ${qtyChip(p.quantity, p.low_stock_threshold)}
                  <div style="width:70px">
                    <div class="progress ${p.quantity === 0 ? 'out' : 'low'}"><i style="width:${Math.min(100, (Number(p.quantity) / Math.max(1, Number(p.low_stock_threshold))) * 100)}%"></i></div>
                    <div class="small muted" style="text-align:right;margin-top:2px">min ${num(p.low_stock_threshold)}</div>
                  </div>
                </div>`).join('')}
            </div>` : `<div class="alert alert-green" style="margin:0">${icon('checkCircle')}<div>All products are above their reorder levels.</div></div>`}
          </div>
        </section>
      </div>

      <div class="grid-split">
        <section class="card">
          <div class="card-head"><h3>Top products this month</h3></div>
          <div class="card-body">
            ${top_products.length ? `<div class="table-wrap"><table class="data">
              <thead><tr><th>Product</th><th class="num">Units</th><th class="num">Revenue</th></tr></thead>
              <tbody>${top_products.map((p) => `
                <tr>
                  <td><div class="strong small">${esc(p.product_name)}</div><div class="small muted mono">${esc(p.sku)}</div></td>
                  <td class="num">${num(p.units_sold)}</td>
                  <td class="num strong">${money(p.revenue)}</td>
                </tr>`).join('')}</tbody>
            </table></div>` : emptyState({ iconName: 'trendUp', title: 'No sales this month', message: 'Top sellers appear after your first bill.' })}
          </div>
        </section>

        <section class="card">
          <div class="card-head"><h3>Stock value by category</h3></div>
          <div class="card-body">
            ${category_split.length ? barChart(category_split.map((c) => ({ label: c.category, value: c.value })), { valueKey: 'value', labelKey: 'label' }) : emptyState({ iconName: 'layers', title: 'No categories yet' })}
          </div>
        </section>
      </div>

      <div class="small muted" style="display:flex;gap:14px;flex-wrap:wrap;align-items:center">
        <span>${icon('clock', 'width="13" height="13" style="vertical-align:-2px"')} Last refreshed ${new Date().toLocaleTimeString('en-IN')}</span>
        <button class="btn btn-sm btn-ghost" id="refresh-dash">${icon('refresh')} Refresh</button>
        <span style="margin-left:auto">Revenue figures exclude cancelled &amp; refunded bills.</span>
      </div>
    </div>`;

  container.querySelectorAll('[data-inv]').forEach((row) => {
    row.onclick = () => navigate(`invoices/${row.dataset.inv}`);
  });
  const refreshBtn = container.querySelector('#refresh-dash');
  if (refreshBtn) refreshBtn.onclick = () => { toast('Refreshing dashboard…', 'info'); renderDashboard({ container, navigate }); };
}
