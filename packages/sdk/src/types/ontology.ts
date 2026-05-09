export interface OntologyEntityConfig {
  extends?: string | undefined
  description?: string | undefined
  metadata?: Record<string, unknown> | undefined
}

export interface OntologyRelationConfig {
  from?: string[] | undefined
  to?: string[] | undefined
  description?: string | undefined
  metadata?: Record<string, unknown> | undefined
}

export interface OntologyConfig {
  version: string
  presets?: string[] | undefined
  entities?: Record<string, OntologyEntityConfig> | undefined
  relations?: Record<string, OntologyRelationConfig> | undefined
  metadata?: Record<string, unknown> | undefined
}

export interface CompiledOntology {
  version: string
  hash: string
  config: OntologyConfig
  compiledAt: Date
}
