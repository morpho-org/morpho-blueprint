import "server-only";

import { promiseWithRetry } from "@/common/utils/fetch";
import { getMorphoApiHost, type MorphoApi } from "@/common/utils/morphoApiConfig";
import { trackEvent } from "@/common/utils/trackEvent";

const REQUEST_TIMEOUT_MS = 15_000;

/** Core REST caps list `limit` and every array filter (`vault_addresses`, `market_ids`, …) at 100. */
export const REST_MAX_PAGE_SIZE = 100;
export const REST_MAX_FILTER_ITEMS = 100;

// Bounds a cursor drain: at 100 rows a page this is 5,000 rows, far beyond any configured set. A
// list that reaches it throws rather than returning a silently truncated result.
const MAX_PAGES = 50;

// The parallel calls the app allows itself against the API, across every read in the process (the
// vault page runs summary, details and history at once). Retries queue like any other call.
const MAX_CONCURRENT_REQUESTS = 16;
let requestsInFlight = 0;
const waitingForSlot: (() => void)[] = [];

function acquireRequestSlot(): Promise<void> {
  if (requestsInFlight < MAX_CONCURRENT_REQUESTS) {
    requestsInFlight += 1;
    return Promise.resolve();
  }
  // `releaseRequestSlot` hands its slot straight to the next waiter, so the count stays the same.
  return new Promise((resolve) => waitingForSlot.push(resolve));
}

function releaseRequestSlot() {
  const next = waitingForSlot.shift();
  if (next) next();
  else requestsInFlight -= 1;
}

/** Runs one HTTP call in a request slot; the timeout starts once the slot is taken. */
async function withRequestSlot<T>(call: () => Promise<T>): Promise<T> {
  await acquireRequestSlot();
  return call().finally(releaseRequestSlot);
}

type QueryValue = string | number | boolean | readonly (string | number)[] | undefined;
export type RestQuery = Record<string, QueryValue>;

export interface RestRequestOptions {
  /**
   * Seconds the Next data cache may serve this response. Only for resources that cannot change
   * (market params, token metadata, a vault's asset); anything else is fetched per request, as the
   * GraphQL reads were.
   */
  revalidate?: number;
  /** Which host serves the route. Defaults to Core REST. */
  api?: MorphoApi;
  /**
   * The caller has a fallback for a failure: it is logged as a warning, with no error event, so a
   * handled degradation does not page anyone.
   */
  quiet?: boolean;
}

/** A non-2xx Core REST response, carrying Nest's `{ statusCode, message, error }` body. */
export class MorphoRestError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly detail: string,
  ) {
    super(`Morpho REST ${status} on ${path}: ${detail}`);
    this.name = "MorphoRestError";
  }
}

/** Core REST addresses a chain-scoped resource as `<chain_id>:<address-or-market-id>`. */
export function restSelector(chainId: number, id: string): string {
  return `${chainId}:${id}`;
}

export function chunk<T>(items: readonly T[], size = REST_MAX_FILTER_ITEMS): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function buildUrl(baseUrl: string, path: string, query: RestQuery = {}): URL {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      // An omitted filter means "every row", so an empty list must never reach the API as one.
      if (value.length === 0) throw new Error(`Empty "${key}" filter for ${path}; skip the request instead.`);
      url.searchParams.set(key, value.join(","));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "message" in body) {
    const { message } = body;
    if (Array.isArray(message)) return message.join("; ");
    if (typeof message === "string") return message;
  }
  return fallback;
}

// Nest answers a path no controller serves with `Cannot GET <path>`; a known route reports the
// missing resource in its own words. Only the latter means "not found".
function isMissingResource(error: unknown): boolean {
  return error instanceof MorphoRestError && error.status === 404 && !error.detail.startsWith("Cannot GET ");
}

// Only failures a second attempt can fix: the network, a timeout, a 5xx or a 429. A 4xx is the
// request's fault and repeats identically.
function isRetryable(error: unknown): boolean {
  return !(error instanceof MorphoRestError) || error.status >= 500 || error.status === 429;
}

async function readMorphoRest<T, M>(
  path: string,
  query: RestQuery | undefined,
  options: RestRequestOptions,
  missing?: { value: M },
): Promise<T | M> {
  const host = getMorphoApiHost(options.api ?? "core");
  if (!host) throw new Error(`Blueprint API is off (MORPHO_INTERNAL_API_KEY unset); check before reading ${path}.`);
  const url = buildUrl(host.baseUrl, path, query);
  const { apiKey } = host;

  const attempt = async (): Promise<T> => {
    const response = await fetch(url, {
      headers: { Accept: "application/json", ...(apiKey ? { "x-api-key": apiKey } : {}) },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(options.revalidate === undefined ? {} : { next: { revalidate: options.revalidate } }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new MorphoRestError(response.status, url.pathname, errorMessage(body, response.statusText));
    }
    return (await response.json()) as T;
  };

  try {
    return await promiseWithRetry(() => withRequestSlot(attempt), { shouldRetry: isRetryable });
  } catch (error) {
    if (missing && isMissingResource(error)) return missing.value;
    if (options.quiet) {
      console.warn(`Morpho REST read failed for ${url.pathname}${url.search}, using the fallback - ${error}`);
    } else {
      console.error(`Morpho REST read failed for ${url.pathname}${url.search} - ${error}`);
      trackEvent("data-fetch-error", { url: url.toString(), error: `${error}` }).catch(() => {});
    }
    throw error;
  }
}

/**
 * Server-only chokepoint for every read against Morpho's REST APIs (Core `/v0` and the Blueprint
 * API routes). Returns the parsed body. Any non-2xx response throws a `MorphoRestError`, after
 * retrying the transient ones; a 404 too, so lists and unknown routes never read as empty.
 */
export function fetchMorphoRest<T>(path: string, query?: RestQuery, options: RestRequestOptions = {}): Promise<T> {
  return readMorphoRest<T, never>(path, query, options);
}

/**
 * A single-resource read (`/v0/<kind>/<selector>[/...]`): `null` when the API reports the resource
 * missing. A 404 for an unknown route still throws, so a wrong path never reads as "not found".
 */
export function fetchMorphoRestResource<T>(
  path: string,
  query?: RestQuery,
  options: RestRequestOptions = {},
): Promise<T | null> {
  return readMorphoRest<T, null>(path, query, options, { value: null });
}

/** Drains a cursor-paginated list. Any error, a 404 included, fails the whole list. */
export async function fetchAllMorphoRestPages<T>(
  path: string,
  query: RestQuery = {},
  options: RestRequestOptions = {},
): Promise<T[]> {
  const rows: T[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await fetchMorphoRest<{ data: T[]; cursor: string | null }>(
      path,
      { ...query, limit: REST_MAX_PAGE_SIZE, cursor },
      options,
    );
    rows.push(...response.data);
    if (!response.cursor) return rows;
    cursor = response.cursor;
  }

  throw new Error(`Morpho REST list ${path} did not end within ${MAX_PAGES} pages.`);
}
