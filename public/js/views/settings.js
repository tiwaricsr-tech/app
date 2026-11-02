import { api, can } from '../api.js';
import { icon } from '../icons.js';
import { esc, num, emptyState, skeletonRows, toast, confirmDialog, buttonLoading } from '../ui.js';

/** Categories management (admin / manager). */
export default async function renderSettings({ container }) {
  container.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Categories</h1>
        <p>Group products for filtering, reporting and stock valuation.</p>
      </div>
      <div class="page-head-actions">
        ${can('categories.manage') ? `<button class="btn btn-primary" id="c-add">${icon('plus')} Add category</button>` : ''}
      </div>
    </div>
    <div class="grid-split" style="--split-l:1.4fr">
      <section class="card">
        <div class="card-head"><h3>All categories</h3><span class="badge badge-gray" id="c-count" style="margin-left:auto">—</span></div>
        <div id="c-body">${skeletonRows(4)}</div>
      </section>
      <section class="card">
        <div class="card-head"><h3>Add a category</h3></div>
        <div class="card-body">
          <form id="c-form" class="stack" style="gap:12px">
            <div class="field">
              <label for="c-name">Name <span class="req">*</span></label>
              <input class="input" id="c-name" placeholder="e.g. Accessories" maxlength="80" />
            </div>
            <div class="field">
              <label for="c-desc">Description</label>
              <textarea class="textarea" id="c-desc" rows="2" placeholder="What belongs in this category?"></textarea>
            </div>
            <div id="c-error" class="alert alert-red hidden"></div>
            <button class="btn btn-primary" type="button" id="c-save">${icon('plus')} Create category</button>
          </form>
          <div class="alert alert-blue" style="margin-top:14px">
            ${icon('info')}<div class="small">Deleting a category is blocked while products still reference it — reassign those products first.</div>
          </div>
        </div>
      </section>
    </div>`;

  const body = container.querySelector('#c-body');

  const load = async () => {
    body.innerHTML = skeletonRows(4);
    try {
      const { items } = await api.get('/categories');
      container.querySelector('#c-count').textContent = `${items.length} total`;
      if (!items.length) {
        body.innerHTML = emptyState({ iconName: 'tag', title: 'No categories yet', message: 'Create your first category using the form.' });
        return;
      }
      body.innerHTML = `<div class="table-wrap"><table class="data">
        <thead><tr><th>Category</th><th>Description</th><th class="num">Products</th><th class="num">Actions</th></tr></thead>
        <tbody>${items.map((c) => `
          <tr>
            <td><div class="strong">${esc(c.name)}</div></td>
            <td class="small muted">${esc(c.description || '—')}</td>
            <td class="num"><span class="badge badge-blue">${num(c.product_count)}</span></td>
            <td>
              <div class="row-actions">
                <button class="btn btn-sm btn-ghost btn-icon" data-rename="${c.id}" title="Rename">${icon('edit')}</button>
                <button class="btn btn-sm btn-ghost btn-icon" data-del="${c.id}" title="Delete" style="color:var(--red)" ${c.product_count > 0 ? 'disabled' : ''}>${icon('trash')}</button>
              </div>
            </td>
          </tr>`).join('')}</tbody>
      </table></div>`;

      body.querySelectorAll('[data-rename]').forEach((btn) => {
        btn.onclick = async () => {
          const cat = items.find((c) => String(c.id) === String(btn.dataset.rename));
          const name = prompt(`Rename category "${cat.name}"`, cat.name);
          if (!name || name.trim() === cat.name) return;
          try {
            await api.patch(`/categories/${cat.id}`, { name: name.trim() });
            toast('Category renamed.', 'success');
            load();
          } catch (err) { toast(err.message, 'error'); }
        };
      });
      body.querySelectorAll('[data-del]').forEach((btn) => {
        btn.onclick = async () => {
          const cat = items.find((c) => String(c.id) === String(btn.dataset.del));
          const ok = await confirmDialog({
            title: `Delete "${cat.name}"?`,
            message: 'This cannot be undone.',
            confirmLabel: 'Delete category', danger: true
          });
          if (!ok) return;
          try {
            await api.del(`/categories/${cat.id}`);
            toast('Category deleted.', 'success');
            load();
          } catch (err) { toast(err.message, 'error'); }
        };
      });
    } catch (err) {
      body.innerHTML = `<div class="card-body"><div class="alert alert-red">${icon('alert')}<div>${esc(err.message)}</div></div></div>`;
    }
  };

  const form = container.querySelector('#c-form');
  const errBox = container.querySelector('#c-error');
  // Sandboxed iframes block native submission — drive from the button instead.
  form.addEventListener('submit', (e) => { e.preventDefault(); });
  const saveBtn = container.querySelector('#c-save');
  saveBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    errBox.classList.add('hidden');
    const name = container.querySelector('#c-name').value.trim();
    if (name.length < 2) { errBox.textContent = 'Category name must be at least 2 characters.'; errBox.classList.remove('hidden'); return; }
    const btn = container.querySelector('#c-save');
    const restore = buttonLoading(btn, 'Creating…');
    try {
      await api.post('/categories', { name, description: container.querySelector('#c-desc').value.trim() });
      toast('Category created.', 'success');
      form.reset();
      load();
    } catch (err) {
      errBox.textContent = err.message; errBox.classList.remove('hidden');
      restore();
    }
  });

  const addBtn = container.querySelector('#c-add');
  if (addBtn) addBtn.onclick = () => container.querySelector('#c-name').focus();

  await load();
}
