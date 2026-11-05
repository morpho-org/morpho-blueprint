// App-owned scalar shims for amounts the Morpho API serves.

export type { Address, Hex } from "viem";

// Raw amounts come back as a decimal string (or a JSON number when small enough). Normalize with
// `toBigInt` from @/common/data/adapters/amount before use.
export type BigIntish = string | number | bigint;
