import { Orderbook, Position } from "../interfaces/basic-interface";
import {
  IAarkMarket,
  IAarkMarketStatus,
  IMarket,
  IMarketInfo,
} from "../interfaces/market-interface";
import { IActionParam } from "../interfaces/order-interface";
import { AarkService } from "../services/aark.service";
import { OkxSwapService } from "../services/okx.service";
import { logActionParams } from "../utils/logger";
import { formatNumber } from "../utils/number";
import {
  addCreateMarketParams,
  adjustOrderSize,
  applyQtyPrecision,
  clampOrderSize,
} from "../utils/order";
import { validateAndReturnData } from "../utils/validation";
import { table } from "table";
import { MonitorService } from "../services/monitor.service";

interface IArbSnapshot {
  timestamp: number;
  crypto: string;
  orderSizeInAark: number;
  bestAsk: [number, number];
  bestBid: [number, number];
  usdcUsdtPrice: number;
  aarkIndexPrice: number;
  aarkMarketSkewness: number;
}

const LOCAL_STATE: { [key: string]: any } = {
  unhedgedCnt: 0,
};

const cexService = new OkxSwapService(
  process.env.OKX_API_KEY!,
  process.env.OKX_API_SECRET!,
  process.env.OKX_API_PASSWORD!,
  JSON.parse(process.env.TARGET_CRYPTO_LIST!)
    .map((symbol: string) => `${symbol}_USDT`)
    .concat(["USDC_USDT"])
);

const aarkService = new AarkService(
  process.env.ARBITRAGEUR_PK!,
  JSON.parse(process.env.TARGET_CRYPTO_LIST!).map(
    (symbol: string) => `${symbol}_USDC`
  )
);

const monitorService = new MonitorService(
  process.env.TWILIO_PARAM ? JSON.parse(process.env.TWILIO_PARAM) : undefined,
  process.env.SLACK_PARAM ? JSON.parse(process.env.SLACK_PARAM) : undefined
);

const [
  PRICE_DIFF_THRESHOLD,
  MAX_POSITION_USDT,
  UNHEDGED_THRESHOLD,
  MAX_ORDER_USDT,
  MIN_ORDER_USDT,
  DEFAULT_GAS_FEE_USDT,
] = [
  process.env.PRICE_DIFF_THRESHOLD!,
  process.env.MAX_POSITION_USDT!,
  process.env.UNHEDGED_THRESHOLD!,
  process.env.MAX_ORDER_USDT!,
  process.env.MIN_ORDER_USDT!,
  process.env.DEFAULT_GAS_FEE_USDT!,
].map((param: string) => parseFloat(param));
const MANAGER_SLACK_ID = process.env.MANAGER_SLACK_ID;

export async function initializeStrategy() {
  await cexService.init();
  await aarkService.init();
}

export async function strategy() {
  const cexActionParams: IActionParam[] = [];
  const aarkActionParams: IActionParam[] = [];
  const marketSummary: string[][] = [
    ["crypto", "Pm_ex%", "Pm_skew%", "$Skew", "Fr24h%", "$avl.Value"],
  ];
  const unhedgedDetected: string[][] = [
    ["crypto", "pos_bn", "pos_a", "unhedged value ($)"],
  ];
  const arbSnapshot: IArbSnapshot[] = [];

  await Promise.all([
    aarkService.fetchIndexPrices(),
    aarkService.fetchPositions(),
    aarkService.fetchMarketStatuses(),
    cexService.fetchOpenOrders(),
    cexService.fetchPositions(),
    cexService.fetchOrderbooks(),
  ]);

  const cexInfo = cexService.getMarketInfo();
  const aarkInfo = aarkService.getMarketInfo();
  const cryptoList: string[] = JSON.parse(process.env.TARGET_CRYPTO_LIST!);

  const cexUSDCInfo = cexInfo[`USDC_USDT`].orderbook;
  if (cexUSDCInfo === undefined) {
    throw new Error(`[Data Fetch Fail] Failed to fetch USDC market Info`);
  }
  const USDC_USDT_PRICE = (cexUSDCInfo.asks[0][0] + cexUSDCInfo.bids[0][0]) / 2;
  let hedged = true;
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

      const hedgeActionParams = getHedgeActionParam(
        crypto,
        unhedgedDetected,
        bnPosition,
        aarkPosition,
        cexMidUSDT
      );
      if (hedgeActionParams.length !== 0) {
        hedged = false;
        cexActionParams.push(...hedgeActionParams);
        continue;
      }

      let orderSizeInAark = calcArbAmount(
        bnOrderbook,
        cexMarketInfo.marketInfo,
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

      if (orderSizeInAark > 0) {
        orderSizeInAark = Math.min(
          orderSizeInAark,
          MAX_ORDER_USDT / cexMidUSDT,
          MAX_POSITION_USDT / cexMidUSDT - aarkPosition.size,
          Math.max(-aarkMarketStatus.skewness, 0)
        );
      } else {
        orderSizeInAark = Math.max(
          orderSizeInAark,
          -MAX_ORDER_USDT / cexMidUSDT,
          -MAX_POSITION_USDT / cexMidUSDT - aarkPosition.size,
          Math.min(-aarkMarketStatus.skewness, 0)
        );
      }

      orderSizeInAark = applyQtyPrecision(orderSizeInAark, [
        cexMarketInfo.marketInfo,
        aarkMarketInfo.marketInfo,
      ]);

      if (orderSizeInAark * cexMidUSDT < MIN_ORDER_USDT) {
        orderSizeInAark = 0;
      }

      if (orderSizeInAark !== 0) {
        arbSnapshot.push({
          timestamp: new Date().getTime(),
          crypto,
          orderSizeInAark,
          bestAsk: bnOrderbook.asks[0],
          bestBid: bnOrderbook.bids[0],
          usdcUsdtPrice: USDC_USDT_PRICE,
          aarkIndexPrice,
          aarkMarketSkewness: aarkMarketStatus.skewness,
        });
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
    console.log(
      table(marketSummary, {
        header: { alignment: "center", content: "Market Summary" },
      })
    );
  }

  if (!hedged) {
    LOCAL_STATE.unhedgedCnt += 1;
    if (LOCAL_STATE.unhedgedCnt >= 10) {
      await monitorService.slackMessage(
        `ARBITRAGEUR UNHEDGED`,
        `Unhedged for ${LOCAL_STATE.unhedgedCnt} iteration`,
        true,
        true
      );
    }
  }

  logActionParams(cexActionParams);
  logActionParams(aarkActionParams);

  await Promise.all([
    cexService.executeOrders(cexActionParams),
    aarkService.executeOrders(aarkActionParams),
  ]);

  await Promise.all([
    logOrderInfoToSlack(cexActionParams, aarkActionParams, arbSnapshot),
  ]);
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
    const absSizeToHedge = Math.min(
      Math.abs(unhedgedSize),
      MAX_ORDER_USDT / midPrice
    );
    addCreateMarketParams(hedgeActionParams, [
      {
        symbol: `${crypto}_USDT`,
        size: unhedgedSize < 0 ? absSizeToHedge : -absSizeToHedge,
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
  bnMarketInfo: IMarketInfo,
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
      q * bnMarketInfo.contractSize,
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
      q * bnMarketInfo.contractSize,
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

async function logOrderInfoToSlack(
  cexActionParams: IActionParam[],
  aarkActionParams: IActionParam[],
  arbSnapshot: IArbSnapshot[]
) {
  if (cexActionParams.length !== 0 || aarkActionParams.length !== 0) {
    await monitorService.slackMessage(
      "Arbitrage Detected",
      `Information : \n*CEX*\n${JSON.stringify(
        cexActionParams
      )}\n*AARK*\n${JSON.stringify(
        aarkActionParams
      )}\n*Snpashot*\n${JSON.stringify(arbSnapshot)}`
    );
  }
}
