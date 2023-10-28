import BigNumber from "bignumber.js";

export function round_dp(n: number, d: number) {
  return Number(new BigNumber(n).toFormat(d));
}
