export const platforms = ['android', 'ios', 'web'] as const;
export const environments = ['release', 'cug'] as const;
export const modes = ['exact-key', 'exact-path', 'partial'] as const;
export type Platform = typeof platforms[number];
export type Environment = typeof environments[number];
export type SearchMode = typeof modes[number];
export type Path = (string | number)[];
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type StaticValue =
  | { type: 'null' | 'boolean' | 'number' | 'string'; value: null | boolean | number | string }
  | { type: 'array'; items: StaticValue[] }
  | { type: 'object'; entries: Record<string, StaticValue> }
  | { type: 'unresolved'; expression: string; syntax: 'javascript' | 'config-reader'; literal?: Json }
  | { type: 'hole' };

export interface Client { clientId: string; platform: Platform }
export interface Target extends Client { id: string; environment: Environment; mjosUrl: string }
export interface ConfigurationRef {
  owner: string;
  version: string;
  normalizedUrl: string;
  originalUrls: string[];
}
export interface CacheMetadata {
  fetchedAt: string;
  checkedAt: string;
  etag?: string;
  lastModified?: string;
}
export interface MjosRecord extends Target, CacheMetadata {
  mjos: Record<string, Json>;
  refs: ConfigurationRef[];
  fallbackRefs?: ConfigurationRef[];
}
export interface ConfigRecord extends CacheMetadata {
  url: string;
  hash: string;
  tree: StaticValue;
  structuralWarnings: number;
}
export interface Failure {
  stage: 'csv' | 'mjos' | 'url' | 'fetch' | 'parse' | 'index';
  message: string;
  targetId?: string;
  url?: string;
}
export interface Coverage {
  clientPlatforms: number;
  targets: number;
  current: number;
  stale: number;
  partial: number;
  unavailable: number;
  configs: number;
  parsed: number;
  unresolved: number;
  failures: number;
}
export const emptyCoverage: Coverage = {
  clientPlatforms: 0, targets: 0, current: 0, stale: 0, partial: 0,
  unavailable: 0, configs: 0, parsed: 0, unresolved: 0, failures: 0
};
export interface Progress {
  phase: 'mjos' | 'hyperpay-config' | 'indexing';
  completed: number;
  total: number;
}
export interface Status {
  state: 'idle' | 'refreshing' | 'ready' | 'partial' | 'failed';
  lastSuccessfulRefresh: string | null;
  lastAttempt: string | null;
  indexVersion: string | null;
  coverage: Coverage;
  progress: Progress | null;
  error: string | null;
  catalogSize: number;
  knownSize: number;
  localMode: boolean;
}
export interface CatalogEntry {
  key: string;
  path: string;
  category: string;
  types: StaticValue['type'][];
  source: 'repository' | 'observed' | 'both';
  description?: string;
  defaultValue?: Json;
  aliases?: string[];
  deprecated?: boolean;
}
export const sortFields = ['clientId', 'platform', 'environment', 'path', 'hyperpayConfigUrl'] as const;
export type SortField = typeof sortFields[number];
export interface SearchQuery {
  query: string;
  mode: SearchMode;
  platforms: Platform[];
  environments: Environment[];
  clientIds: string[];
  valueFilter?: Json;
  includeValues: boolean;
  page: number;
  pageSize: number;
  sort: SortField;
  direction: 'asc' | 'desc';
}
export interface Counts { clients: number; clientPlatforms: number; targets: number; occurrences: number }
export interface SearchResult {
  id: string;
  clientId: string;
  platform: Platform;
  environment: Environment;
  key: string;
  path: string;
  valueType: StaticValue['type'];
  preview?: string;
  owner: string;
  version: string;
  hyperpayConfigUrl: string;
  stale: boolean;
}
export interface ResultDetail extends SearchResult {
  value: string;
  mjosUrl: string;
  originalUrls: string[];
  fetchedAt: string;
  checkedAt: string;
}
export interface SearchResponse {
  results: SearchResult[];
  counts: Counts;
  page: number;
  pageSize: number;
  indexVersion: string | null;
  coverage: Coverage;
}
