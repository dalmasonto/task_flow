import { describe, expect, it } from "vitest"

import { UmbralError } from "../api/client"
import { umbralErrorMessage } from "./taskflow-api"

/// The generated client's `UmbralError` message is only
/// `"umbral: request failed with status 400"`, and `App.tsx` showed exactly that
/// string for every failed write. A rejected task create — 12,617 characters
/// pasted into a `varchar(12000)` column — therefore told the operator nothing:
/// not the column, not the limit, not the length. These tests pin the rendering
/// of the server's envelope, whose field keys are flattened to the top level.

/// The exact body umbral-rest returns for a `WriteError::Validator`
/// (the shape the declared-length rule produces).
function validationError(fields: Record<string, string[]>): UmbralError {
  return new UmbralError(400, {
    code: "validator_failed",
    ...fields,
    non_field_errors: [],
  })
}

describe("umbralErrorMessage", () => {
  it("names the field, the limit and the actual length", () => {
    const error = validationError({
      description_markdown: ["Must be at most 12000 characters (got 12617)."],
    })

    expect(umbralErrorMessage(error, "fallback")).toBe(
      "description_markdown: Must be at most 12000 characters (got 12617)."
    )
  })

  it("renders every failing field, one per line", () => {
    const error = validationError({
      title: ["Must be at most 220 characters (got 300)."],
      notes_markdown: ["Must be at most 12000 characters (got 13000)."],
    })

    const message = umbralErrorMessage(error, "fallback")

    expect(message).toContain("title: Must be at most 220 characters (got 300).")
    expect(message).toContain("notes_markdown: Must be at most 12000 characters (got 13000).")
    expect(message.split("\n")).toHaveLength(2)
  })

  it("never leaks the envelope's own `code` key as if it were a field", () => {
    const error = validationError({ description_markdown: ["Too long."] })

    expect(umbralErrorMessage(error, "fallback")).not.toContain("validator_failed")
  })

  it("surfaces a whole-form error that names no field", () => {
    const error = new UmbralError(400, {
      code: "validation_error",
      non_field_errors: ["This project is archived."],
    })

    expect(umbralErrorMessage(error, "fallback")).toBe("This project is archived.")
  })

  it("falls back to the envelope's single message when there is no field map", () => {
    const error = new UmbralError(403, { code: "forbidden", error: "forbidden" })

    expect(umbralErrorMessage(error, "fallback")).toBe("forbidden")
  })

  it("reads the throttled envelope's `detail`", () => {
    const error = new UmbralError(429, {
      code: "throttled",
      detail: "Request was throttled.",
      retry_after: 30,
    })

    expect(umbralErrorMessage(error, "fallback")).toBe("Request was throttled.")
  })

  it("uses the caller's fallback when the body carries nothing readable", () => {
    expect(umbralErrorMessage(new UmbralError(500, null), "Could not create the task.")).toBe(
      "Could not create the task."
    )
    expect(umbralErrorMessage(new UmbralError(500, { code: "database_error" }), "fallback")).toBe(
      "fallback"
    )
  })

  it("passes a non-API error's own message through", () => {
    expect(umbralErrorMessage(new Error("Failed to fetch"), "fallback")).toBe("Failed to fetch")
    expect(umbralErrorMessage("not an error", "fallback")).toBe("fallback")
  })
})
