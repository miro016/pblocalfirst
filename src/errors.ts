import { ClientResponseError } from 'pocketbase'

/**
 * Error thrown when a filter/sort/expand expression cannot be evaluated
 * locally (syntax error, unsupported server-side macro, missing relation
 * configuration, ...). These indicate a configuration or query problem —
 * never a data problem.
 */
export class QueryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QueryError'
  }
}

/**
 * 404 error with the same shape the PocketBase JS SDK throws, so code that
 * catches `ClientResponseError` keeps working when a query is served from
 * the local cache.
 */
export function notFoundError(url = ''): ClientResponseError {
  return new ClientResponseError({
    url,
    status: 404,
    response: {
      code: 404,
      message: "The requested resource wasn't found.",
      data: {},
    },
  })
}

export function isNetworkError(err: unknown): boolean {
  if (err instanceof ClientResponseError) {
    // status 0 => request never reached the server (abort / network failure)
    return err.status === 0 && !err.isAbort
  }
  return err instanceof TypeError // fetch network failures surface as TypeError
}

export function isNotFound(err: unknown): boolean {
  return err instanceof ClientResponseError && err.status === 404
}
