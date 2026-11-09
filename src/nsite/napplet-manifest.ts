// Kind 35129 is also used by unrelated applications; the kind alone does not
// identify a napplet. Like applesauce-common's isValidNamedNapplet, but content
// may be empty: here it's the description, which is optional. Signature
// verification remains the relay pool's responsibility.
export function isValidNamedNapplet(event: {
  kind: number
  content: string
  tags: string[][]
}): boolean {
  if (event.kind !== 35129) return false
  const hashes = event.tags.filter(tag => tag[0] === "x")
  if (hashes.length !== 1 || !/^[0-9a-f]{64}$/.test(hashes[0][1] ?? "")) return false
  const identifiers = event.tags.filter(tag => tag[0] === "d")
  return identifiers.length === 1 && !!identifiers[0][1]
}
