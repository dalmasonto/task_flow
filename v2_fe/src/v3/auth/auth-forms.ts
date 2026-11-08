/// Pure rules for the v3 auth forms, tested in auth-forms.test.ts.

/// Matches the backend's minimum (umbral-auth: "at least 8 characters"). The
/// design said 10; the server is the authority, so the form says 8.
export const MIN_PASSWORD = 8

export type SignupInput = { username: string; email: string; password: string }
export type FieldErrors<K extends string> = Partial<Record<K, string>>

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const USERNAME = /^[A-Za-z0-9_.-]{2,40}$/

export function validateSignup(input: SignupInput): FieldErrors<keyof SignupInput> {
  const errors: FieldErrors<keyof SignupInput> = {}
  if (!USERNAME.test(input.username)) errors.username = "Use 2 to 40 letters, numbers, dots, dashes or underscores. No spaces."
  if (!EMAIL.test(input.email)) errors.email = "Enter an email address like you@example.com."
  if (input.password.length < MIN_PASSWORD) errors.password = `Use at least ${MIN_PASSWORD} characters. This one has ${input.password.length}.`
  return errors
}

export function validateEmail(email: string): string | null {
  return EMAIL.test(email.trim()) ? null : "Enter an email address like you@example.com."
}

/// The server's messages, turned into something a person can act on. Unknown
/// messages pass through unchanged rather than being guessed at.
export function friendlyAuthError(kind: "login" | "signup" | "reset", message: string): { field?: "password" | "account"; text: string } {
  const m = message.toLowerCase()
  if (kind === "login" && /incorrect|invalid|credentials/.test(m)) return { text: "That email or username and password don't match." }
  if (kind === "login" && /inactive|disabled/.test(m)) return { text: "This account is switched off. Ask a project owner to turn it back on." }
  if (kind === "signup" && /could not create account|create_failed|already|exists|taken/.test(m)) return { field: "account", text: "That username or email already has an account." }
  if (/too common|numeric|too short|similar|weak/.test(m)) return { field: "password", text: message }
  if (/failed to fetch|network|load failed/.test(m)) return { text: "Couldn't reach the server. Check your connection, or change the server above." }
  return { text: message }
}

/// The token in a password-reset link (`?token=…`), trimmed; "" when absent.
export function resetTokenFrom(search: string): string {
  return (new URLSearchParams(search).get("token") ?? "").trim()
}
