/**
 * Typed error classes for the typegraph SDK.
 * These allow consumers to distinguish expected errors (not found, config)
 * from unexpected crashes without string-matching error messages.
 */

export class TypegraphError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusHint: number = 500,
  ) {
    super(message)
    this.name = 'TypegraphError'
  }
}

export class NotFoundError extends TypegraphError {
  constructor(resource: string, id: string) {
    super(`${resource} "${id}" not found`, 'NOT_FOUND', 404)
    this.name = 'NotFoundError'
  }
}

export class NotInitializedError extends TypegraphError {
  constructor() {
    super(
      'typegraph not initialized. Call typegraph.initialize(...) first.',
      'NOT_INITIALIZED',
      500,
    )
    this.name = 'NotInitializedError'
  }
}

export class ConfigError extends TypegraphError {
  constructor(message: string) {
    super(message, 'CONFIG_ERROR', 400)
    this.name = 'ConfigError'
  }
}

export interface GraphSelfEdgeErrorDetails {
  entityId: string
  entityName?: string | undefined
  relation: string
  sourceRef?: unknown
  targetRef?: unknown
}

export class GraphSelfEdgeError extends TypegraphError {
  public readonly entityId: string
  public readonly entityName?: string | undefined
  public readonly relation: string
  public readonly sourceRef?: unknown
  public readonly targetRef?: unknown

  constructor(details: GraphSelfEdgeErrorDetails) {
    super(
      `Refusing to create self-edge for entity ${details.entityId}`,
      'GRAPH_SELF_EDGE',
      400,
    )
    this.name = 'GraphSelfEdgeError'
    this.entityId = details.entityId
    this.entityName = details.entityName
    this.relation = details.relation
    this.sourceRef = details.sourceRef
    this.targetRef = details.targetRef
  }
}
