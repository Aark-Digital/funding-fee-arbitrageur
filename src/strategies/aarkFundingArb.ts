import { Orderbook, Position } from "../interfaces/basic-interface";
import { IAarkMarketStatus } from "../interfaces/market-interface";
import { IActionParam } from "../interfaces/order-interface";
import { AarkService } from "../services/aark.service";
import { BinanceService } from "../services/binance.service";
import { loadTargetMarketSymbols } from "../utils/env";
import { addCreateMarketParams, adjustOrderSize } from "../utils/order";
import { validateAndReturnData } from "../utils/validation";

const binanceService = new BinanceService(
  process.env.BINANCE_API_KEY!,
  process.env.BINANCE_SECRET!,
  JSON.parse(process.env.TARGET_CRYPTO_LIST!)
    .map((symbol: string) => `${symbol}_USDT`)
    .concat(["USDC_USDT"])
);

const aarkService = new AarkService(
  JSON.parse(process.env.TARGET_CRYPTO_LIST!).map(
    (symbol: string) => `${symbol}_USDC`
  )
);

const [
  PRICE_DIFF_THRESHOLD,
  MAX_POSITION_USDT,
  UNHEDGED_THRESHOLD,
  MAX_ORDER_USDT,
] = [
  process.env.PRICE_DIFF_THRESHOLD!,
  process.env.MAX_POSITION_USDT!,
  process.env.UNHEDGED_THRESHOLD!,
  process.env.MAX_ORDER_USDT!,
].map((param: string) => parseFloat(param));

export async function strategy() {
  const binanceActionParams: IActionParam[] = [];
  const aarkActionParams: IActionParam[] = [];
  await Promise.all([
    binanceService.fetchOpenOrders(),
    binanceService.fetchPositions(),
    binanceService.fetchOrderbooks(),
    aarkService.fetchIndexPrices(),
    aarkService.fetchPositions(),
    aarkService.fetchMarketStatuses(),
  ]);

  const binanceInfo = binanceService.getMarketInfo();
  const aarkInfo = aarkService.getMarketInfo();
  const cryptoList: string[] = JSON.parse(process.env.TARGET_CRYPTO_LIST!);

  const binanceUSDCInfo = binanceInfo[`USDC_USDT`].orderbook;
  if (binanceUSDCInfo === undefined) {
    throw new Error(`[Data Fetch Fail] Failed to fetch USDC market Info`);
  }
  const USDC_USDT_PRICE =
    (binanceUSDCInfo.asks[0][0] + binanceUSDCInfo.bids[0][0]) / 2;

  for (const crypto of cryptoList) {
    const binanceMarketInfo = binanceInfo[`${crypto}_USDT`];
    const aarkMarketInfo = aarkInfo[`${crypto}_USDC`];

    const [
      bnPosition,
      bnOrderbook,
      aarkPosition,
      aarkMarketStatus,
      aarkIndexPrice,
    ]: [Position, Orderbook, Position, IAarkMarketStatus, number] =
      validateAndReturnData(
        [
          binanceMarketInfo.position,
          binanceMarketInfo.orderbook,
          aarkMarketInfo.position,
          aarkMarketInfo.marketStatus,
          aarkMarketInfo.indexPrice,
        ],
        3000
      );

    const binanceMidUSDT =
      (bnOrderbook.asks[0][0] + bnOrderbook.asks[0][0]) / 2;

    const unhedgedSize = bnPosition.size + aarkPosition.size;
    if (Math.abs(unhedgedSize) * binanceMidUSDT > UNHEDGED_THRESHOLD) {
      const absAmountToHedge = Math.min(
        Math.abs(unhedgedSize),
        MAX_ORDER_USDT / binanceMidUSDT
      );
      addCreateMarketParams(binanceActionParams, [
        {
          symbol: `${crypto}_USDT`,
          size: unhedgedSize < 0 ? absAmountToHedge : -absAmountToHedge,
        },
      ]);
      continue;
    }

    let orderSizeInAark = calcArbAmount(
      bnOrderbook,
      aarkMarketStatus,
      aarkIndexPrice,
      PRICE_DIFF_THRESHOLD,
      USDC_USDT_PRICE
    );

    orderSizeInAark = adjustOrderSize(
      aarkPosition,
      orderSizeInAark,
      MAX_POSITION_USDT / binanceMidUSDT,
      10 / binanceMidUSDT // Min order value of binance is typically $5. Set $10 to be more safe
    );

    if (orderSizeInAark !== 0) {
      addCreateMarketParams(binanceActionParams, [
        {
          symbol: `${crypto}_USDT`,
          size: -orderSizeInAark,
        },
      ]);
      addCreateMarketParams(aarkActionParams, [
        {
          symbol: `${crypto}_USDC`,
          size: orderSizeInAark,
        },
      ]);
    }
  }

  console.log(
    "------ Binance ------",
    JSON.stringify(binanceActionParams, null, 2)
  );
  console.log("------ Aark ------", JSON.stringify(aarkActionParams, null, 2));

  // await Promise.all([
  //   binanceService.executeOrders(binanceActionParams),
  //   aarkService.executeOrders(aarkActionParams),
  // ]);
}

function calcArbAmount(
  bnOrderbook: Orderbook,
  aarkMarketStatus: IAarkMarketStatus,
  aarkIndexPrice: number,
  threshold: number,
  usdcPrice: number
): number {
  // Approximate avg. trade price of binance = last traded binance quote price

  const depthFactor = Number(aarkMarketStatus.depthFactor);
  const skewness = Number(aarkMarketStatus.skewness);

  let orderSizeInAark = 0;
  for (const [p, q] of bnOrderbook.bids) {
    const deltaAmount = Math.min(
      q,
      2 *
        (100 *
          depthFactor *
          (((p / usdcPrice) * (1 - threshold)) / aarkIndexPrice - 1) -
          skewness) -
        orderSizeInAark
    );
    orderSizeInAark += deltaAmount;
    if (deltaAmount !== q) {
      break;
    }
  }

  if (orderSizeInAark !== 0) {
    return orderSizeInAark;
  }

  for (const [p, q] of bnOrderbook.asks) {
    const deltaAmount = Math.min(
      q,
      2 *
        (-100 *
          depthFactor *
          (((p / usdcPrice) * (1 + PRICE_DIFF_THRESHOLD)) / aarkIndexPrice -
            1) +
          skewness) +
        orderSizeInAark
    );
    orderSizeInAark -= deltaAmount;
    if (deltaAmount !== q) {
      break;
    }
  }

  return orderSizeInAark;
}
