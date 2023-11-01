import BigNumber from "bignumber.js";

export function round_dp(n: number, d: number) {
  return Number(new BigNumber(n).toFormat(d));
}

export function formatNumber(n: number, d: number) {
  return n.toFixed(d);
}
