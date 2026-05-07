export const id = 'settings';
export const title = 'Settings';
export const slash = '/settings';

export function mount(container, ctx) {
  container.innerHTML = `
    <div class="settings-panel">
      <div class="settings-row">
        <span class="settings-label">Theme</span>
        <div class="settings-theme">
          <button type="button" data-choice="light" title="Light">☀</button>
          <button type="button" data-choice="dark" title="Dark">☾</button>
          <button type="button" data-choice="auto" title="Auto">◐</button>
        </div>
      </div>
      <div class="settings-row">
        <span class="settings-label">Account</span>
        <div class="settings-account">
          <code class="settings-pubkey"></code>
          <button type="button" class="settings-account-btn"></button>
        </div>
      </div>
    </div>
  `;

  const themeBtns = container.querySelectorAll('.settings-theme button');
  const accountBtn = container.querySelector('.settings-account-btn');
  const pubkeyEl = container.querySelector('.settings-pubkey');

  function renderTheme(choice) {
    for (const btn of themeBtns) {
      btn.classList.toggle('active', btn.dataset.choice === choice);
    }
  }

  function renderAccount(pk) {
    if (pk) {
      pubkeyEl.textContent = pk.slice(0, 8);
      pubkeyEl.title = pk;
      accountBtn.textContent = 'disconnect account';
      accountBtn.dataset.mode = 'disconnect';
    } else {
      pubkeyEl.textContent = '';
      pubkeyEl.removeAttribute('title');
      accountBtn.textContent = 'connect account';
      accountBtn.dataset.mode = 'connect';
    }
  }

  for (const btn of themeBtns) {
    btn.addEventListener('click', () => ctx.theme.set(btn.dataset.choice));
  }
  accountBtn.addEventListener('click', () => {
    if (accountBtn.dataset.mode === 'disconnect') ctx.disconnect();
    else ctx.connect();
  });

  renderTheme(ctx.theme.get());
  renderAccount(ctx.account.getPubkey());

  const unsubTheme = ctx.theme.subscribe(renderTheme);
  const unsubAccount = ctx.account.subscribe(renderAccount);

  return {
    unmount() {
      unsubTheme();
      unsubAccount();
    },
  };
}
