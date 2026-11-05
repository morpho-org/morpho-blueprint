import "server-only";

// Public, keyless host. Deployments pointing at a partner instance override it via env.
const DEFAULT_MORPHO_API_URL = "https://api.morpho.org";

/**
 * The two Morpho API hosts the app reads. `core` serves Core REST (`/v0/...`) on the host the
 * GraphQL API already uses. `blueprint` serves the Blueprint API routes (`/v0/blueprint-app-api/...`)
 * on the internal deployment, and is off unless its key is set.
 */
export type MorphoApi = "core" | "blueprint";

export interface MorphoApiHost {
  baseUrl: string;
  apiKey: string | undefined;
}

const env = (name: string) => process.env[name]?.trim() || undefined;

// `MORPHO_API_URL` is the GraphQL endpoint (`<host>/graphql`); Core REST lives on the same host.
function coreBaseUrl(): string {
  const restUrl = env("MORPHO_REST_API_URL");
  if (restUrl) return restUrl;
  const graphqlUrl = env("MORPHO_API_URL");
  if (graphqlUrl) return graphqlUrl.replace(/\/+$/, "").replace(/\/graphql$/, "");
  return DEFAULT_MORPHO_API_URL;
}

/** `null` when the Blueprint API is off (`MORPHO_INTERNAL_API_KEY` unset): callers use their fallback. */
export function getMorphoApiHost(api: "blueprint"): MorphoApiHost | null;
export function getMorphoApiHost(api: "core"): MorphoApiHost;
export function getMorphoApiHost(api: MorphoApi): MorphoApiHost | null;
export function getMorphoApiHost(api: MorphoApi): MorphoApiHost | null {
  if (api === "core") return { baseUrl: coreBaseUrl(), apiKey: env("MORPHO_API_KEY") };

  const apiKey = env("MORPHO_INTERNAL_API_KEY");
  if (!apiKey) return null;
  const baseUrl = env("MORPHO_INTERNAL_API_URL");
  // A key with no host would otherwise send the internal key to the public host.
  if (!baseUrl) throw new Error("MORPHO_INTERNAL_API_KEY is set without MORPHO_INTERNAL_API_URL.");
  return { baseUrl, apiKey };
}

export function isBlueprintApiEnabled(): boolean {
  return env("MORPHO_INTERNAL_API_KEY") !== undefined;
}
