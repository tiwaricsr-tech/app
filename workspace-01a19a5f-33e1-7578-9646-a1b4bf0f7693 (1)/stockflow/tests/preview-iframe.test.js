const path = require('path');
const { chromium } = require(path.join(__dirname, '..', 'node_modules', 'playwright-core'));
const fs = require('fs');
const exe = (() => { const b = process.env.HOME + '/.cache/ms-playwright';
  for (const d of fs.readdirSync(b)) { if (!d.includes('chromium')) continue;
    for (const s of ['/chrome-linux64/chrome','/chrome-linux/chrome','/chrome-linux/headless_shell']) {
      const f = b + '/' + d + s; if (fs.existsSync(f)) return f; } } })();
let pass = 0, fail = 0;
const t = (n, ok, extra='') => { ok ? pass++ : fail++; console.log(`  ${ok?'✅':'❌'} ${n}${extra?' — '+extra:''}`); };

(async () => {
  const br = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  const p = await br.newPage({ viewport: { width: 1440, height: 950 } });
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type()==='error' && !m.text().includes('favicon')) errs.push(m.text().slice(0,150)); });

  // EXACT preview conditions: sandbox="allow-scripts" only -> opaque origin, no forms, no storage
  // Build the sandboxed-iframe harness on the fly from a blob-free data URL is not
  // possible (nested opaque origin), so we serve a tiny harness page from the app.
  await p.goto('http://127.0.0.1:4173/__iframe_probe', { waitUntil: 'networkidle' });
  await p.waitForTimeout(3000);
  const f = p.frames().find(x => x !== p.mainFrame());

  t('login screen renders inside sandboxed iframe', (await f.locator('h1').first().textContent()).includes('Welcome back'));
  t('boot splash cleared', !(await f.locator('#boot').isVisible()));

  await f.fill('#email', 'admin@stockflow.app');
  await f.fill('#password', process.env.TEST_PASSWORD || 'Admin@1234');
  await f.click('#login-btn');
  await p.waitForTimeout(4000);

  const h1 = (await f.locator('#content h1').first().textContent().catch(()=>'') || '').trim();
  t('login succeeds without page reload', h1.toLowerCase().includes('good'), h1);
  t('KPI cards rendered', (await f.locator('.stat').count()) >= 4, `${await f.locator('.stat').count()} cards`);
  await p.screenshot({ path: '/home/user/stockflow/screenshots/41-iframe-dashboard.png' });

  // navigate around inside the iframe
  for (const [hash, sel, name] of [
    ['products', 'table.data tbody tr', 'Products'],
    ['inventory', 'table.data tbody tr', 'Inventory'],
    ['billing', '.pick-card', 'Billing'],
    ['invoices', 'table.data tbody tr', 'Invoices'],
    ['reports', 'table.data tbody tr', 'Reports'],
    ['users', 'table.data tbody tr', 'Users']
  ]) {
    await f.goto('http://127.0.0.1:4173/#/' + hash);
    await p.waitForTimeout(2200);
    const n = await f.locator(sel).count();
    t(`${name} page renders`, n > 0, `${n} nodes`);
  }

  // create a bill inside the iframe (proves forms-in-sandbox works for billing)
  await f.goto('http://127.0.0.1:4173/#/billing');
  await p.waitForTimeout(2200);
  await f.fill('#c-name', 'Iframe Test Customer');
  await f.locator('.pick-card:not([disabled])').first().click();
  await p.waitForTimeout(600);
  await f.click('#bill-submit');
  await p.waitForTimeout(3500);
  const invNo = (await f.locator('.invoice-no').first().textContent().catch(()=>'') || '').trim();
  t('bill created inside sandboxed iframe', /INV-\d{6}-\d{4}/.test(invNo), invNo);
  await p.screenshot({ path: '/home/user/stockflow/screenshots/43-iframe-invoice.png' });

  // sign out returns to login without reload
  await f.goto('http://127.0.0.1:4173/#/profile');
  await p.waitForTimeout(2000);
  await f.click('#sign-out');
  await p.waitForTimeout(2000);
  t('sign out returns to login', (await f.locator('h1').first().textContent().catch(()=>'')).includes('Welcome back'));

  console.log('\nconsole errors:', errs.length ? [...new Set(errs)].slice(0,4) : 'none');
  console.log(`\n=== ${pass}/${pass+fail} iframe checks passed ===`);
  await br.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASH', e.message.split('\n')[0]); process.exit(2); });
