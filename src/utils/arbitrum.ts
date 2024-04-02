import BigNumber from "bignumber.js";
import { ARB_GAS_INFO } from "@arbitrum/sdk/dist/lib/dataEntities/constants";
import { ArbGasInfo__factory } from "@arbitrum/sdk/dist/lib/abi/factories/ArbGasInfo__factory";
import { ethers } from "ethers";

export async function getL2Factor(provider: any): Promise<number> {
  const arbGasInfo = ArbGasInfo__factory.connect(ARB_GAS_INFO, provider);
  // const [gasComponent, feeData]: any[] = await Promise.all([
  //   provider.getFeeData(),
  // ]);
  const gasComponent = await arbGasInfo.callStatic.getPricesInWei();
  const P = gasComponent[5];
  const L1P = gasComponent[1];
  const L1Factor = Number(
    new BigNumber(L1P.toString())
      .dividedBy(new BigNumber(P.toString()))
      .toFixed(0)
  );
  return L1Factor;
}
