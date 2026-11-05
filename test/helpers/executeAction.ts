import type { AnvilTestClient } from "@morpho-org/test";
import type { Hex, Log } from "viem";
import { estimateGas, getTransactionReceipt, sendTransaction } from "viem/actions";

import type { Action } from "@/actions";

export async function executeAction(client: AnvilTestClient, action: Action): Promise<Log[]> {
  let logs: Log[] = [];
  try {
    for (const step of action.signatureRequests) {
      await step.sign(client);
    }
  } catch {
    throw Error("signature failed");
  }

  // Remove try-catch to get full trace for debugging
  for (const step of action.transactionRequests) {
    const tx = step.tx();
    let hash: Hex;
    try {
      await client.setNextBlockBaseFeePerGas({ baseFeePerGas: 0n });
      const gas = await estimateGas(client, {
        to: tx.to,
        data: tx.data,
        value: tx.value,
        account: client.account.address,
      });
      // This will also throw sometimes, not sure why, but likely due to debug tracing.. (execution reverted)
      hash = await sendTransaction(client, {
        account: client.account.address,
        to: tx.to,
        data: tx.data,
        value: tx.value,
        gas: (gas * 130n) / 100n, // Match ActionFlowProvider's gas buffer.
        maxFeePerGas: 0n,
        maxPriorityFeePerGas: 0n,
      });
    } catch {
      // console.log("Send threw...", e);
      throw Error("action-tx-reverted");
    }
    const receipt = await getTransactionReceipt(client, { hash });
    if (receipt.status === "reverted") {
      throw Error("action-tx-reverted");
    }

    logs = [...logs, ...receipt.logs];
  }

  return logs;
}
