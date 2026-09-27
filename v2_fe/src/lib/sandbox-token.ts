/// The sandbox token's LIFETIME, from this side of the wire.
///
/// A sandbox token (`sandbox.rs`) is `{project}.{expiry hex}.{signature}` and
/// lives ten minutes: short by design, so a leaked link dies quickly, on the
/// understanding that the chrome mints a fresh one whenever it needs one.
/// The chrome used to mint exactly once, when the design page loaded, and a
/// long sitting — a hundred-screen export at ten seconds a screen, or a
/// canvas left open — outlived it. Past the expiry every sandbox URL answers
/// an empty 404: a board's links break, a stylesheet is "refused" for its
/// missing MIME type, and an export's captures time out one after another.
///
/// The expiry is readable here without the secret (only the signature needs
/// it), so a token can be judged fresh or stale before it is used and
/// replaced ahead of time. Everything that composes a sandbox URL should ask
/// [`sandboxTokenSource`] for the token rather than hold one.

/// How long before its expiry a token is treated as stale. Two minutes
/// covers a capture's own timeout with room: a token handed out fresh will
/// outlive the page load and every subresource it pulls in.
export const TOKEN_REFRESH_MARGIN_SECS = 120

/// The token's expiry, in unix seconds, or null for a string that is not a
/// token. The signature is not checked — only the server can — so this says
/// when a token WILL be refused, never that it is accepted.
export function sandboxTokenExpiry(token: string): number | null {
  const parts = token.split(".")
  if (parts.length !== 3 || !/^[0-9a-f]+$/i.test(parts[1])) return null
  const expiry = parseInt(parts[1], 16)
  return Number.isFinite(expiry) ? expiry : null
}

/// Whether `token` still has more than the margin left at `nowSecs`.
export function sandboxTokenIsFresh(token: string, nowSecs: number = Date.now() / 1000): boolean {
  const expiry = sandboxTokenExpiry(token)
  return expiry !== null && expiry - nowSecs > TOKEN_REFRESH_MARGIN_SECS
}

/// A getter that always answers a fresh token: the one it has while that is
/// fresh, else one newly minted — once, however many ask at the same moment.
/// `onMint` hears every new token, so the caller can put it in state for the
/// boards to remount onto.
export function sandboxTokenSource(
  initial: string | null,
  mint: () => Promise<string>,
  now: () => number = () => Date.now() / 1000,
  onMint?: (token: string) => void,
): () => Promise<string> {
  let current = initial
  let pending: Promise<string> | null = null
  return () => {
    if (current && sandboxTokenIsFresh(current, now())) return Promise.resolve(current)
    if (!pending) {
      pending = mint()
        .then((token) => {
          current = token
          onMint?.(token)
          return token
        })
        .finally(() => {
          pending = null
        })
    }
    return pending
  }
}
