import * as perms from '../permissions.js';

export const id = 'permissions';
export const title = 'Permissions';
export const slash = '/permissions';

export function mount(container) {
  container.innerHTML = `<div class="perm-list"></div>`;
  const list = container.querySelector('.perm-list');

  function render() {
    list.innerHTML = '';
    const all = perms.listDecisions();
    const entries = Object.entries(all);
    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'perm-empty';
      empty.textContent = 'No permission decisions stored yet.';
      list.appendChild(empty);
      return;
    }
    for (const [nappId, methods] of entries) {
      const group = document.createElement('div');
      group.className = 'perm-group';

      const head = document.createElement('div');
      head.className = 'perm-group-head';
      const name = document.createElement('code');
      name.className = 'perm-napp-id';
      name.textContent = nappId;
      head.appendChild(name);
      const clearAll = document.createElement('button');
      clearAll.type = 'button';
      clearAll.textContent = 'forget all';
      clearAll.addEventListener('click', () => perms.forgetDecision(nappId));
      head.appendChild(clearAll);
      group.appendChild(head);

      for (const [method, decision] of Object.entries(methods)) {
        const row = document.createElement('div');
        row.className = 'perm-row';
        const m = document.createElement('code');
        m.className = 'perm-method';
        m.textContent = method;
        const d = document.createElement('span');
        d.className = `perm-decision perm-${decision}`;
        d.textContent = decision;
        const f = document.createElement('button');
        f.type = 'button';
        f.textContent = 'forget';
        f.addEventListener('click', () =>
          perms.forgetDecision(nappId, method),
        );
        row.append(m, d, f);
        group.appendChild(row);
      }

      list.appendChild(group);
    }
  }

  render();
  const unsub = perms.subscribe(render);

  return {
    unmount() {
      unsub();
    },
  };
}
