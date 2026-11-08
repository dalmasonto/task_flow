import { describe, expect, it } from "vitest"

import { friendlyAuthError, resetTokenFrom, validateEmail, validateSignup } from "./auth-forms"

describe("validateSignup", () => {
  it("accepts a normal signup", () => {
    expect(validateSignup({ username: "dalmas", email: "d@example.com", password: "a long phrase" })).toEqual({})
  })
  it("flags each field the server would wrongly accept or reject", () => {
    const e = validateSignup({ username: "has space", email: "bad", password: "short" })
    expect(Object.keys(e).sort()).toEqual(["email", "password", "username"])
    expect(e.password).toContain("This one has 5")
  })
})

describe("validateEmail", () => {
  it("needs an @ and a dot", () => {
    expect(validateEmail(" you@example.com ")).toBeNull()
    expect(validateEmail("you@example")).not.toBeNull()
  })
})

describe("friendlyAuthError", () => {
  it("explains a failed login without saying which half was wrong", () => {
    expect(friendlyAuthError("login", "username or password is incorrect").text).toBe("That email or username and password don't match.")
  })
  it("turns the server's opaque duplicate error into an account error", () => {
    expect(friendlyAuthError("signup", "could not create account")).toEqual({ field: "account", text: "That username or email already has an account." })
  })
  it("keeps the server's named duplicate (#1114)", () => {
    expect(friendlyAuthError("signup", "That username is taken.")).toEqual({ field: "account", text: "That username is taken." })
    expect(friendlyAuthError("signup", "That email already has an account.")).toEqual({ field: "account", text: "That email already has an account." })
  })
  it("puts weak-password messages on the password field", () => {
    expect(friendlyAuthError("signup", "This password is too common.").field).toBe("password")
  })
  it("names a network failure", () => {
    expect(friendlyAuthError("login", "Failed to fetch").text).toContain("Couldn't reach the server")
  })
  it("passes unknown messages through", () => {
    expect(friendlyAuthError("reset", "Something odd").text).toBe("Something odd")
  })
})

describe("resetTokenFrom", () => {
  it("reads ?token=", () => {
    expect(resetTokenFrom("?token=abc%20")).toBe("abc")
    expect(resetTokenFrom("")).toBe("")
  })
})
