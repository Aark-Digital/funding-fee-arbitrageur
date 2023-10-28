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
