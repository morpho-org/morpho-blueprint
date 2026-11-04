import "server-only";

import { cache } from "react";
import { createPublicClient, getAddress, http } from "viem";
import { mainnet } from "viem/chains";
import { redactError } from "@/common/utils/redactError";

// Chainalysis's public sanctions oracle, which screens against the OFAC SDN list.
// Pinned to mainnet: the screening result is chain independent, so it is read here regardless of
// which chain the action being gated targets.
// https://go.chainalysis.com/chainalysis-oracle-docs.html
const SANCTIONS_ORACLE_ADDRESS = getAddress("0x40C57923924B5c5c5455c48D93317139ADDaC8fb");

const SANCTIONS_ORACLE_ABI = [
  {
    type: "function",
    name: "isSanctioned",
    stateMutability: "view",
    inputs: [{ name: "addr", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

// This gates the start of every transaction flow, so the read is kept short: two attempts of
// RPC_TIMEOUT_MS each, ~8s worst case.
const RPC_TIMEOUT_MS = 4_000;

// Read against the configured mainnet RPC URL directly rather than through the app's
// /api/rpc/[chainId] proxy: the proxy requires an Origin header, so it rejects server-to-server
// calls, and under the fail-closed semantics below that would block every transaction.
function getMainnetTransport() {
  const rpcUrl = process.env.MAINNET_RPC_URL_1;
  if (!rpcUrl) {
    throw new Error("No mainnet RPC URL configured");
  }
  // One retry: this read fails closed, so without it any transient blip would block a transaction.
  return http(rpcUrl, { timeout: RPC_TIMEOUT_MS, retryCount: 1 });
}

/**
 * Whether a wallet is sanctioned according to Chainalysis's on-chain sanctions oracle.
 *
 * Fails closed: any failure — a malformed address, missing RPC configuration, or an RPC error —
 * reports the wallet as sanctioned, since a screening result that cannot be established must not
 * let a transaction through.
 */
export const getWalletIsSanctioned = cache(async (address: string): Promise<boolean> => {
  try {
    const client = createPublicClient({ chain: mainnet, transport: getMainnetTransport() });
    return await client.readContract({
      address: SANCTIONS_ORACLE_ADDRESS,
      abi: SANCTIONS_ORACLE_ABI,
      functionName: "isSanctioned",
      args: [getAddress(address)],
    });
  } catch (error) {
    // Logged without the raw error object, which would embed the (possibly credential-bearing) RPC URL.
    console.error(`Unable to screen ${address} against the sanctions oracle, failing closed: ${redactError(error)}`);
    return true;
  }
});
