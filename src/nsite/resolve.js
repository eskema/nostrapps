import * as nip19 from '@nostr/tools/nip19';

export function resolveInput(input) {
  const s = input.trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return { pubkey: s.toLowerCase() };
  const decoded = nip19.decode(s);
  if (decoded.type === 'npub') return { pubkey: decoded.data };
  if (decoded.type === 'nprofile') return { pubkey: decoded.data.pubkey };
  throw new Error(`Unsupported input type: ${decoded.type}`);
}
