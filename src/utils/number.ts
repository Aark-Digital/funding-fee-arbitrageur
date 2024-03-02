import BigNumber from "bignumber.js";
import { IMarketInfo } from "../interfaces/market-interface";

export function floor_dp(n: number, d: number) {
  return Math.floor(n * 10 ** d) / 10 ** d;
}

export function ceil_dp(n: number, d: number) {
  return Math.ceil(n * 10 ** d) / 10 ** d;
}

export function round_dp(n: number, d: number) {
  return Math.round(n * 10 ** d) / 10 ** d;
}

export function formatNumber(n: number, d: number) {
  return n.toLocaleString("en-US", { maximumFractionDigits: d });
}

export function numberToPrecision(f: number) {
  return -Math.round(Math.log10(f));
}

export function convertSizeToContractAmount(
  size: number,
  marketInfo: IMarketInfo
): number {
  return Math.abs(
    round_dp(size / marketInfo.contractSize, marketInfo.qtyPrecision)
  );
}

export function parseEthersBignumber(bn: any, decimal: number) {
  return Number(
    new BigNumber(bn.toString()).dividedBy(10 ** decimal).toFixed()
  );
}
