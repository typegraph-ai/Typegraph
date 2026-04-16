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
