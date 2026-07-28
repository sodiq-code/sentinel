/**
 * Sentinel — public entry point.
 *
 * Re-exports the stable interfaces from each module. Phase 0 only ships
 * the contracts; later phases fill the implementations.
 *
 * PDF §9.4.1 component breakdown.
 */
export * from './types';
export * from './orchestrator';
export * from './guardrail';
export * from './connectors/github';
export * from './connectors/slack';
export * from './writeback/ingester';
export * from './audit';
export * from './demo_driver';
