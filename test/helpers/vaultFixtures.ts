import { APP_CONFIG } from "@/config";
import { Erc4626VaultProtocol } from "@/config/vault-protocol";

export const V2_WETH_VAULT = "0xBb50A5341368751024ddf33385BA8cf61fE65FF9";

export function configureTestVaults() {
  APP_CONFIG.supportedVaults[1].push(
    { address: "0x9a8bC3B04b7f3D87cfC09ba407dCED575f2d61D8", protocol: Erc4626VaultProtocol.MorphoV1 },
    { address: V2_WETH_VAULT, protocol: Erc4626VaultProtocol.MorphoV2 },
    { address: "0xbEef047a543E45807105E51A8BBEFCc5950fcfBa", protocol: Erc4626VaultProtocol.MorphoV1 },
    { address: "0xBEEf050ecd6a16c4e7bfFbB52Ebba7846C4b8cD4", protocol: Erc4626VaultProtocol.MorphoV1 },
    { address: "0x31A5684983EeE865d943A696AAC155363bA024f9", protocol: Erc4626VaultProtocol.MorphoV1 },
  );
}
