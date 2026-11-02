const { chromium } = require('/home/user/stockflow/node_modules/playwright-core');
const fs = require('fs');
const BASE = 'http://127.0.0.1:4173';
const exe = (() => {
  const base = process.env.HOME + '/.cache/ms-playwright';
  const candidates = [];
  try {
    for (const dir of fs.readdirSync(base)) {
      if (dir.startsWith('chromium-')) candidates.push(`${base}/${dir}/chrome-linux64/chrome`, `${base}/${dir}/chrome-linux/chrome`);
      if (dir.startsWith('chromium_headless_shell')) candidates.push(`${base}/${dir}/chrome-linux/headless_shell`);
    }
  } catch (_) { /* ignore */ }
  return candidates.find((f) => fs.existsSync(f)) || 'chrome';
})();
const SHOTS = require('path').join(__dirname, '..', 'screenshots');
// Unique per run so the suite is repeatable against a non-empty database.
const RUN = Date.now().toString().slice(-5);
const WIDGET_NAME = `E2E Test Widget ${RUN}`;
const WIDGET_SKU = `E2E-${RUN}`;
const STAFF_EMAIL = `e2e.staffer.${RUN}@stockflow.app`;
const CATEGORY_NAME = `E2E Category ${RUN}`;
fs.mkdirSync(SHOTS, { recursive: true });

const log = (...a) => console.log(...a);
const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
}

(async () => {
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  const shot = async (name) => { await page.waitForTimeout(350); await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false }); };
  const goto = async (hash) => { await page.goto(`${BASE}/#/${hash}`, { waitUntil: 'networkidle' }); await page.waitForTimeout(400); };

  // ── login as admin ────────────────────────────────────────────────────
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await shot('01-login');
  await page.fill('#email', 'admin@stockflow.app');
  await page.fill('#password', 'Admin@1234');
  await page.click('#login-btn');
  await page.waitForSelector('.stat-value', { timeout: 15000 });
  await page.waitForTimeout(900);
  check('Admin login → dashboard', await page.locator('h1').first().textContent().then(t => t.includes('Good')));
  check('Dashboard KPI cards render', (await page.locator('.stat').count()) >= 4, `${await page.locator('.stat').count()} cards`);
  check('Sidebar nav visible', (await page.locator('.nav-item').count()) >= 8);
  await shot('02-dashboard-admin');

  // ── products ──────────────────────────────────────────────────────────
  await goto('products');
  await page.waitForSelector('table.data tbody tr', { timeout: 15000 });
  const rowCount = await page.locator('table.data tbody tr').count();
  check('Product list loads', rowCount > 10, `${rowCount} rows`);
  await shot('03-products');

  // search
  await page.fill('#p-search', 'Paper');
  await page.waitForTimeout(700);
  check('Product search filters', (await page.locator('table.data tbody tr').count()) < rowCount);
  await page.fill('#p-search', '');
  await page.waitForTimeout(600);

  // create product
  await page.click('#add-product');
  await page.waitForSelector('#product-form');
  await page.fill('#pf-name', WIDGET_NAME);
  await page.fill('#pf-sku', WIDGET_SKU);
  await page.selectOption('#pf-category', { index: 1 });
  await page.fill('#pf-purchase', '100');
  await page.fill('#pf-selling', '150');
  await page.fill('#pf-threshold', '5');
  await page.fill('#pf-opening', '20');
  await shot('04-product-form');
  await page.click('#pf-submit');
  await page.waitForTimeout(1200);
  const createdRow = page.locator('table.data tbody tr', { hasText: WIDGET_NAME });
  check('Create product', await createdRow.count() > 0);

  // stock increase via stepper
  const beforeQty = await createdRow.locator('.stepper .val').textContent();
  await createdRow.locator('[data-inc]').click();
  await page.waitForSelector('#adj-form');
  await page.fill('#adj-qty', '5');
  await page.fill('#adj-note', 'E2E restock');
  await page.click('#adj-submit');
  await page.waitForTimeout(1200);
  const afterQty = await page.locator('table.data tbody tr', { hasText: WIDGET_NAME }).locator('.stepper .val').textContent();
  check('Stock increase', Number(afterQty) === Number(beforeQty) + 5, `${beforeQty} → ${afterQty}`);

  // stock decrease
  await page.locator('table.data tbody tr', { hasText: WIDGET_NAME }).locator('[data-dec]').click();
  await page.waitForSelector('#adj-form');
  await page.fill('#adj-qty', '3');
  await page.click('#adj-submit');
  await page.waitForTimeout(1200);
  const afterDec = await page.locator('table.data tbody tr', { hasText: WIDGET_NAME }).locator('.stepper .val').textContent();
  check('Stock decrease', Number(afterDec) === Number(afterQty) - 3, `${afterQty} → ${afterDec}`);

  // prevent negative stock from UI
  await page.locator('table.data tbody tr', { hasText: WIDGET_NAME }).locator('[data-dec]').click();
  await page.waitForSelector('#adj-form');
  await page.fill('#adj-qty', '99999');
  await page.click('#adj-submit');
  await page.waitForTimeout(700);
  const negErr = await page.locator('#adj-error').textContent();
  check('Negative stock blocked in UI', /stock cannot go negative|only/i.test(negErr), negErr.trim().slice(0, 60));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // edit product
  await page.locator('table.data tbody tr', { hasText: WIDGET_NAME }).locator('[data-edit]').click();
  await page.waitForSelector('#product-form');
  await page.fill('#pf-selling', '175');
  await page.click('#pf-submit');
  await page.waitForTimeout(1000);
  check('Edit product price', (await page.locator('table.data tbody tr', { hasText: WIDGET_NAME }).textContent()).includes('175'));

  // ── inventory ─────────────────────────────────────────────────────────
  await goto('inventory');
  await page.waitForSelector('table.data tbody tr', { timeout: 15000 });
  check('Inventory ledger loads', (await page.locator('table.data tbody tr').count()) > 5);
  await shot('05-inventory-ledger');
  await page.click('#inv-tabs button[data-tab="low"]');
  await page.waitForTimeout(1200);
  check('Low stock tab renders', (await page.locator('#inv-body').textContent()).toLowerCase().includes('reorder') || (await page.locator('table.data tbody tr').count()) > 0);
  await shot('06-low-stock');
  await page.click('#inv-tabs button[data-tab="stock"]');
  await page.waitForTimeout(1200);
  check('Stock on hand tab renders', (await page.locator('table.data tbody tr').count()) > 5);

  // ── billing ───────────────────────────────────────────────────────────
  await goto('billing');
  await page.waitForSelector('.pick-card', { timeout: 15000 });
  check('Billing catalogue renders', (await page.locator('.pick-card').count()) > 5);
  await page.fill('#c-name', 'E2E Customer Ltd');
  await page.fill('#c-phone', '+91 90000 11111');
  await page.fill('#c-email', 'e2e@customer.example');

  const widgetCard = page.locator('.pick-card', { hasText: WIDGET_NAME });
  await widgetCard.click();
  await page.waitForTimeout(300);
  await page.locator('.pick-card', { hasText: 'A4 Copier Paper' }).first().click();
  await page.waitForTimeout(300);
  check('Add products to bill', (await page.locator('.bill-line').count()) === 2, `${await page.locator('.bill-line').count()} lines`);

  // quantity change
  await page.locator('[data-qty="0"]').fill('2');
  await page.locator('[data-qty="0"]').dispatchEvent('change');
  await page.waitForTimeout(300);
  // discount 10%
  await page.fill('#t-disc-value', '10');
  await page.waitForTimeout(300);
  await page.selectOption('#t-tax', '18');
  await page.waitForTimeout(400);
  const totalText = await page.locator('#t-total').textContent();
  check('Totals compute', /\d/.test(totalText) && totalText !== '₹0.00', totalText);
  await shot('07-billing');

  const stockBeforeBill = await (await fetch(`${BASE}/api/products?search=${WIDGET_SKU}`, { headers: { Authorization: 'Bearer ' + await page.evaluate(() => localStorage.getItem('stockflow.token')) } })).json();
  const qtyBeforeBill = stockBeforeBill.items[0].quantity;

  await page.click('#bill-submit');
  await page.waitForURL(/#\/invoices\/\d+/, { timeout: 15000 });
  await page.waitForSelector('.invoice-paper');
  await page.waitForTimeout(800);
  const invNo = await page.locator('.invoice-no').first().textContent();
  check('Invoice generated', /INV-\d{6}-\d{4}/.test(invNo.trim()), invNo.trim());
  check('Invoice shows customer', (await page.locator('.invoice-paper').textContent()).includes('E2E Customer Ltd'));
  check('Invoice shows discount line', (await page.locator('.invoice-paper').textContent()).includes('Discount'));
  await shot('08-invoice-detail');

  const token = await page.evaluate(() => localStorage.getItem('stockflow.token'));
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const stockAfterBill = await (await fetch(`${BASE}/api/products?search=${WIDGET_SKU}`, { headers })).json();
  check('Stock auto-deducted on bill', stockAfterBill.items[0].quantity === qtyBeforeBill - 2, `${qtyBeforeBill} → ${stockAfterBill.items[0].quantity}`);

  // invoice PDF
  const pdfResp = await fetch(`${BASE}/api/invoices/` + (await page.evaluate(() => location.hash.split('/').pop())) + '/pdf', { headers });
  check('Invoice PDF generated', pdfResp.ok && (pdfResp.headers.get('content-type') || '').includes('pdf'));

  // ── edit invoice ──────────────────────────────────────────────────────
  const invId = await page.evaluate(() => location.hash.split('/').pop());
  await goto(`billing?edit=${invId}`);
  await page.waitForSelector('.bill-line', { timeout: 15000 });
  check('Edit mode loads invoice lines', (await page.locator('.bill-line').count()) === 2);
  await page.locator('[data-qty="0"]').fill('5');
  await page.locator('[data-qty="0"]').dispatchEvent('change');
  await page.waitForTimeout(400);
  await page.click('#bill-submit');
  await page.waitForURL(/#\/invoices\/\d+/, { timeout: 15000 });
  await page.waitForTimeout(900);
  const stockAfterEdit = await (await fetch(`${BASE}/api/products?search=${WIDGET_SKU}`, { headers })).json();
  check('Edit invoice adjusts stock by delta', stockAfterEdit.items[0].quantity === qtyBeforeBill - 5, `${stockAfterBill.items[0].quantity} → ${stockAfterEdit.items[0].quantity}`);
  await shot('09-invoice-edited');

  // ── cancel invoice ────────────────────────────────────────────────────
  await page.click('#cancel');
  await page.waitForSelector('#reason-input');
  await page.fill('#reason-input', 'E2E cancellation test');
  await page.locator('[data-confirm]').click();
  await page.waitForTimeout(1500);
  const stockAfterCancel = await (await fetch(`${BASE}/api/products?search=${WIDGET_SKU}`, { headers })).json();
  check('Cancel restores stock', stockAfterCancel.items[0].quantity === qtyBeforeBill, `${stockAfterEdit.items[0].quantity} → ${stockAfterCancel.items[0].quantity}`);
  check('Cancelled stamp shown', (await page.locator('.invoice-paper').textContent()).toLowerCase().includes('cancelled'));
  await shot('10-invoice-cancelled');

  // ── invoices list ─────────────────────────────────────────────────────
  await goto('invoices');
  await page.waitForSelector('table.data tbody tr', { timeout: 15000 });
  check('Invoice history loads', (await page.locator('table.data tbody tr').count()) > 5);
  await page.selectOption('#i-status', 'cancelled');
  await page.waitForTimeout(1000);
  check('Invoice status filter works', (await page.locator('table.data tbody tr').count()) > 0);
  await shot('11-invoices');

  // ── reports ───────────────────────────────────────────────────────────
  await goto('reports');
  await page.waitForSelector('table.data tbody tr', { timeout: 15000 });
  check('Reports load', (await page.locator('table.data tbody tr').count()) > 0);
  await shot('12-reports');
  await page.click('#r-tabs button[data-tab="valuation"]');
  await page.waitForTimeout(1200);
  check('Valuation report renders', (await page.locator('#r-body').textContent()).includes('Cost value') || (await page.locator('table.data tbody tr').count()) > 0);
  await page.click('#r-tabs button[data-tab="lowstock"]');
  await page.waitForTimeout(1200);
  await shot('13-lowstock-report');
  await page.click('#r-tabs button[data-tab="movement"]');
  await page.waitForTimeout(1200);
  check('Movement report renders', (await page.locator('table.data tbody tr').count()) > 0);

  // exports
  const [dlXlsx] = await Promise.all([page.waitForEvent('download'), page.click('#r-xlsx')]);
  check('Excel export downloads', dlXlsx.suggestedFilename().endsWith('.xlsx'), dlXlsx.suggestedFilename());
  await page.click('#r-tabs button[data-tab="sales"]');
  await page.waitForTimeout(1200);
  const [dlPdf] = await Promise.all([page.waitForEvent('download'), page.click('#r-pdf')]);
  check('PDF export downloads', dlPdf.suggestedFilename().endsWith('.pdf'), dlPdf.suggestedFilename());

  // ── users admin ───────────────────────────────────────────────────────
  await goto('users');
  await page.waitForSelector('table.data tbody tr', { timeout: 15000 });
  check('User management loads', (await page.locator('table.data tbody tr').count()) >= 5);
  check('Permission matrix renders', (await page.locator('#u-matrix table tbody tr').count()) >= 14);
  await shot('14-users');

  // create user
  await page.click('#u-add');
  await page.waitForSelector('#user-form');
  await page.fill('#uf-name', 'E2E Staffer');
  await page.fill('#uf-email', STAFF_EMAIL);
  await page.fill('#uf-password', 'E2eStaff@123');
  await page.selectOption('#uf-role', 'staff');
  await page.click('#uf-submit');
  await page.waitForTimeout(1300);
  const newUserRow = page.locator('table.data tbody tr', { hasText: 'E2E Staffer' });
  check('Create user', await newUserRow.count() > 0);

  // deactivate user
  await newUserRow.locator('[data-toggle]').click();
  await page.waitForSelector('[data-confirm]');
  await page.locator('[data-confirm]').click();
  await page.waitForTimeout(1300);
  check('Deactivate user', (await page.locator('table.data tbody tr', { hasText: 'E2E Staffer' }).textContent()).includes('Inactive'));

  // reactivate
  await page.locator('table.data tbody tr', { hasText: 'E2E Staffer' }).locator('[data-toggle]').click();
  await page.waitForSelector('[data-confirm]');
  await page.locator('[data-confirm]').click();
  await page.waitForTimeout(1300);
  check('Reactivate user', (await page.locator('table.data tbody tr', { hasText: 'E2E Staffer' }).textContent()).includes('Active'));

  // ── profile ───────────────────────────────────────────────────────────
  await goto('profile');
  await page.waitForSelector('.avatar');
  check('Profile page loads', (await page.locator('h1').first().textContent()).includes('profile'));
  await shot('15-profile');

  // ── categories ────────────────────────────────────────────────────────
  await goto('categories');
  await page.waitForTimeout(1200);
  await page.fill('#c-name', CATEGORY_NAME);
  await page.click('#c-save');
  await page.waitForTimeout(1200);
  check('Create category', (await page.locator('#c-body').textContent()).includes(CATEGORY_NAME));
  await shot('16-categories');

  const adminErrors = [...errors];

  // ── staff role restrictions ───────────────────────────────────────────
  await page.evaluate(() => localStorage.clear());
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.fill('#email', 'staff@stockflow.app');
  await page.fill('#password', 'Staff@1234');
  await page.click('#login-btn');
  await page.waitForSelector('.stat-value', { timeout: 15000 });
  await page.waitForTimeout(900);
  const navLabels = await page.locator('.nav-item').allTextContents();
  check('Staff cannot see Users nav', !navLabels.some(l => l.trim() === 'Users'), navLabels.map(s=>s.trim()).join(','));
  check('Staff cannot see Reports nav', !navLabels.some(l => l.trim() === 'Reports'));
  check('Staff can see New Bill nav', navLabels.some(l => l.includes('New Bill')));
  await shot('17-dashboard-staff');

  // direct URL access to admin page → access restricted
  await goto('users');
  check('Staff blocked from /users route', (await page.locator('#content').textContent()).includes('Access restricted'));
  await shot('18-staff-blocked');

  // staff cannot create product (no button)
  await goto('products');
  await page.waitForSelector('table.data tbody tr', { timeout: 15000 });
  check('Staff has no Add product button', (await page.locator('#add-product').count()) === 0);
  check('Staff has no stock steppers', (await page.locator('.stepper').count()) === 0);

  // staff CAN bill
  await goto('billing');
  await page.waitForSelector('.pick-card', { timeout: 15000 });
  await page.fill('#c-name', 'Staff Sale Customer');
  await page.locator('.pick-card:not([disabled])').first().click();
  await page.waitForTimeout(400);
  await page.click('#bill-submit');
  await page.waitForURL(/#\/invoices\/\d+/, { timeout: 15000 });
  await page.waitForTimeout(800);
  check('Staff can create a bill', (await page.locator('.invoice-no').first().textContent()).includes('INV-'));
  check('Staff cannot cancel (no cancel button)', (await page.locator('#cancel').count()) === 0);
  await shot('19-staff-invoice');

  // ── mobile responsive ─────────────────────────────────────────────────
  const mobile = await ctx.newPage();
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto(BASE, { waitUntil: 'networkidle' });
  await mobile.waitForTimeout(1200);
  check('Mobile: sidebar hidden by default', await mobile.locator('body').evaluate(el => !el.classList.contains('nav-open')));
  await mobile.click('#menu-btn');
  await mobile.waitForTimeout(500);
  check('Mobile: menu opens', await mobile.locator('body').evaluate(el => el.classList.contains('nav-open')));
  await mobile.screenshot({ path: `${SHOTS}/20-mobile-nav.png` });
  await mobile.mouse.click(360, 400);
  await mobile.waitForTimeout(400);
  await mobile.screenshot({ path: `${SHOTS}/21-mobile-dashboard.png`, fullPage: false });
  await mobile.goto(`${BASE}/#/products`, { waitUntil: 'networkidle' });
  await mobile.waitForTimeout(1200);
  await mobile.screenshot({ path: `${SHOTS}/22-mobile-products.png` });
  const hScroll = await mobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
  check('Mobile: no horizontal page overflow', !hScroll);
  await mobile.close();

  log('\nPAGE ERRORS (admin session):', adminErrors.length ? adminErrors : 'none');
  log('PAGE ERRORS (all):', errors.length ? errors : 'none');
  const failed = results.filter(r => !r.ok);
  log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
  if (failed.length) log('FAILED:', failed.map(f => f.name));
  await browser.close();
  process.exit(failed.length || errors.length ? 1 : 0);
})().catch((e) => { console.error('E2E CRASH:', e.message); process.exit(2); });
