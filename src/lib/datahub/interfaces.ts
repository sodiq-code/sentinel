// =============================================================================
// Sentinel — DataHub client interfaces (barrel)
//
// Phase 1 (PDF §10.3 / v2 plan §"Phase 1")
//
// The three interfaces live in `./types` next to their DTOs. This file is a
// convenience barrel so callers can write:
//
//   import { McpClient, ContextKitClient, IngestionClient } from '@/lib/datahub/interfaces'
//
// instead of pulling from `./types`. It also documents the exact tool surface
// verified against the DataHub MCP docs and the Agent Context Kit docs.
// =============================================================================

export type {
  McpClient,
  ContextKitClient,
  IngestionClient,
  DataHubClients,
  // DTOs
  Urn,
  Platform,
  EntityType,
  User,
  OwnerInput,
  Owner,
  GovernanceTag,
  GlossaryTermRef,
  SchemaField,
  Entity,
  SearchOpts,
  SearchResult,
  LineageOpts,
  LineageNode,
  Lineage,
  LineagePathEdge,
  LineagePath,
  DocSearchOpts,
  DocSearchResult,
  GrepOpts,
  DocGrepResult,
  QueryOpts,
  DatasetQuery,
  LifecycleStage,
  GlossaryVersion,
  GlossaryDiff,
  SaveDocumentInput,
  GraphQlProposal,
  Patch,
  AssertionType,
  AssertionInput,
  AssertionRecord,
} from './types'
