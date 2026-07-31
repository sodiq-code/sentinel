/**
 * Sentinel — public entry point.
 *
 * Re-exports the stable interfaces from each module. Ships the stable
 * contract surface; implementations are filled in across the modules.
 */
export * from './types';
export * from './orchestrator';
export * from './guardrail';
export * from './connectors/github';
export * from './connectors/slack';
export * from './writeback/ingester';
export * from './audit';
export * from './demo_driver';
