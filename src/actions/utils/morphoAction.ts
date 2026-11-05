import {
  type ActionRequirement,
  isRequirementApproval,
  isRequirementBlueAuthorization,
  isRequirementSignature,
} from "@morpho-org/morpho-sdk";
import { type Address, type Hex, isAddress, isHex, type TransactionRequest as ViemTransactionRequest } from "viem";
import type { TransactionRequest } from "@/actions/types";
import { UserFacingError } from "@/actions/types";

type MorphoActionOutput = {
  getRequirements: () => Promise<readonly ActionRequirement[]>;
  buildTx: () => { readonly to: Address; readonly data: Hex; readonly value: bigint };
};

function requirementName(requirement: ActionRequirement) {
  if (requirement.action.type === "blueAuthorization") return "Authorize Morpho";
  if (requirement.action.type === "erc20Approval") return "Approve supply amount";
  return "Confirm requirement";
}

function toTransactionRequest(name: string, tx: unknown): TransactionRequest {
  if (
    tx == null ||
    typeof tx !== "object" ||
    !("to" in tx) ||
    typeof tx.to !== "string" ||
    !isAddress(tx.to) ||
    !("data" in tx) ||
    !isHex(tx.data) ||
    !("value" in tx) ||
    typeof tx.value !== "bigint" ||
    tx.value < 0n
  ) {
    throw new UserFacingError("Unable to prepare transaction requirement.");
  }
  return {
    name,
    tx: () => tx as ViemTransactionRequest & { to: Address; data: Hex },
  };
}

export async function transactionRequestsFromMorphoAction(
  output: MorphoActionOutput,
  finalName: string,
): Promise<TransactionRequest[]> {
  const requirements = await output.getRequirements();
  const transactions = requirements.map((requirement) => {
    if (
      isRequirementSignature(requirement) ||
      (!isRequirementApproval(requirement) && !isRequirementBlueAuthorization(requirement))
    ) {
      throw new UserFacingError("Unexpected transaction requirement.");
    }
    return toTransactionRequest(requirementName(requirement), requirement);
  });
  transactions.push({ name: finalName, tx: () => output.buildTx() });
  return transactions;
}
