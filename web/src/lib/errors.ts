/** An HTTP error from the backend (or the same shape from the fixture backend). */
export class ApiError extends Error {
  constructor(message: string, public readonly status: number) { super(message); this.name = 'ApiError'; }
}
