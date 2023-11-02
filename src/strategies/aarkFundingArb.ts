import { Orderbook, Position } from "../interfaces/basic-interface";
import {
  IAarkMarket,
  IAarkMarketStatus,
  IMarket,
} from "../interfaces/market-interface";
import { IActionParam } from "../interfaces/order-interface";
import { AarkService } from "../services/aark.service";
import { BinanceService } from "../services/binance.service";
import { OkxSwapService } from "../services/okx.service";
import { loadTargetMarketSymbols } from "../utils/env";
import { formatNumber } from "../utils/number";
import { addCreateMarketParams, adjustOrderSize } from "../utils/order";
import { validateAndReturnData } from "../utils/validation";
import { table } from "table";

const cexService = new OkxSwapService(
  process.env.OKX_API_KEY!,
  process.env.OKX_API_SECRET!,
  process.env.OKX_API_PASSWORD!,
  JSON.parse(process.env.TARGET_CRYPTO_LIST!)
    .map((symbol: string) => `${symbol}_USDT`)
    .concat(["USDC_USDT"])
);

const aarkService = new AarkService(
  process.env.SIGNER_PK!,
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

export async function initializeStrategy() {
  await cexService.init();
  await aarkService.init();
}

export async function strategy() {
  const cexActionParams: IActionParam[] = [];
  const aarkActionParams: IActionParam[] = [];
  const arbitrageDetected: string[][] = [
    ["crypto", "price_bn", "price_a", "skewness", "aark Prem. (%)"],
  ];
  const marketSummary: string[][] = [
    ["crypto", "Pm_ex%", "Pm_skew%", "$Skew", "Fr24h%", "$avl.Value"],
  ];
  const unhedgedDetected: string[][] = [
    ["crypto", "pos_bn", "pos_a", "unhedged value ($)"],
  ];
  await Promise.all([
    cexService.fetchOpenOrders(),
    cexService.fetchPositions(),
    cexService.fetchOrderbooks(),
    aarkService.fetchIndexPrices(),
    aarkService.fetchPositions(),
    aarkService.fetchMarketStatuses(),
  ]);

  const cexInfo = cexService.getMarketInfo();
  const aarkInfo = aarkService.getMarketInfo();
  const cryptoList: string[] = JSON.parse(process.env.TARGET_CRYPTO_LIST!);

  const cexUSDCInfo = cexInfo[`USDC_USDT`].orderbook;
  if (cexUSDCInfo === undefined) {
    throw new Error(`[Data Fetch Fail] Failed to fetch USDC market Info`);
  }
  const USDC_USDT_PRICE = (cexUSDCInfo.asks[0][0] + cexUSDCInfo.bids[0][0]) / 2;

  for (const crypto of cryptoList) {
    try {
      const cexMarketInfo = cexInfo[`${crypto}_USDT`];
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
            cexMarketInfo.position,
            cexMarketInfo.orderbook,
            aarkMarketInfo.position,
            aarkMarketInfo.marketStatus,
            aarkMarketInfo.indexPrice,
          ],
          10000
        );

      const cexMidUSDT = (bnOrderbook.asks[0][0] + bnOrderbook.asks[0][0]) / 2;

      cexActionParams.concat(
        getHedgeActionParam(
          crypto,
          unhedgedDetected,
          bnPosition,
          aarkPosition,
          cexMidUSDT
        )
      );

      let orderSizeInAark = calcArbAmount(
        bnOrderbook,
        aarkMarketStatus,
        aarkIndexPrice,
        PRICE_DIFF_THRESHOLD,
        USDC_USDT_PRICE
      );

      marketSummary.push(
        getMarketSummary(
          crypto,
          cexMarketInfo,
          aarkMarketInfo,
          USDC_USDT_PRICE,
          orderSizeInAark
        )
      );

      orderSizeInAark = adjustOrderSize(
        aarkPosition,
        orderSizeInAark,
        MAX_POSITION_USDT / cexMidUSDT,
        10 / cexMidUSDT // Min order value of cex is typically $5. Set $10 to be more safe
      );

      if (orderSizeInAark !== 0) {
        addCreateMarketParams(cexActionParams, [
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
    } catch (e) {
      console.log(e);
      continue;
    }
  }

  if (process.env.DEBUG_MODE === "1") {
    console.log(
      table(unhedgedDetected, {
        header: { alignment: "center", content: "Unhedged Market" },
      })
    );
    // console.log("------ Arbitrage Detected ------");
    // console.log(table(arbitrageDetected));
    console.log(
      table(marketSummary, {
        header: { alignment: "center", content: "Market Summary" },
      })
    );
  }

  // await Promise.all([
  //   cexService.executeOrders(cexActionParams),
  //   aarkService.executeOrders(aarkActionParams),
  // ]);
}

function getHedgeActionParam(
  crypto: string,
  unhedgedDetected: string[][],
  cexPosition: Position,
  aarkPosition: Position,
  midPrice: number
): IActionParam[] {
  const hedgeActionParams: IActionParam[] = [];
  const unhedgedSize = cexPosition.size + aarkPosition.size;
  if (Math.abs(unhedgedSize) * midPrice > UNHEDGED_THRESHOLD) {
    const absAmountToHedge = Math.min(
      Math.abs(unhedgedSize),
      MAX_ORDER_USDT / midPrice
    );
    addCreateMarketParams(hedgeActionParams, [
      {
        symbol: `${crypto}_USDT`,
        size: unhedgedSize < 0 ? absAmountToHedge : -absAmountToHedge,
      },
    ]);
    unhedgedDetected.push([
      crypto,
      cexPosition.size.toPrecision(4),
      aarkPosition.size.toPrecision(4),
      (Math.abs(unhedgedSize) * midPrice).toPrecision(4),
    ]);
  }
  return hedgeActionParams;
}

function calcArbAmount(
  bnOrderbook: Orderbook,
  aarkMarketStatus: IAarkMarketStatus,
  aarkIndexPrice: number,
  threshold: number,
  usdcPrice: number
): number {
  // Approximate avg. trade price of cex = last traded cex quote price

  const depthFactor = Number(aarkMarketStatus.depthFactor);
  const skewness = Number(aarkMarketStatus.skewness);

  // Aark Buy
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
    if (deltaAmount < 0) {
      break;
    }
    orderSizeInAark += deltaAmount;
    if (deltaAmount !== q) {
      break;
    }
  }

  if (orderSizeInAark > 0) {
    return orderSizeInAark;
  }

  // Aark Sell
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
    if (deltaAmount < 0) {
      break;
    }
    orderSizeInAark -= deltaAmount;
    if (deltaAmount !== q) {
      break;
    }
  }

  return orderSizeInAark;
}

function getMarketSummary(
  crypto: string,
  cexMarket: IMarket,
  aarkMarket: IAarkMarket,
  usdcPrice: number,
  sizeInAark: number
): string[] {
  const cexMidUSDT =
    (cexMarket.orderbook!.bids[0][0] + cexMarket.orderbook!.asks[0][0]) / 2;
  const exchangePremium =
    (aarkMarket.indexPrice! / (cexMidUSDT / usdcPrice) - 1) * 100;
  const skewnessPremium =
    aarkMarket.marketStatus!.skewness / aarkMarket.marketStatus!.depthFactor;
  const skewnessUSDTValue =
    aarkMarket.marketStatus!.skewness * aarkMarket.indexPrice!;
  const fundingRate24h =
    (aarkMarket.marketStatus!.fundingRatePrice24h / aarkMarket.indexPrice!) *
    100;
  const enterValue = sizeInAark * cexMidUSDT;
  return [
    crypto,
    formatNumber(exchangePremium, 4),
    formatNumber(skewnessPremium, 4),
    formatNumber(skewnessUSDTValue, 4),
    formatNumber(fundingRate24h, 4),
    formatNumber(enterValue, 4),
  ];
}
