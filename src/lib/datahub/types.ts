// =============================================================================
// Sentinel — DataHub domain types
//
// Phase 1 (PDF §10.3 / v2 plan §"Phase 1 — DataHub Mock + Seed")
//
// These types are the shared vocabulary between the three DataHub client
// interfaces (McpClient, ContextKitClient, IngestionClient) and the Sentinel
// orchestrator. They are deliberately framework-agnostic — both the mock
// (Prisma SQLite) and the live (HTTP / GraphQL) implementations return these
// exact shapes so the orchestrator is identical in demo and live mode.
//
// URN format follows DataHub's convention:
//   urn:li:dataset:(urn:li:dataPlatform:<platform>,<name>,<env>)
//   urn:li:corpUser:<username>
//   urn:li:glossaryTerm:<term-name>
//   urn:li:domain:<domain-name>
//   urn:li:dataFlow:(urn:li:dataPlatform:<platform>,<flowId>,<env>)
//   urn:li:dataJob:(urn:li:dataPlatform:<platform>,<jobId>,<env>)
//
// All types are `export`ed so the live implementations and the orchestrator
// can compose them.
// =============================================================================

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** A DataHub URN. We keep it as a branded string alias for readability. */
export type Urn = string

/** A DataHub data platform id (e.g. `s3`, `spark`, `dbt`, `snowflake`, `looker`). */
export type Platform = string

/** Entity type as DataHub classifies it. */
export type EntityType =
  | 'dataset'
  | 'chart'
  | 'dashboard'
  | 'dataFlow'
  | 'dataJob'
  | 'container'
  | 'domain'
  | 'glossaryTerm'
  | 'corpUser'

// ---------------------------------------------------------------------------
// Users / ownership
// ---------------------------------------------------------------------------

export interface User {
  urn: Urn
  name: string
  email?: string
  title?: string
}

export interface OwnerInput {
  ownerUrn: Urn
  ownerType: 'USER' | 'GROUP' | 'CORP_GROUP'
  name?: string
}

/** An owner as resolved from a DataHub entity (same shape as the input). */
export type Owner = OwnerInput

// ---------------------------------------------------------------------------
// Entities (the read model)
// ---------------------------------------------------------------------------

export interface GovernanceTag {
  name: string
  level: 'CLASSIFICATION' | 'PROPAGATED' | 'GLOBAL'
  urn?: Urn
}

export interface GlossaryTermRef {
  urn: Urn
  name: string
  description?: string
}

export interface SchemaField {
  name: string
  type: string
  nullable: boolean
  description?: string
  nativeDataType?: string
  isPrimaryKey?: boolean
  foreignKeyUrn?: Urn
}

/** A DataHub entity (dataset / chart / dashboard / dataFlow / dataJob / ...). */
export interface Entity {
  urn: Urn
  name: string
  type: EntityType
  platform?: Platform
  description?: string
  owners: Owner[]
  glossaryTerms: GlossaryTermRef[]
  governanceTags: GovernanceTag[]
  schemaFields: SchemaField[]
  lastModifiedAt?: number
  platformNativeName?: string
  domainUrn?: Urn
  scenarioId?: string
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchOpts {
  filterType?: EntityType
  filterPlatform?: Platform
  start?: number
  count?: number
}

export interface SearchResult {
  urn: Urn
  name: string
  type: EntityType
  platform?: Platform
  description?: string
  snippet?: string
}

// ---------------------------------------------------------------------------
// Lineage
// ---------------------------------------------------------------------------

export interface LineageOpts {
  maxHops?: number
  includePaths?: boolean
}

export interface LineageNode {
  urn: Urn
  name: string
  type: EntityType
  platform?: Platform
  via?: Urn
  degree: number
}

export interface Lineage {
  urn: Urn
  direction: 'upstream' | 'downstream'
  nodes: LineageNode[]
}

export interface LineagePathEdge {
  fromUrn: Urn
  toUrn: Urn
  via?: Urn
}

export interface LineagePath {
  fromUrn: Urn
  toUrn: Urn
  path: Urn[]
  edges: LineagePathEdge[]
}

// ---------------------------------------------------------------------------
// Documents (Agent Context Kit / DataHub's docs layer)
// ---------------------------------------------------------------------------

export interface DocSearchOpts {
  assetUrn?: Urn
  start?: number
  count?: number
}

export interface DocSearchResult {
  urn: Urn
  title: string
  snippet: string
  assetUrn?: Urn
  authorName?: string
  createdAt?: string
}

export interface GrepOpts {
  assetUrn?: Urn
  caseSensitive?: boolean
}

export interface DocGrepResult {
  urn: Urn
  title: string
  matchedLine: string
  lineNumber: number
  assetUrn?: Urn
}

// ---------------------------------------------------------------------------
// Dataset queries (the SQL/Spark/dbt that materialised a dataset)
// ---------------------------------------------------------------------------

export interface QueryOpts {
  limit?: number
}

export interface DatasetQuery {
  urn: Urn
  query: string
  queryType: 'SQL' | 'SPARK' | 'DBT' | 'PYTHON'
  submittedAt: string
  durationMs?: number
  rowsReturned?: number
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export interface LifecycleStage {
  urn: Urn
  name: string
  description?: string
}

// ---------------------------------------------------------------------------
// Glossary
// ---------------------------------------------------------------------------

export interface GlossaryVersion {
  version: string
  name: string
  description: string
  createdAt: string
  authorUrn?: Urn
}

export interface GlossaryDiff {
  field: 'name' | 'description'
  fromVersion: string
  toVersion: string
  oldValue: string
  newValue: string
}

// ---------------------------------------------------------------------------
// Agent Context Kit — write tools (mutations)
// ---------------------------------------------------------------------------

export interface SaveDocumentInput {
  assetUrn: Urn
  title: string
  content: string
  format?: 'markdown' | 'html' | 'plaintext'
  authorUrn?: Urn
  sentinelPostMortem?: boolean
}

// ---------------------------------------------------------------------------
// Ingestion — REST fallback (PDF §12.2 dual write-back path)
// ---------------------------------------------------------------------------

export interface GraphQlProposal {
  mutation: string
  variables: Record<string, unknown>
}

export interface Patch {
  op: 'add' | 'replace' | 'remove'
  path: string
  value?: unknown
}

export type AssertionType = 'freshness' | 'schema' | 'quality' | 'custom'

export interface AssertionInput {
  assetUrn: Urn
  type: AssertionType
  description: string
  slaSeconds?: number
  datasetField?: string
}

export interface AssertionRecord {
  urn: Urn
  assetUrn: Urn
  type: AssertionType
  status: 'passing' | 'failing' | 'error'
  description: string
  slaSeconds?: number
  lastEvaluatedAt: string
  lastSuccessAt?: string
  failureReason?: string
  scenarioId?: string
}

// ---------------------------------------------------------------------------
// The three client interfaces.
// ---------------------------------------------------------------------------

export interface McpClient {
  search(query: string, opts?: SearchOpts): Promise<SearchResult[]>
  get_entities(urns: Urn[]): Promise<Entity[]>
  list_schema_fields(urn: Urn, opts?: { keywords?: string }): Promise<SchemaField[]>
  get_me(): Promise<User>
  get_lineage(
    urn: Urn,
    direction: 'upstream' | 'downstream',
    opts?: LineageOpts,
  ): Promise<Lineage>
  get_lineage_paths_between(fromUrn: Urn, toUrn: Urn): Promise<LineagePath[]>
  search_documents(query: string, opts?: DocSearchOpts): Promise<DocSearchResult[]>
  grep_documents(pattern: string, opts?: GrepOpts): Promise<DocGrepResult[]>
  get_dataset_queries(urn: Urn, opts?: QueryOpts): Promise<DatasetQuery[]>
  list_lifecycle_stages(): Promise<LifecycleStage[]>
  get_glossary_term_versions(urn: Urn): Promise<GlossaryVersion[]>
  compare_glossary_term_versions(
    urn: Urn,
    v1: string,
    v2: string,
  ): Promise<GlossaryDiff[]>
}

export interface ContextKitClient {
  save_document(input: SaveDocumentInput): Promise<{ urn: Urn }>
  add_tags(urn: Urn, tags: string[]): Promise<void>
  remove_tags(urn: Urn, tags: string[]): Promise<void>
  update_description(urn: Urn, description: string): Promise<void>
  add_glossary_terms(urn: Urn, termUrns: Urn[]): Promise<void>
  remove_glossary_terms(urn: Urn, termUrns: Urn[]): Promise<void>
  set_domains(urn: Urn, domainUrns: Urn[]): Promise<void>
  add_owners(urn: Urn, owners: OwnerInput[]): Promise<void>
}

export interface IngestionClient {
  ingestProposal(proposal: GraphQlProposal): Promise<{ urn: Urn }>
  patchEntity(urn: Urn, patch: Patch): Promise<void>
  createAssertion(input: AssertionInput): Promise<{ urn: Urn }>
}

/** Convenience bundle returned by the factory in `src/lib/datahub/index.ts`. */
export interface DataHubClients {
  mcp: McpClient
  contextKit: ContextKitClient
  ingestion: IngestionClient
  mode: 'demo' | 'live'
}
