// One lifetime per loaded napplet document. Every call captures it, so closing
// or reloading the window, or changing account, invalidates work still in
// flight: each step checks before doing anything the user or napplet would see.
export interface NappletCallContext {
  signal: AbortSignal
  check(): void
}

export function createNappletLifetime(account: () => string | null) {
  const controller = new AbortController()
  return {
    abort(reason: string) {
      controller.abort(new Error(reason))
    },
    signal: controller.signal,
    context(): NappletCallContext {
      // A call made logged out may log in on the way (requireAccount); after
      // that, the account it started with must stay.
      let owner = account()
      return {
        signal: controller.signal,
        check() {
          controller.signal.throwIfAborted()
          const current = account()
          if (owner && current !== owner) throw new Error("Your account changed. Try again.")
          owner ??= current
        }
      }
    }
  }
}
