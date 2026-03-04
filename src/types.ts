export type ScopeType = "global" | "project" | "session";

export interface ScopeRef {
  type: ScopeType;
  id?: string;
}

export type ScopeSelector = ScopeRef;

export interface MemoryItem {
  id: string;
  scope: ScopeRef;
  content: string;
  tags: string[];
  importance: number;
  created_at: string;
  updated_at: string;
  expires_at?: string;
  source_agent?: string;
  metadata?: Record<string, unknown>;
}

export interface RankedMemoryItem extends MemoryItem {
  score: number;
}

export interface UpsertInput {
  idempotency_key?: string;
  scope: ScopeRef;
  content: string;
  tags?: string[];
  importance?: number;
  ttl_days?: number;
  metadata?: Record<string, unknown>;
}

export interface SearchInput {
  query: string;
  scopes?: ScopeSelector[];
  limit?: number;
  min_score?: number;
  include_metadata?: boolean;
  max_content_chars?: number;
  max_response_bytes?: number;
}

export interface GetContextInput {
  query: string;
  project_path?: string;
  session_id?: string;
  max_items?: number;
  token_budget?: number;
}

export interface CaptureInput {
  scope: ScopeRef;
  raw_text: string;
  summary_hint?: string;
  tags?: string[];
  max_facts?: number;
}

export interface ScopeMatch {
  clauses: string;
  params: string[];
}
