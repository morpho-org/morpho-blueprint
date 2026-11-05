import type { Erc4626SupplyActionParameters, VaultAction } from "@/actions/types";
import { APP_CONFIG } from "@/config";
import { erc4626SupplyActionDirect } from "./erc4626SupplyActionDirect";
import { erc4626SupplyViaMorphoSdkAction } from "./erc4626SupplyViaMorphoSdkAction";

/**
 * Action to supply to an ERC4626 vault.
 * This is just a convenience wrapper to direct to the appropriate supply action based on the configuration (morpho-sdk or direct).
 *
 * See the docstring for each action for more details.
 */
export async function erc4626SupplyAction(params: Erc4626SupplyActionParameters): Promise<VaultAction> {
  if (APP_CONFIG.actionParameters.bundler3Config.enabled) {
    return erc4626SupplyViaMorphoSdkAction(params);
  }

  return erc4626SupplyActionDirect(params);
}
