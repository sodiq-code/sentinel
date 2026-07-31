/**
 * Sentinel — Demo driver.
 *
 * Deterministic assertion setup.
 *
 * Responsibilities:
 *  - Inject a freshness failure into the nyc-taxi dataset for the demo
 *  - Explicitly create the assertion against the nyc-taxi downstream table
 *    on setup so the failure is DETERMINISTIC and reproducible
 *    ('nyc-taxi planted freshness issue may not auto-fire — DemoDriver
 *    creates the assertion explicitly')
 *  - Replay the loop (Run 1 → Run 2 reads Run 1's post-mortem — the
 *    compounding beat)
 *  - Dry-run mode: pre-recorded tool-call trace replayed through the SAME
 *    console UI so viewers see the same surface
 *
 * Interface + the scenario catalogue.
 */

export type DemoScenarioId =
  | 'nyc-taxi-freshness' // main scenario
  | 'showcase-ecommerce-schema' // second scenario
  | 'customer-pii-refusal'; // governance refusal beat

export interface DemoScenario {
  id: DemoScenarioId;
  title: string;
  /** The beat that maps to this scenario (for the shot-list overlay). */
  beat: string;
  /** The planted-assertion URN that fires. */
  assertionUrn: string;
  /** The failing asset URN. */
  assetUrn: string;
  /** The signal type. */
  type: 'freshness' | 'schema' | 'quality' | 'pii';
  /** The persona (beat 0:10–0:25). */
  persona: { name: string; role: string; avatar?: string };
}

/** The catalogue — seeds the Prisma fixtures with these. */
export const DEMO_SCENARIOS: Record<DemoScenarioId, DemoScenario> = {
  'nyc-taxi-freshness': {
    id: 'nyc-taxi-freshness',
    title: 'NYC Taxi — freshness SLA breach',
    beat: '0:25–0:45 — signal fires',
    assertionUrn: 'urn:li:assertion:nyc-taxi-freshness-15m',
    assetUrn: 'urn:li:dataset:(urn:li:dataPlatform:dbt,nyc_yellow_taxi_trips,PROD)',
    type: 'freshness',
    persona: { name: 'Priya Patel', role: 'On-call data engineer' },
  },
  'showcase-ecommerce-schema': {
    id: 'showcase-ecommerce-schema',
    title: 'Showcase E-commerce — schema breakage on cross-platform lineage',
    beat: '0:45–1:30 — Sentinel investigates (scenario 2)',
    assertionUrn: 'urn:li:assertion:ecommerce-schema-orders',
    assetUrn: 'urn:li:dataset:(urn:li:dataPlatform:snowflake,raw_orders,PROD)',
    type: 'schema',
    persona: { name: 'Marcus Chen', role: 'Data platform lead' },
  },
  'customer-pii-refusal': {
    id: 'customer-pii-refusal',
    title: 'Customer PII — governance refusal beat',
    beat: '2:00–2:20 — governance refusal',
    assertionUrn: 'urn:li:assertion:pii-quality-check',
    assetUrn: 'urn:li:dataset:(urn:li:dataPlatform:snowflake,customer_pii,PROD)',
    type: 'pii',
    persona: { name: 'Priya Patel', role: 'On-call data engineer' },
  },
};

/** Public interface. */
export interface DemoDriver {
  /** Set up the scenario: explicitly create the assertion so the failure
   *  is deterministic. */
  setup(scenario: DemoScenarioId): Promise<{ assertionUrn: string; assetUrn: string }>;
  /** Inject the failing signal — fires the assertion. */
  inject(scenario: DemoScenarioId): Promise<{ signalId: string; assertionUrn: string }>;
  /** Replay the loop for the compounding demo (Run 1 → Run 2). */
  replay(scenario: DemoScenarioId, runs: number): Promise<{ run1: unknown; run2: unknown }>;
  /** Dry-run mode — pre-recorded trace replayed through the same UI. */
  dryRun(scenario: DemoScenarioId): Promise<{ trace: unknown[] }>;
}

/**
 * Wires to the Orchestrator + the seeded fixtures.
 */
export class SentinelDemoDriver implements DemoDriver {
  async setup(_scenario: DemoScenarioId): Promise<{ assertionUrn: string; assetUrn: string }> {
    throw new Error(
      'SentinelDemoDriver is not implemented. ' +
        'The scenario catalogue ships as the stable contract.',
    );
  }
  async inject(_scenario: DemoScenarioId): Promise<{ signalId: string; assertionUrn: string }> {
    throw new Error('Not implemented');
  }
  async replay(_scenario: DemoScenarioId, _runs: number): Promise<{ run1: unknown; run2: unknown }> {
    throw new Error('Not implemented');
  }
  async dryRun(_scenario: DemoScenarioId): Promise<{ trace: unknown[] }> {
    throw new Error('Not implemented');
  }
}

export { type DemoScenario };
