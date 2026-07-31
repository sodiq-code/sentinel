/**
 * Sentinel — Audit log.
 *
 * Responsibilities:
 *  - Persist every tool call, every action, every write-back
 *  - Local SQLite (via Prisma — see `prisma/schema.prisma` AuditEvent table)
 *    + mirrored as a DataHub Assertion/Event ('SQLite + mirrored
 *    as DataHub Assertion/Event as a mirror')
 *  - Immutable — append-only
 *
 * The Prisma schema (see `prisma/schema.prisma`) defines the AuditEvent table.
 *
 * Interface + the AuditEvent kind enum.
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
  /** Read back the audit trail for an incident (for the UI drawer). */
  list(incidentUrn: string): Promise<AuditEvent[]>;
}

/**
 * Wires to the Prisma `AuditEvent` model (see `prisma/schema.prisma`). Every
 * event is also mirrored as a DataHub Assertion/Event in live mode.
 */
export class PrismaAuditLog implements AuditLog {
  async record(_event: {
    incidentUrn: string;
    kind: AuditEventKind;
    summary: string;
    payload?: unknown;
  }): Promise<void> {
    throw new Error(
      'PrismaAuditLog.record is not implemented. ' +
        'The interface + the Prisma schema (prisma/schema.prisma) ship as the stable contract.',
    );
  }

  async list(_incidentUrn: string): Promise<AuditEvent[]> {
    throw new Error('Not implemented');
  }
}

export { type AuditEvent, type AuditEventKind };
