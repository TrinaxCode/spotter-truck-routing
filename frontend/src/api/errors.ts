/** DRF validation detail: a message, a list of messages, or a nested object (e.g. origin.lat). */
export type FieldIssue = string | string[] | { [key: string]: FieldIssue };
export type FieldIssues = Record<string, FieldIssue>;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields?: FieldIssues;

  constructor(status: number, code: string, message: string, fields?: FieldIssues) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

function firstMessage(issue: FieldIssue): string | undefined {
  if (typeof issue === "string") return issue;
  if (Array.isArray(issue)) return issue.find((item) => typeof item === "string");
  for (const nested of Object.values(issue)) {
    const found = firstMessage(nested);
    if (found) return found;
  }
  return undefined;
}

/** One message per top-level field. Nested errors (origin.lat) surface on `origin`. */
export function flattenFieldErrors(fields?: FieldIssues): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [key, issue] of Object.entries(fields ?? {})) {
    const message = firstMessage(issue);
    if (message) flat[key] = message;
  }
  return flat;
}

/** Plain-language text for the UI. Server wording is kept unless it is operator-facing. */
export function describeApiError(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  if (error.code === "not_configured") {
    return "Route planning is not available yet because the service is not configured. Please contact support.";
  }
  if (error.code === "validation_error") {
    const details = Object.values(flattenFieldErrors(error.fields));
    return details.length > 0 ? `Check the trip details. ${details.join(" ")}` : error.message;
  }
  return error.message || fallback;
}

/** Retrying cannot fix a rejected request or a missing server key. */
export function isRetryable(error: unknown): boolean {
  return !(error instanceof ApiError) || (error.status !== 400 && error.code !== "not_configured");
}
