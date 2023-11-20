import {
  FundingRate,
  Orderbook,
  Position,
} from "../interfaces/basic-interface";
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
import { addCreateMarketParams, applyQtyPrecision } from "../utils/order";
import { validateAndReturnData } from "../utils/validation";
import { table } from "table";
import { MonitorService } from "../services/monitor.service";
import { ONE_DAY_IN_MS, EIGHT_HOUR_IN_MS } from "../utils/time";

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
  lastOrderTimestamp: {},
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

const monitorService = MonitorService.getInstance();

const [
  PRICE_DIFF_THRESHOLD,
  MAX_POSITION_USDT,
  UNHEDGED_THRESHOLD,
  MAX_ORDER_USDT,
  MIN_ORDER_USDT,
  MIN_ORDER_INTERVAL,
  EXPECTED_POSITION_INTERVAL,
  MAX_MARKET_SKEWNESS_USDT,
] = [
  process.env.PRICE_DIFF_THRESHOLD!,
  process.env.MAX_POSITION_USDT!,
  process.env.UNHEDGED_THRESHOLD!,
  process.env.MAX_ORDER_USDT!,
  process.env.MIN_ORDER_USDT!,
  process.env.MIN_ORDER_INTERVAL!,
  process.env.EXPECTED_POSITION_INTERVAL!,
  process.env.MAX_MARKET_SKEWNESS_USDT!,
].map((param: string) => parseFloat(param));

export async function initializeStrategy() {
  await cexService.init();
  await aarkService.init();
}

export async function strategy() {
  const timestamp = Date.now();
  const cexActionParams: IActionParam[] = [];
  const aarkActionParams: IActionParam[] = [];
  const marketSummary: string[][] = [
    ["crypto", "Pm_ex%", "Pm_skew%", "$Skew", "Fr24h%", "$avl.Value"],
  ];
  const unhedgedDetected: string[][] = [
    ["crypto", "pos_cex", "pos_a", "unhedged value ($)"],
  ];
  const arbSnapshot: IArbSnapshot[] = [];
  const strategyStart = Date.now();
  await Promise.all([
    aarkService.fetchIndexPrices(),
    aarkService.fetchUserStatus(),
    aarkService.fetchMarketStatuses(),
    cexService.fetchOpenOrders(),
    cexService.fetchPositions(),
    cexService.fetchOrderbooks(),
    cexService.fetchFundingRate(),
  ]);
  console.log(`Data fetched : ${Date.now() - strategyStart}ms`);

  const cexInfo = cexService.getMarketInfo();
  const aarkInfo = aarkService.getMarketInfo();
  const cryptoList: string[] = JSON.parse(process.env.TARGET_CRYPTO_LIST!);

  const cexUSDCInfo = cexInfo[`USDC_USDT`].orderbook;
  if (cexUSDCInfo === undefined) {
    throw new Error(`[Data Fetch Fail] Failed to fetch USDC market Info`);
  }
  const USDC_USDT_PRICE = (cexUSDCInfo.asks[0][0] + cexUSDCInfo.bids[0][0]) / 2;
  let hedged = true;
  let arbitrageFound = false;
  for (const crypto of cryptoList) {
    console.log(`~~~~~~~ ${crypto} ~~~~~~~`);
    try {
      const cexMarket = cexInfo[`${crypto}_USDT`];
      const aarkMarket = aarkInfo[`${crypto}_USDC`];

      const [
        cexPosition,
        cexOrderbook,
        cexFundingRate,
        aarkPosition,
        aarkMarketStatus,
        aarkIndexPrice,
      ]: [
        Position,
        Orderbook,
        FundingRate,
        Position,
        IAarkMarketStatus,
        number
      ] = validateAndReturnData(
        [
          cexMarket.position,
          cexMarket.orderbook,
          cexMarket.fundingRate,
          aarkMarket.position,
          aarkMarket.marketStatus,
          aarkMarket.indexPrice,
        ],
        10000
      );

      const cexMidUSDT =
        (cexOrderbook.asks[0][0] + cexOrderbook.asks[0][0]) / 2;

      const hedgeActionParams = getHedgeActionParam(
        crypto,
        unhedgedDetected,
        cexMarket,
        aarkMarket
      );
      if (hedgeActionParams.length !== 0) {
        hedged = false;
        cexActionParams.push(...hedgeActionParams);
        continue;
      }

      let orderSizeInAark = getArbAmountInAark(
        cexMarket,
        aarkMarket,
        USDC_USDT_PRICE
      );

      marketSummary.push(
        getMarketSummary(
          crypto,
          cexMarket,
          aarkMarket,
          USDC_USDT_PRICE,
          orderSizeInAark
        )
      );
      orderSizeInAark = applyQtyPrecision(orderSizeInAark, [
        cexMarket.marketInfo,
        aarkMarket.marketInfo,
      ]);
      if (Math.abs(orderSizeInAark) * cexMidUSDT < MIN_ORDER_USDT) {
        orderSizeInAark = 0;
      }
      if (
        orderSizeInAark !== 0 &&
        !hadOrderRecently(crypto, timestamp) &&
        !arbitrageFound
      ) {
        arbSnapshot.push({
          timestamp,
          crypto,
          orderSizeInAark,
          bestAsk: cexOrderbook.asks[0],
          bestBid: cexOrderbook.bids[0],
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
        updateLastOrderTimestamp(crypto, timestamp);
        arbitrageFound = true;
      }
    } catch (e) {
      console.log("Failed to get market action params : ", e);
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
      LOCAL_STATE.unhedgedCnt = 0;
    }
  }

  logActionParams(cexActionParams);
  logActionParams(aarkActionParams);

  await Promise.all([
    cexService.executeOrders(cexActionParams),
    aarkService.executeOrders(aarkActionParams),
  ]);
  console.log(`Strategy end. Elapsed ${Date.now() - strategyStart}ms`);
  await logOrderInfoToSlack(cexActionParams, aarkActionParams, arbSnapshot);
}

function getHedgeActionParam(
  crypto: string,
  unhedgedDetected: string[][],
  cexMarket: IMarket,
  aarkMarket: IAarkMarket
) {
  const cexPosition = cexMarket.position!;
  const aarkPosition = aarkMarket.position!;
  const midPrice =
    (cexMarket.orderbook!.asks[0][0] + cexMarket.orderbook!.bids[0][0]) / 2;
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

function getArbAmountInAark(
  cexMarket: IMarket,
  aarkMarket: IAarkMarket,
  usdcPrice: number
): number {
  const cexOrderbook = cexMarket.orderbook!;
  const cexMidUSDT = (cexOrderbook.bids[0][0] + cexOrderbook.asks[0][0]) / 2;
  const cexMarketInfo = cexMarket.marketInfo!;
  const cexFundingRate = cexMarket.fundingRate!;
  const cexPosition = cexMarket.position!;
  const aarkStatus = aarkMarket.marketStatus!;
  const aarkIndexPrice = aarkMarket.indexPrice!;
  const aarkPosition = aarkMarket.position!;
  const aarkFundingRate = aarkStatus.fundingRatePrice24h / aarkIndexPrice;
  const positionPremium =
    aarkPosition.size === 0
      ? 0
      : aarkPosition.size > 0
      ? cexPosition.price / aarkPosition.price - 1
      : aarkPosition.price / cexPosition.price - 1;
  const enterLongTreshold = calcEnterThreshold(
    cexFundingRate,
    aarkFundingRate,
    true
  );
  const enterShortTreshold = calcEnterThreshold(
    cexFundingRate,
    aarkFundingRate,
    false
  );
  const exitLongTreshold = calcExitThreshold(
    cexFundingRate,
    aarkFundingRate,
    positionPremium,
    true
  );
  const exitShortTreshold = calcExitThreshold(
    cexFundingRate,
    aarkFundingRate,
    positionPremium,
    false
  );

  console.log(`
ENTER LONG  : ${formatNumber(enterLongTreshold, 8)}
ENTER SHORT : ${formatNumber(enterShortTreshold, 8)}
EXIT LONG   : ${formatNumber(exitLongTreshold, 8)}
EXIT SHORT  : ${formatNumber(exitShortTreshold, 8)}
`);
  let orderSizeInAark;
  // ENTER AARK LONG
  orderSizeInAark = _getArbBuyAmountInAark(
    cexOrderbook,
    cexMarketInfo,
    aarkStatus,
    aarkIndexPrice,
    calcEnterThreshold(cexFundingRate, aarkFundingRate, true),
    usdcPrice
  );
  if (aarkStatus.skewness < 0 && orderSizeInAark > 0) {
    // console.log(`ENTER LONG ${formatNumber(orderSizeInAark, 8)}`);
    return _limitBuyOrderSize(
      orderSizeInAark,
      cexMidUSDT,
      aarkPosition.size,
      aarkStatus.skewness,
      false
    );
  }

  // ENTER AARK SHORT
  orderSizeInAark = _getArbSellAmountInAark(
    cexOrderbook,
    cexMarketInfo,
    aarkStatus,
    aarkIndexPrice,
    calcEnterThreshold(cexFundingRate, aarkFundingRate, false),
    usdcPrice
  );
  if (aarkStatus.skewness > 0 && orderSizeInAark < 0) {
    // console.log(`ENTER SHORT ${formatNumber(orderSizeInAark, 8)}`);
    return _limitSellOrderSize(
      orderSizeInAark,
      cexMidUSDT,
      aarkPosition.size,
      aarkStatus.skewness,
      false
    );
  }

  if (aarkPosition.size !== 0) {
    // EXIT AARK LONG (= AARK SHORT)
    orderSizeInAark = _getArbSellAmountInAark(
      cexOrderbook,
      cexMarketInfo,
      aarkStatus,
      aarkIndexPrice,
      calcExitThreshold(cexFundingRate, aarkFundingRate, positionPremium, true),
      usdcPrice
    );
    if (aarkPosition.size > 0 && orderSizeInAark < 0) {
      // console.log(`EXIT LONG ${formatNumber(orderSizeInAark, 8)}`);
      return _limitSellOrderSize(
        orderSizeInAark,
        cexMidUSDT,
        aarkPosition.size,
        aarkStatus.skewness,
        true
      );
    }

    // EXIT AARK SHORT (= AARK LONG)
    orderSizeInAark = _getArbBuyAmountInAark(
      cexOrderbook,
      cexMarketInfo,
      aarkStatus,
      aarkIndexPrice,
      calcExitThreshold(
        cexFundingRate,
        aarkFundingRate,
        positionPremium,
        false
      ),
      usdcPrice
    );
    if (aarkPosition.size < 0 && orderSizeInAark > 0) {
      // console.log(`EXIT SHORT ${formatNumber(orderSizeInAark, 8)}`);
      return _limitBuyOrderSize(
        orderSizeInAark,
        cexMidUSDT,
        aarkPosition.size,
        aarkStatus.skewness,
        true
      );
    }
  } else {
    return 0;
  }

  return 0;
}

function calcEnterThreshold(
  cexFundingRate: FundingRate,
  aarkFundingRate24h: number,
  isBuy: boolean // true = ENTER AARK LONG, false = ENTER AARK SHORT
): number {
  const ts = Date.now();
  const sign = isBuy ? 1 : -1;
  const cexFundingAdjTerm =
    -sign *
    cexFundingRate.fundingRate *
    ((cexFundingRate.fundingTime - ts) / EIGHT_HOUR_IN_MS) ** 2;
  const aarkFundingAdjTerm =
    ((sign * EXPECTED_POSITION_INTERVAL) / ONE_DAY_IN_MS) * aarkFundingRate24h;
  return PRICE_DIFF_THRESHOLD + cexFundingAdjTerm + aarkFundingAdjTerm;
}

function calcExitThreshold(
  cexFundingRate: FundingRate,
  aarkFundingRate24h: number,
  enterPricePremium: number,
  isBuy: boolean // true = EXIT AARK LONG = AARK SHORT, false = EXIT AARK SHORT = AARK LONG
): number {
  const ts = Date.now();
  const sign = isBuy ? 1 : -1;
  const cexFundingAdjTerm = -Math.max(
    -sign *
      cexFundingRate.fundingRate *
      ((cexFundingRate.fundingTime - ts) / EIGHT_HOUR_IN_MS) ** 2,
    0
  );
  const aarkFundingAdjTerm = -Math.max(
    ((sign * EXPECTED_POSITION_INTERVAL) / ONE_DAY_IN_MS) * aarkFundingRate24h,
    0
  );
  const positionPremiumAdjTerm = -Math.max(enterPricePremium, 0);
  return (
    PRICE_DIFF_THRESHOLD +
    cexFundingAdjTerm +
    aarkFundingAdjTerm +
    positionPremiumAdjTerm
  );
}

function _getArbBuyAmountInAark(
  cexOrderbook: Orderbook,
  cexMarketInfo: IMarketInfo,
  aarkMarketStatus: IAarkMarketStatus,
  aarkIndexPrice: number,
  threshold: number,
  usdcPrice: number
): number {
  const depthFactor = Number(aarkMarketStatus.depthFactor);
  const skewness = Number(aarkMarketStatus.skewness);

  // Aark Buy
  let orderSizeInAark = 0;
  for (const [p, q] of cexOrderbook.bids) {
    const deltaAmount = Math.min(
      q * cexMarketInfo.contractSize,
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
  return orderSizeInAark;
}

function _getArbSellAmountInAark(
  cexOrderbook: Orderbook,
  cexMarketInfo: IMarketInfo,
  aarkMarketStatus: IAarkMarketStatus,
  aarkIndexPrice: number,
  threshold: number,
  usdcPrice: number
): number {
  const depthFactor = Number(aarkMarketStatus.depthFactor);
  const skewness = Number(aarkMarketStatus.skewness);

  let orderSizeInAark = 0;
  for (const [p, q] of cexOrderbook.asks) {
    const deltaAmount = Math.min(
      q * cexMarketInfo.contractSize,
      2 *
        (-100 *
          depthFactor *
          (((p / usdcPrice) * (1 + threshold)) / aarkIndexPrice - 1) +
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

function _limitBuyOrderSize(
  orderSizeInAark: number,
  cexMidUSDT: number,
  aarkPositionSize: number,
  skewness: number,
  isExit: boolean
): number {
  return Math.min(
    orderSizeInAark,
    MAX_ORDER_USDT / cexMidUSDT,
    MAX_POSITION_USDT / cexMidUSDT - aarkPositionSize,
    isExit
      ? -aarkPositionSize
      : Math.max(
          -(skewness + aarkPositionSize) / 2,
          -skewness - MAX_MARKET_SKEWNESS_USDT / cexMidUSDT,
          0
        )
  );
}

function _limitSellOrderSize(
  orderSizeInAark: number,
  cexMidUSDT: number,
  aarkPositionSize: number,
  skewness: number,
  isExit: boolean
): number {
  return Math.max(
    orderSizeInAark,
    -MAX_ORDER_USDT / cexMidUSDT,
    -MAX_POSITION_USDT / cexMidUSDT - aarkPositionSize,
    isExit
      ? -aarkPositionSize
      : Math.min(
          -(skewness + aarkPositionSize) / 2,
          -skewness + MAX_MARKET_SKEWNESS_USDT / cexMidUSDT,
          0
        )
  );
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
    const cryptoList = Array.from(
      new Set(
        cexActionParams
          .concat(aarkActionParams)
          .map((ap) => ap.symbol.split("_")[0])
      )
    ).join(",");
    await monitorService.slackMessage(
      `Arbitrage Detected : ${cryptoList}`,
      `\n*CEX ORDER*\n${JSON.stringify(
        cexActionParams
      )}\n*AARK ORDER*\n${JSON.stringify(
        aarkActionParams
      )}\n*Snpashot*\n${JSON.stringify(arbSnapshot)}`,
      false,
      false,
      true
    );
  }
}

function hadOrderRecently(crypto: string, timestamp: number) {
  if (
    LOCAL_STATE.lastOrderTimestamp[crypto] !== undefined &&
    LOCAL_STATE.lastOrderTimestamp[crypto] > timestamp - MIN_ORDER_INTERVAL
  ) {
    console.log(crypto, LOCAL_STATE.lastOrderTimestamp[crypto], timestamp);
    return true;
  } else {
    return false;
  }
}

function updateLastOrderTimestamp(crypto: string, timestamp: number) {
  LOCAL_STATE.lastOrderTimestamp[crypto] = timestamp;
}
