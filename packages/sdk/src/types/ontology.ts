export type OntologyProfile =
  | 'general'
  | 'literary'
  | 'medical'
  | 'legal'
  | 'saas'

export interface OntologyEntityConfig {
  extends?: string | undefined
  description?: string | undefined
  vocabulary?: OntologyVocabularyRef[] | undefined
  metadata?: Record<string, unknown> | undefined
}

export interface OntologyRelationConfig {
  from?: string[] | undefined
  to?: string[] | undefined
  aliases?: string[] | undefined
  symmetric?: boolean | undefined
  inverse?: string | undefined
  description?: string | undefined
  vocabulary?: OntologyVocabularyRef[] | undefined
  metadata?: Record<string, unknown> | undefined
}

export type OntologyVocabularyMatch =
  | 'exact'
  | 'close'
  | 'broad'
  | 'narrow'
  | 'related'
  | 'inspired_by'

export interface OntologyVocabularyRef {
  vocabulary: string
  id?: string | undefined
  uri?: string | undefined
  label?: string | undefined
  match?: OntologyVocabularyMatch | undefined
}

export interface OntologyResolutionConfig {
  /** Extra aliases that should never be treated as useful aliases for entity resolution. */
  genericAliasBlocklist?: string[] | undefined
  /** Entity types where comma/"and" peer lists should be split into individual entities. */
  coordinateEntityTypes?: string[] | undefined
  /** Known peer names that should be split when a model emits "A, B" as one entity. */
  coordinatePeerNames?: string[] | undefined
  /** Known location qualifiers that should preserve "City, State/Country" as one entity. */
  qualifiedPlaceSecondParts?: string[] | undefined
}

export interface OntologyPromptConfig {
  entityGuidelines?: string[] | undefined
  relationGuidelines?: string[] | undefined
}

export interface OntologyConfig {
  version: string
  mode?: 'extend' | 'strict' | undefined
  profiles?: OntologyProfile[] | undefined
  entities?: Record<string, OntologyEntityConfig> | undefined
  relations?: Record<string, OntologyRelationConfig> | undefined
  resolution?: OntologyResolutionConfig | undefined
  prompt?: OntologyPromptConfig | undefined
  metadata?: Record<string, unknown> | undefined
}

export interface CompiledOntology {
  version: string
  hash: string
  config: OntologyConfig
  profiles: OntologyProfile[]
  entityTypes: string[]
  relationNames: string[]
  relationAliases: Record<string, string>
  vocabulary: {
    entities: Record<string, OntologyVocabularyRef[]>
    relations: Record<string, OntologyVocabularyRef[]>
  }
  resolution: Required<OntologyResolutionConfig>
  prompt: Required<OntologyPromptConfig>
  compiledAt: Date
}
