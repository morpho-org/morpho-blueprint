import "server-only";

import { APP_CONFIG } from "@/config";

// Public host. Deployments pointing at a partner instance override it via env.
const DEFAULT_MORPHO_API_URL = "https://api.morpho.org";

/**
 * The two kinds of Morpho API reads. `core` is Core REST (`/v0/...`, `/v1/...`). `blueprint` is the Blueprint API
 * routes (`/v0/blueprint-app-api/...`), served only by the internal deployment and off unless its key is set.
 */
export type MorphoApi = "core" | "blueprint";

export interface MorphoApiHost {
  baseUrl: string;
  apiKey: string | undefined;
}

const env = (name: string) => process.env[name]?.trim() || undefined;

// `MORPHO_API_URL` was the GraphQL endpoint (`<host>/graphql`); deployments that only set it keep its host.
function fallbackCoreBaseUrl(): string {
  const restUrl = env("MORPHO_REST_API_URL");
  if (restUrl) return restUrl;
  const graphqlUrl = env("MORPHO_API_URL");
  if (graphqlUrl) return graphqlUrl.replace(/\/+$/, "").replace(/\/graphql$/, "");
  return DEFAULT_MORPHO_API_URL;
}

/**
 * The internal deployment, which serves both Core REST and the Blueprint API routes. `null` when
 * `MORPHO_INTERNAL_API_KEY` is unset and the app allows the fallback hosts
 * (`APP_CONFIG.morphoApi.requireInternal` false). Throws rather than read another host when the app
 * requires it and a variable is missing, or when the key is set without its URL.
 */
function internalHost(): MorphoApiHost | null {
  const apiKey = env("MORPHO_INTERNAL_API_KEY");
  const baseUrl = env("MORPHO_INTERNAL_API_URL");

  if (APP_CONFIG.morphoApi.requireInternal && (!apiKey || !baseUrl)) {
    const missing = [!baseUrl && "MORPHO_INTERNAL_API_URL", !apiKey && "MORPHO_INTERNAL_API_KEY"].filter(Boolean);
    throw new Error(
      `This app reads only the internal Morpho API (APP_CONFIG.morphoApi.requireInternal) and ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} unset.`,
    );
  }
  if (!apiKey) return null;
  // A key with no host would otherwise send the internal key to another host.
  if (!baseUrl) throw new Error("MORPHO_INTERNAL_API_KEY is set without MORPHO_INTERNAL_API_URL.");
  return { baseUrl, apiKey };
}

/**
 * The host and key for a read. With the internal key set, both kinds go to the internal deployment.
 * Without it, Core REST goes to `MORPHO_REST_API_URL`, else the `MORPHO_API_URL` host, else the public
 * API (with `MORPHO_API_KEY`), and the Blueprint API is off: `null`, callers use their fallback.
 */
export function getMorphoApiHost(api: "blueprint"): MorphoApiHost | null;
export function getMorphoApiHost(api: "core"): MorphoApiHost;
export function getMorphoApiHost(api: MorphoApi): MorphoApiHost | null;
export function getMorphoApiHost(api: MorphoApi): MorphoApiHost | null {
  const internal = internalHost();
  if (api === "blueprint") return internal;
  return internal ?? { baseUrl: fallbackCoreBaseUrl(), apiKey: env("MORPHO_API_KEY") };
}

/** Whether the Blueprint API routes are on. Throws like `getMorphoApiHost` when the setup is invalid. */
export function isBlueprintApiEnabled(): boolean {
  return internalHost() !== null;
}
