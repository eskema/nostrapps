import { itemsFromTags, makeListFetcher } from "@nostr/gadgets/lists"

// Fetchers for the NIP-51 relay-list kinds the gadgets package doesn't ship
// loaders for (the same set the relays napp edits). Shape mirrors lists.ts's
// own loadWikiRelays: no hardcoded indexer relays (the fetcher falls back to
// the target's kind-10002 write relays), items are the urls from `relay`
// tags, results cached in the shared store with lastAttempt freshness.

const relayUrlItems = itemsFromTags<string>((tag: string[]): string | undefined => {
  if (tag.length >= 2 && tag[0] === "relay" && tag[1]) {
    return tag[1]
  }
})

/** kind:10006 blocked relays (NIP-51) */
export const loadBlockedRelays = makeListFetcher<string>(10006, [], relayUrlItems)

/** kind:10007 search relays (NIP-51) */
export const loadSearchRelays = makeListFetcher<string>(10007, [], relayUrlItems)

/** kind:10050 dm relays (NIP-17) */
export const loadDmRelays = makeListFetcher<string>(10050, [], relayUrlItems)
