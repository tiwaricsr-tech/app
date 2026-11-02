/**
 * Classic (non-module) safety net.
 *
 * If the ES module graph never executes — blocked by CORS/CSP, a missing file, or an
 * older browser — replace the endless "Loading StockFlow…" splash with an actionable
 * message instead of a blank screen. Served as a separate file so it obeys the strict
 * `script-src 'self'` policy (no inline script, no hash needed).
 */
(function () {
  window.__sfBooted = window.__sfBooted || false;
  setTimeout(function () {
    if (window.__sfBooted) return;
    var boot = document.getElementById('boot');
    if (!boot) return;
    boot.innerHTML =
      '<div style="max-width:520px;text-align:center;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:24px">' +
      '<div style="width:44px;height:44px;border-radius:12px;background:#fef2f2;color:#dc2626;display:grid;place-items:center;margin:0 auto 14px;font-size:22px;font-weight:700;border:1px solid #fecaca">!</div>' +
      '<h2 style="margin:0 0 8px;font-size:17px;color:#0f172a">The app could not finish loading</h2>' +
      '<p style="margin:0 0 14px;font-size:13.5px;line-height:1.6;color:#64748b">' +
      'Your browser blocked the application scripts, or the server is unreachable.</p>' +
      '<a href="' + location.href + '" target="_blank" rel="noopener" ' +
      'style="display:inline-block;background:#1d4ed8;color:#fff;padding:9px 16px;border-radius:9px;' +
      'text-decoration:none;font-size:13px;font-weight:600">Reload</a>' +
      '<p style="margin:14px 0 0;font-size:11.5px;color:#94a3b8">StockFlow · restart the server with <code>npm start</code> if this persists</p>' +
      '</div>';
  }, 8000);
})();
