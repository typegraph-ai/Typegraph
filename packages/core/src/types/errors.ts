/**
 * Typed error classes for the d8um SDK.
 * These allow consumers to distinguish expected errors (not found, config)
 * from unexpected crashes without string-matching error messages.
 */

export class D8umError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusHint: number = 500,
  ) {
    super(message)
    this.name = 'D8umError'
  }
}

export class NotFoundError extends D8umError {
  constructor(resource: string, id: string) {
    super(`${resource} "${id}" not found`, 'NOT_FOUND', 404)
    this.name = 'NotFoundError'
  }
}

export class NotInitializedError extends D8umError {
  constructor() {
    super(
      'd8um not initialized. Call d8um.initialize(...) first.',
      'NOT_INITIALIZED',
      500,
    )
    this.name = 'NotInitializedError'
  }
}

export class ConfigError extends D8umError {
  constructor(message: string) {
    super(message, 'CONFIG_ERROR', 400)
    this.name = 'ConfigError'
  }
}
