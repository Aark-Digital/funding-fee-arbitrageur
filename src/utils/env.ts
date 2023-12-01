import _ from "lodash";
export function loadStrategyEnv(): number[] {
  return [
    process.env.PRICE_DIFF_THRESHOLD!,
    process.env.MAX_POSITION_USDT!,
    process.env.UNHEDGED_THRESHOLD!,
    process.env.MAX_ORDER_USDT!,
  ].map((param: string) => parseFloat(param));
}

export function loadTargetMarketSymbols(): string[] {
  return JSON.parse(process.env.TARGET_MARKETS!);
}

export function checkObjectKeys(objList: any[], keys: string[]) {
  const targetKeySet = new Set(keys);
  for (const obj of objList) {
    const keySet = new Set(Object.keys(obj));
    if (!_.isEqual(targetKeySet, keySet)) {
      return false;
    }
  }
  return true;
}
