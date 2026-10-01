export class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

export function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...headers },
  });
}

export function errorResponse(err) {
  if (err instanceof HttpError) return json(err.status, { error: err.message }, err.headers);
  console.error(err);
  return json(500, { error: 'Something went wrong.' });
}

/** Durable Object methods report failures as values; turn them back into HttpErrors here. */
export function unwrap(result) {
  if (result?.error) throw new HttpError(result.error.status, result.error.message, result.error.headers);
  return result;
}

export { SECURITY_HEADERS };
