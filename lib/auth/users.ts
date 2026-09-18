import { and, eq } from "drizzle-orm"
import { getDb } from "@/lib/db"
import { users } from "@/lib/db/schema"

export interface DbUser {
  id: number
  issuer: string
  subject: string
  name: string
  email: string
  createdAt: string
}

/**
 * JIT-provisioned users: every identity your OIDC provider lets through gets
 * a workspace on first login. Keyed on (issuer, subject) — the stable pair.
 */
export function upsertUser(claims: {
  issuer: string
  subject: string
  name: string
  email: string
}): DbUser {
  const db = getDb()
  const existing = db
    .select()
    .from(users)
    .where(
      and(eq(users.issuer, claims.issuer), eq(users.subject, claims.subject))
    )
    .get()
  const now = new Date().toISOString()
  if (existing) {
    if (existing.name !== claims.name || existing.email !== claims.email) {
      db.update(users)
        .set({ name: claims.name, email: claims.email })
        .where(eq(users.id, existing.id))
        .run()
      return { ...existing, name: claims.name, email: claims.email }
    }
    return existing
  }
  const inserted = db
    .insert(users)
    .values({
      issuer: claims.issuer,
      subject: claims.subject,
      name: claims.name,
      email: claims.email,
      createdAt: now,
    })
    .returning()
    .get()
  if (!inserted) {
    throw new Error("could not provision user")
  }
  return inserted
}

export function findUserById(id: number): DbUser | null {
  const db = getDb()
  const user = db.select().from(users).where(eq(users.id, id)).get()
  return user ?? null
}
