/** The `adapter_kind` values Core REST serves today. The field is open-ended: new kinds ship additively. */
export type RestVaultV2AdapterKind =
  | "morpho_market_v1"
  | "morpho_market_v1_v2"
  | "morpho_vault_v1"
  | "morpho_vault_v2"
  | "unknown";

interface RestVaultV2AdapterHandlers<R> {
  /** Wraps markets directly; the adapter carries one `market_v1` cap per market. */
  marketV1: () => R;
  /** Wraps a vault V1. */
  vaultV1: () => R;
  /** Wraps another vault V2. */
  vaultV2: () => R;
  /** A kind REST reports as `unknown`, or one it has shipped since this build. */
  unknown: (kind: string) => R;
}

/**
 * The single place that discriminates a vault V2 adapter by Core REST's `adapter_kind`, so a new
 * kind is a compile error in this one switch rather than a row silently ignored by a caller. Both
 * market adapter generations hold Morpho Blue markets the same way.
 */
export function matchRestVaultV2Adapter<R>(
  adapter: { adapter_kind: RestVaultV2AdapterKind },
  handlers: RestVaultV2AdapterHandlers<R>,
): R {
  const kind = adapter.adapter_kind;
  switch (kind) {
    case "morpho_market_v1":
    case "morpho_market_v1_v2":
      return handlers.marketV1();
    case "morpho_vault_v1":
      return handlers.vaultV1();
    case "morpho_vault_v2":
      return handlers.vaultV2();
    case "unknown":
      return handlers.unknown(kind);
    default: {
      // REST can serve a new kind at any time: it degrades to a row with no breakdown rather than
      // failing the page.
      const unhandled: never = kind;
      console.warn(`Unknown vault V2 adapter kind, degrading: ${String(unhandled)}`);
      return handlers.unknown(String(unhandled));
    }
  }
}
