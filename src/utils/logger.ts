export function logUnhedged(
  symbol: string,
  aarkPositionAmount: number,
  binancePositionAmount: number,
  unhedgedValue: number,
  side: string,
  absAmountToHedge: number
) {
  console.log(
    `
  **** UNHEDGED ${symbol} ****
  AARK Position Qty    : ${aarkPositionAmount.toFixed(6)}
  Binance Position Qty : ${binancePositionAmount.toFixed(6)}
  Unhedged Value : $${unhedgedValue.toFixed(2)}
  >> Hedge Position by ${side.toUpperCase() + "ING"} ${absAmountToHedge.toFixed(
      6
    )} ${symbol} in BINANCE`
  );
}

export function logArbitrage(
  symbol: string,
  aarkMarketMP: number,
  binancePrice: number,
  amountInAark: number,
  isBuyInAark: boolean
) {
  console.log(`
  ~~~~ ARBITRIGING ${symbol} ~~~~
  BUY IN AARK, SELL IN BINANCE
  AARK Mark Price      : ${aarkMarketMP.toFixed(6)}
  Binance ${isBuyInAark ? "Bid" : "Ask"} Price    : ${binancePrice.toFixed(6)}
  Price Ratio          : ${(binancePrice / aarkMarketMP - 1).toFixed(6)}
  Order Amount in AARK : ${amountInAark.toFixed(6)}
      `);
}
