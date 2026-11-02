// Match applesauce-common/helpers/napplet's isValidNamedNapplet, used by
// napplet-frame's library. Kind 35129 is also used by unrelated applications;
// the kind alone does not identify a napplet. Signature verification remains
// the relay pool's responsibility.
export function isValidNamedNapplet(event: {
  kind: number
  content: string
  tags: string[][]
}): boolean {
  if (event.kind !== 35129 || !event.content.trim()) return false
  const hashes = event.tags.filter(tag => tag[0] === "x")
  if (hashes.length !== 1 || !/^[0-9a-f]{64}$/.test(hashes[0][1] ?? "")) return false
  const identifiers = event.tags.filter(tag => tag[0] === "d")
  return identifiers.length === 1 && !!identifiers[0][1]
}
