/** Pagination options for list operations. */
export interface PaginationOpts {
  /** Maximum number of items to return. Default: 100. */
  limit?: number | undefined
  /** Number of items to skip. Default: 0. */
  offset?: number | undefined
}

/** Paginated result set. */
export interface PaginatedResult<T> {
  items: T[]
  total: number
  limit: number
  offset: number
}
