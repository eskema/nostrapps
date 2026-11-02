// One lifetime per loaded document. Every operation captures its lifetime so
// closing, reloading, revoking access, or changing account invalidates old work.
export interface NappletCallContext {
  signal: AbortSignal
  check(): void
}

export function createNappletLifetime(
  account: () => string | null,
  granted: (domain: string) => boolean
) {
  const controller = new AbortController()
  return {
    abort() {
      controller.abort()
    },
    signal: controller.signal,
    context(domain: string): NappletCallContext {
      let owner = account()
      return {
        signal: controller.signal,
        check() {
          controller.signal.throwIfAborted()
          if (!granted(domain)) throw new Error("Permission revoked")
          const current = account()
          if (owner && current !== owner) throw new Error("Your account changed. Try again.")
          owner ??= current
        }
      }
    }
  }
}
