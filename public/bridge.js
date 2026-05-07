(() => {
  const pending = new Map();
  // Prefer iframe.name (set by the launcher cross-origin) so we don't pollute
  // the URL with a query string that napps might echo into their own routing.
  // Fall back to the legacy `?__instance=` for back-compat.
  const INSTANCE_ID =
    (typeof window.name === 'string' && window.name) ||
    new URLSearchParams(location.search).get('__instance') ||
    '';

  function rpc(method, params) {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      window.parent.postMessage(
        {
          __nostrapps: 'rpc',
          id,
          method,
          params,
          instanceId: INSTANCE_ID,
        },
        '*',
      );
    });
  }

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (
      !data ||
      (data.__nostrapps !== 'rpc-result' && data.__nostrapps !== 'rpc-error')
    ) {
      return;
    }
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id);
    if (data.__nostrapps === 'rpc-result') p.resolve(data.result);
    else p.reject(new Error(data.error));
  });

  window.nostr = {
    getPublicKey: () => rpc('getPublicKey'),
    signEvent: (evt) => rpc('signEvent', evt),
    getRelays: () => rpc('getRelays'),
    nip04: {
      encrypt: (pubkey, plaintext) =>
        rpc('nip04.encrypt', { pubkey, plaintext }),
      decrypt: (pubkey, ciphertext) =>
        rpc('nip04.decrypt', { pubkey, ciphertext }),
    },
    nip44: {
      encrypt: (pubkey, plaintext) =>
        rpc('nip44.encrypt', { pubkey, plaintext }),
      decrypt: (pubkey, ciphertext) =>
        rpc('nip44.decrypt', { pubkey, ciphertext }),
    },
    pool: {
      query: (filters, opts) => rpc('pool.query', { filters, opts }),
      publish: (event, opts) => rpc('pool.publish', { event, opts }),
    },
    instance: {
      id: INSTANCE_ID,
      get: (key) => rpc('instance.get', { key }),
      set: (key, value) => rpc('instance.set', { key, value }),
      delete: (key) => rpc('instance.delete', { key }),
      keys: () => rpc('instance.keys'),
    },
  };

  window.nostrdb = {
    add: (event) => rpc('nostrdb.add', { event }),
    query: (filters) => rpc('nostrdb.query', { filters }),
    count: (filters) => rpc('nostrdb.count', { filters }),
    event: (id) => rpc('nostrdb.event', { id }),
    replaceable: (kind, author, identifier) =>
      rpc('nostrdb.replaceable', { kind, author, identifier }),
  };
})();
