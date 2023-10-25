import ccxt from "ccxt";
import { loadStrategyEnv, loadTargetMarketSymbols } from "./utils/env";
import { BinanceService } from "./services/binance.service";
import { AarkService } from "./services/aark.service";
import { OrderInfo } from "./interfaces/order-interface";
import { sleep } from "./utils/time";

require("dotenv").config();

const binance = new BinanceService();
const aark: AarkService = new AarkService();

const run = async () => {
  // Constants
  const [
    PRICE_DIFF_THRESHOLD,
    MAX_POSITION_USDT,
    UNHEDGED_THRESHOLD,
    MAX_ORDER_USDT,
  ] = loadStrategyEnv();

  const symbolList = loadTargetMarketSymbols();

  const [
    [aarkIndexPrices, aarkPositions, aarkMarketStatuses],
    [binanceOrderbooks, binancePositions, USDC_USDT_PRICE],
  ] = await Promise.all([aark.fetchAll(), binance.fetchAll()]);
  const OrderInfoMap: { [symbol: string]: OrderInfo } = {};

  console.log(`-------------- ${new Date().toISOString()} --------------`);
  for (const symbol of symbolList) {
    const aarkMarketStatus = aarkMarketStatuses[symbol];
    const aarkIndexPrice = aarkIndexPrices[symbol];
    const aarkPositionAmount = aarkPositions[symbol];
    const binanceOrderbook = binanceOrderbooks[symbol];
    const binancePosition = binancePositions[symbol];
    if (binanceOrderbook === undefined) {
      continue;
    }

    const binancePositionAmount = binancePosition.amount;

    const [binanceMid, binanceAsk, binanceBid] = [
      (binanceOrderbook.asks[0][0] + binanceOrderbook.asks[0][0]) /
        2 /
        USDC_USDT_PRICE,
      binanceOrderbook.asks[0][0] / USDC_USDT_PRICE,
      binanceOrderbook.bids[0][0] / USDC_USDT_PRICE,
    ];

    const depthFactor = Number(aarkMarketStatus.depthFactor);
    const skewness = Number(aarkMarketStatus.skewness);
    const aarkMarketMP = aarkIndexPrice * (1 + skewness / depthFactor / 100);

    const unhedgedValue =
      Math.abs(aarkPositionAmount + binancePositionAmount) * binanceMid;
    if (unhedgedValue > UNHEDGED_THRESHOLD) {
      let absAmountToHedge = Math.min(
        Math.abs(aarkPositionAmount + binancePositionAmount),
        MAX_ORDER_USDT / binanceMid
      );
      let side =
        aarkPositionAmount + binancePositionAmount > 0 ? "buy" : "sell";
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

      OrderInfoMap[symbol] = {
        symbol,
        amountInAark: 0,
        amountInBinance:
          aarkPositionAmount > binancePositionAmount
            ? absAmountToHedge
            : -absAmountToHedge,
      };
      continue;
    }

    // Approximate avg. trade price of binance = last traded binance quote price
    let amountInAark = 0;
    if (aarkMarketMP < binanceBid) {
      for (const [p, q] of binanceOrderbook.bids) {
        const deltaAmount = Math.min(
          q,
          2 *
            (100 *
              depthFactor *
              ((p * (1 - PRICE_DIFF_THRESHOLD)) / aarkIndexPrice - 1) -
              skewness) -
            amountInAark
        );
        if (deltaAmount < 0) {
          break;
        }
        amountInAark += deltaAmount;
        if (deltaAmount !== q) {
          break;
        }
      }
    } else if (aarkMarketMP > binanceAsk) {
      for (const [p, q] of binanceOrderbook.asks) {
        const deltaAmount = Math.min(
          q,
          2 *
            (-100 *
              depthFactor *
              ((p * (1 + PRICE_DIFF_THRESHOLD)) / aarkIndexPrice - 1) +
              skewness) +
            amountInAark
        );
        if (deltaAmount < 0) {
          break;
        }
        amountInAark -= deltaAmount;
        if (deltaAmount !== q) {
          break;
        }
      }
    }

    if (amountInAark > 0) {
      amountInAark = Math.min(
        (MAX_POSITION_USDT + Number(binancePosition.notionalValue)) /
          binanceMid,
        Math.abs(amountInAark)
      );
      console.log(`
  ~~~~ ARBITRIGING ${symbol} ~~~~
  BUY IN AARK, SELL IN BINANCE
  AARK Mark Price      : ${aarkMarketMP.toFixed(6)}
  Binance Bid Price    : ${binanceBid.toFixed(6)}
  Price Ratio          : ${(binanceBid / aarkMarketMP - 1).toFixed(6)}
  Order Amount in AARK : ${amountInAark.toFixed(6)}
      `);
      OrderInfoMap[symbol] = {
        symbol,
        amountInAark: amountInAark,
        amountInBinance: -amountInAark,
      };
    } else if (amountInAark < 0) {
      amountInAark = Math.min(
        (MAX_POSITION_USDT - Number(binancePosition.notionalValue)) /
          binanceMid,
        Math.abs(amountInAark)
      );
      console.log(`
  ~~~~ ARBITRIGING ${symbol} ~~~~
  BUY IN BINANCE, SELL IN AARK
  AARK Mark Price      : ${aarkMarketMP.toFixed(6)}
  Binance Ask Price    : ${binanceAsk.toFixed(6)}
  Price Ratio          : ${(binanceAsk / aarkMarketMP - 1).toFixed(6)}
  Order Amount in Aark : ${amountInAark.toFixed(6)}
      `);

      OrderInfoMap[symbol] = {
        symbol,
        amountInAark: amountInAark,
        amountInBinance: -amountInAark,
      };
    }
  }

  await Promise.all([
    binance.createOrders(OrderInfoMap),
    aark.createOrders(OrderInfoMap),
  ]);

  console.log("\n\n");
};

async function main() {
  while (true) {
    await run();
    await sleep(5000);
  }
}
main().then(() => {
  console.log("Done!");
});
