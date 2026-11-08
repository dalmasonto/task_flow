import { describe, it, expect } from "vitest"
import { db, parseSiteConfig } from "./site-config"

/// The stored shape of the site-wide config row. Tested pure, the same way
/// design-ui-state tests `parseUIState`: the Dexie I/O itself needs a browser.
describe("parseSiteConfig", () => {
  // Fails if a stored id is dropped when it is perfectly good — the user would
  // silently lose their choice on every load.
  it("keeps a non-empty string project id", () => {
    expect(parseSiteConfig({ defaultProjectId: "12" }, 4)?.defaultProjectId).toBe("12")
  })

  // Fails if a non-string is coerced or trusted. The API's own project ids are
  // NUMBERS while `Project.id` on the client is a STRING; a number that reached
  // this row would never match a project in the list, so it would behave exactly
  // like "no preference" — the original bug, wearing the fix's clothes.
  it("treats a non-string or empty id as no preference", () => {
    expect(parseSiteConfig({ defaultProjectId: 12 }, 4)?.defaultProjectId).toBeNull()
    expect(parseSiteConfig({ defaultProjectId: "" }, 4)?.defaultProjectId).toBeNull()
    expect(parseSiteConfig({ defaultProjectId: null }, 4)?.defaultProjectId).toBeNull()
    expect(parseSiteConfig({}, 4)?.defaultProjectId).toBeNull()
  })

  // Fails if a damaged record throws instead of degrading — the row is read on
  // every load, so a throw here would take the whole workspace load with it.
  it("returns null only for a non-object and defaults the rest", () => {
    expect(parseSiteConfig(null, 4)).toBeNull()
    expect(parseSiteConfig("nope", 4)).toBeNull()
    expect(parseSiteConfig(undefined, 4)).toBeNull()
    expect(parseSiteConfig([], 4)?.defaultProjectId).toBeNull()
  })
})

/// The trap the brief calls out explicitly: "an added table without a version
/// bump silently does not exist". These assertions read the DECLARED schema, so
/// a table that is edited out of `stores()` (or a version never bumped) fails
/// here instead of quietly reading `null` forever — which is indistinguishable
/// from the bug this module fixes.
describe("site config schema", () => {
  it("is at version 2, with config, servers and sessions declared", () => {
    expect(db.verno).toBe(2)
    expect(db.tables.map((table) => table.name).sort()).toEqual(["config", "servers", "sessions"])
  })

  it("keys saved servers by address and kept sessions by server", () => {
    expect(db.table("servers").schema.primKey.keyPath).toBe("url")
    expect(db.table("sessions").schema.primKey.keyPath).toBe("server")
  })

  it("keys the config table by userId", () => {
    expect(db.table("config").schema.primKey.keyPath).toBe("userId")
  })
})
