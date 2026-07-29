// =============================================================================
// Sentinel — Prisma client (dual mode: Turso / SQLite)
//
// Routing:
//   - DATABASE_URL=libsql://...  → Turso via @prisma/adapter-libsql (Vercel)
//   - DATABASE_URL=file:...       → local SQLite (local dev, no network)
//
// The Turso path keeps the deployed Sentinel dashboard stateful across
// Vercel cold starts — every incident, tool call, write-back, and audit
// event persists in a real managed SQLite (libSQL) database on AWS us-east-1.
// The local SQLite path stays instant in local dev (no network round-trip).
// =============================================================================

import { PrismaClient } from '@prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

function createPrismaClient(): PrismaClient {
  const url = process.env.DATABASE_URL ?? ''

  // Turso (libsql:// URL) → route through the libSQL driver adapter.
  // libsql:// is wire-compatible with SQLite but lives on a managed server,
  // so Prisma talks HTTP/WS to it instead of opening a local file.
  if (url.startsWith('libsql:') || url.startsWith('libsqls:')) {
    const adapter = new PrismaLibSql({
      url,
      authToken: process.env.DATABASE_AUTH_TOKEN,
    })
    return new PrismaClient({ adapter, log: ['error', 'warn'] })
  }

  // Local SQLite file → direct driver (no adapter, no network).
  return new PrismaClient({ log: ['error', 'warn'] })
}

export const db = globalForPrisma.prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
