import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { resetConfigCache } from "@/lib/config"
import {
  createSessionToken,
  resetSessionSecretCache,
  verifySessionToken,
} from "@/lib/auth/session"
import { upsertUser } from "@/lib/auth/users"
import { users } from "@/lib/db/schema"
import { setupTestDb } from "./helpers"

/**
 * Regression tests: SESSION_SECRET fallback hardening and concurrent
 * first-login provisioning (upsertUser insert race).
 */

beforeEach(() => {
  resetConfigCache()
  resetSessionSecretCache()
})

afterEach(() => {
  vi.restoreAllMocks()
})

const TEST_CLAIMS = {
  uid: 1,
  sub: "user-1",
  iss: "https://issuer.example.com",
  name: "Test User",
  email: "user-1@example.com",
}

describe("session secret fallback", () => {
  const ORIG_SECRET = process.env.SESSION_SECRET
  const ORIG_CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET

  afterEach(() => {
    process.env.SESSION_SECRET = ORIG_SECRET
    process.env.OIDC_CLIENT_SECRET = ORIG_CLIENT_SECRET
    resetConfigCache()
    resetSessionSecretCache()
  })

  it("uses a dedicated SESSION_SECRET when set", async () => {
    const token = await createSessionToken(TEST_CLAIMS)
    const claims = await verifySessionToken(token)
    expect(claims).not.toBeNull()
    expect(claims!.uid).toBe(1)
  })

  it("rejects a short OIDC_CLIENT_SECRET fallback instead of weakening HS256", async () => {
    delete process.env.SESSION_SECRET
    process.env.OIDC_CLIENT_SECRET = "short-secret"
    resetConfigCache()
    resetSessionSecretCache()
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    await expect(createSessionToken(TEST_CLAIMS)).rejects.toThrow(
      /SESSION_SECRET/
    )
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it("falls back to a long-enough OIDC_CLIENT_SECRET with a warning", async () => {
    delete process.env.SESSION_SECRET
    process.env.OIDC_CLIENT_SECRET = "fallback-client-secret-0123456789abcdef"
    resetConfigCache()
    resetSessionSecretCache()
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const token = await createSessionToken(TEST_CLAIMS)
    const claims = await verifySessionToken(token)
    expect(claims).not.toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("SESSION_SECRET unset")
    )
  })
})

describe("upsertUser concurrency", () => {
  let db: ReturnType<typeof setupTestDb>["db"]
  beforeEach(() => {
    ;({ db } = setupTestDb())
  })

  it("provisions on first login and is stable across repeats", () => {
    const claims = {
      issuer: "https://issuer.example.com",
      subject: "race-user",
      name: "Race User",
      email: "race@example.com",
    }
    const first = upsertUser(claims)
    const second = upsertUser(claims)
    expect(second.id).toBe(first.id)
    expect(second.email).toBe("race@example.com")
  })

  it("recovers when the insert lost the race (row created concurrently)", () => {
    const claims = {
      issuer: "https://issuer.example.com",
      subject: "race-user-2",
      name: "Race User 2",
      email: "race2@example.com",
    }
    // Simulate the interleaving: the concurrent winner committed its row
    // between our pre-check (misses) and our insert (conflicts). The
    // conflict path must re-read the winner's row instead of throwing.
    const winner = db
      .insert(users)
      .values({
        issuer: claims.issuer,
        subject: claims.subject,
        name: "Stale Name",
        email: "stale@example.com",
        createdAt: new Date().toISOString(),
      })
      .returning()
      .get()

    const dbAny = db as unknown as {
      select: (...args: unknown[]) => unknown
    }
    const realSelect = dbAny.select.bind(db)
    let firstCall = true
    vi.spyOn(dbAny, "select").mockImplementation((...args: unknown[]) => {
      if (firstCall) {
        firstCall = false
        // the pre-check runs before the winner commits → no user yet
        return {
          from: () => ({
            where: () => ({ get: () => undefined }),
          }),
        }
      }
      return realSelect(...args)
    })

    const raced = upsertUser(claims)
    expect(raced.id).toBe(winner.id)
    // profile updates from claims are applied on the re-read path too
    expect(raced.name).toBe("Race User 2")
    expect(raced.email).toBe("race2@example.com")
  })
})
