/**
 * Sentinel — Audit log.
 *
 * PDF §9.4.1 + §9.3.5 + §9.4.3.
 *
 * Responsibilities:
 *  - Persist every tool call, every action, every write-back
 *  - Local SQLite (via Prisma — see `prisma/schema.prisma` AuditEvent table)
 *    + mirrored as a DataHub Assertion/Event (PDF §9.3.5: 'SQLite + mirrored
 *    as DataHub Assertion/Event as a mirror')
 *  - Immutable — append-only
 *
 * The Prisma schema (Phase 0 deliverable below) defines the AuditEvent table.
 * Phase 2 wires this to Prisma.
 *
 * Phase 0: interface + the AuditEvent kind enum. Phase 2 implementation.
 */

import type { AuditEvent, AuditEventKind } from './types';

/** Public interface — see `orchestrator.ts`. */
export interface AuditLog {
  record(event: {
    incidentUrn: string;
    kind: AuditEventKind;
    summary: string;
    payload?: unknown;
  }): Promise<void>;
  /** Read back the audit trail for an incident (for the UI drawer, Phase 5). */
  list(incidentUrn: string): Promise<AuditEvent[]>;
}

/**
 * Phase 0 placeholder. Phase 2 wires this to the Prisma `AuditEvent` model
 * (see `prisma/schema.prisma`). Every event is also mirrored as a DataHub
 * Assertion/Event in live mode.
 */
export class PrismaAuditLog implements AuditLog {
  async record(_event: {
    incidentUrn: string;
    kind: AuditEventKind;
    summary: string;
    payload?: unknown;
  }): Promise<void> {
    throw new Error(
      'PrismaAuditLog.record is a Phase 2 deliverable. ' +
        'Phase 0 ships the interface + the Prisma schema (prisma/schema.prisma).',
    );
  }

  async list(_incidentUrn: string): Promise<AuditEvent[]> {
    throw new Error('Phase 2 deliverable');
  }
}

export { type AuditEvent, type AuditEventKind };
