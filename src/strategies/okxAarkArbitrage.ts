import {
  Balance,
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
import { formatNumber, round_dp } from "../utils/number";
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
  premiumEMA: {},
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
  EMA_WINDOW,

  BASE_PRICE_DIFF_THRESHOLD,
  MIN_PRICE_DIFF_THRESHOLD,

  MAX_POSITION_USDT,
  UNHEDGED_THRESHOLD_USDT,
  MAX_ORDER_USDT,
  MIN_ORDER_USDT,
  MIN_ORDER_INTERVAL_MS,
  AARK_FUNDING_MULTIPLIER,
  MAX_MARKET_SKEWNESS_USDT,

  INITIAL_BALANCE_USDT,
  BALANCE_RATIO_IN_OKX,
  BALANCE_RATIO_IN_AARK,
  BALANCE_RATIO_DIFF_THRESHOLD,

  DATA_FETCH_TIME_THRESHOLD_MS,
] = [
  process.env.EMA_WINDOW!,

  process.env.BASE_PRICE_DIFF_THRESHOLD!,
  process.env.MIN_PRICE_DIFF_THRESHOLD!,

  process.env.MAX_POSITION_USDT!,
  process.env.UNHEDGED_THRESHOLD_USDT!,
  process.env.MAX_ORDER_USDT!,
  process.env.MIN_ORDER_USDT!,
  process.env.MIN_ORDER_INTERVAL_MS!,
  process.env.AARK_FUNDING_MULTIPLIER!,
  process.env.MAX_MARKET_SKEWNESS_USDT!,

  process.env.INITIAL_BALANCE_USDT!,
  process.env.BALANCE_RATIO_IN_OKX!,
  process.env.BALANCE_RATIO_IN_AARK!,
  process.env.BALANCE_RATIO_DIFF_THRESHOLD!,

  process.env.DATA_FETCH_TIME_THRESHOLD_MS!,
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
  const arbSnapshot: any = {};
  const dataFetchLatencyInfo: { [key: string]: number } = {};
  const strategyStart = Date.now();
  await Promise.all([
    aarkService.fetchIndexPrices().then(() => {
      dataFetchLatencyInfo["aarkService.fetchIndexPrices"] =
        Date.now() - strategyStart;
    }),
    aarkService.fetchUserStatus().then(() => {
      dataFetchLatencyInfo["aarkService.fetchUserStatus"] =
        Date.now() - strategyStart;
    }),
    ,
    aarkService.fetchMarketStatuses().then(() => {
      dataFetchLatencyInfo["aarkService.fetchMarketStatuses"] =
        Date.now() - strategyStart;
    }),
    cexService.fetchOpenOrders().then(() => {
      dataFetchLatencyInfo["cexService.fetchOpenOrders"] =
        Date.now() - strategyStart;
    }),
    ,
    cexService.fetchPositions().then(() => {
      dataFetchLatencyInfo["cexService.fetchPositions"] =
        Date.now() - strategyStart;
    }),
    ,
    cexService.fetchBalances().then(() => {
      dataFetchLatencyInfo["cexService.fetchBalances"] =
        Date.now() - strategyStart;
    }),
    ,
    cexService.fetchOrderbooks().then(() => {
      dataFetchLatencyInfo["cexService.fetchOrderbooks"] =
        Date.now() - strategyStart;
    }),
    ,
    cexService.fetchFundingRate().then(() => {
      dataFetchLatencyInfo["cexService.fetchFundingRate"] =
        Date.now() - strategyStart;
    }),
    ,
  ]);
  const dataFetchingTime = Date.now() - strategyStart;
  console.log(JSON.stringify(dataFetchLatencyInfo));
  Object.assign(arbSnapshot, { dataFetchingTime });
  console.log(`Data fetched : ${dataFetchingTime}ms`);
  if (dataFetchingTime > DATA_FETCH_TIME_THRESHOLD_MS) {
    await monitorService.slackMessage(
      `Arbitrage : Data Error`,
      `Took too much time to fetch data : ${dataFetchingTime}ms.`,
      false,
      false,
      true
    );
    return;
  }

  const cexInfo = cexService.getMarketInfo();
  const aarkInfo = aarkService.getMarketInfo();
  const cryptoList: string[] = JSON.parse(process.env.TARGET_CRYPTO_LIST!);

  const cexUSDCInfo = cexInfo[`USDC_USDT`].orderbook;
  if (cexUSDCInfo === undefined) {
    throw new Error(`[Data Fetch Fail] Failed to fetch USDC market Info`);
  }

  const cexBalance = cexService.getBalance();
  if (cexBalance === undefined) {
    throw new Error(`[Data Fetch Fail] Failed to fetch OKX balance Info`);
  }

  const aarkBalance = aarkService.getBalance();
  if (aarkBalance === undefined) {
    throw new Error(`[Data Fetch Fail] Failed to fetch AARK balance Info`);
  }

  const USDC_USDT_PRICE = (cexUSDCInfo.asks[0][0] + cexUSDCInfo.bids[0][0]) / 2;
  await checkBalance(cexBalance, aarkBalance, USDC_USDT_PRICE);
  let hedged = true;
  let arbitrageFound = false;
  for (const crypto of cryptoList) {
    try {
      const arbitrageInfo: any = {
        crypto,
      };
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

      updatePremiumEMA(
        crypto,
        cexOrderbook,
        aarkMarketStatus,
        aarkIndexPrice,
        USDC_USDT_PRICE
      );
      Object.assign(arbitrageInfo, {
        premiumEMA: LOCAL_STATE["premiumEMA"][crypto],
      });

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

      let [orderSizeInAark, thresholdInfo] = getArbAmountInAark(
        crypto,
        cexMarket,
        aarkMarket,
        USDC_USDT_PRICE
      );
      Object.assign(arbitrageInfo, thresholdInfo);

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
      Object.assign(arbitrageInfo, {
        usdcPrice: USDC_USDT_PRICE,
        cexAsk: cexOrderbook.asks[0][0],
        cexBid: cexOrderbook.bids[0][0],
        cexFundingRate: cexFundingRate,
        cexPosition,
        aarkPosition,
        aarkMarketStatus,
        aarkIndexPrice,
        orderSizeInAark,
        timestamp: Date.now(),
      });
      console.log(JSON.stringify(arbitrageInfo));
      if (
        orderSizeInAark !== 0 &&
        !hadOrderRecently(crypto, timestamp) &&
        !arbitrageFound
      ) {
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
        Object.assign(arbSnapshot, arbitrageInfo);
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

async function checkBalance(
  cexBalance: Balance[],
  aarkBalance: Balance[],
  usdcPrice: number
) {
  const cexBalanceUSDT = cexBalance
    .filter((balance) => balance.currency === "USDT")
    .reduce((acc, balance) => acc + balance.total, 0);
  const aarkBalanceUSDC = aarkBalance
    .filter((balance) => balance.currency === "USDC")
    .reduce((acc, balance) => acc + balance.total, 0);
  console.log(
    JSON.stringify({
      okxUSDT: round_dp(cexBalanceUSDT, 2),
      aarkUSDC: round_dp(aarkBalanceUSDC, 2),
    })
  );
  if (
    Math.abs(cexBalanceUSDT - INITIAL_BALANCE_USDT * BALANCE_RATIO_IN_OKX) >
    INITIAL_BALANCE_USDT * BALANCE_RATIO_DIFF_THRESHOLD
  ) {
    await monitorService.slackMessage(
      "OKX BALANCE OUT OF RANGE",
      `okx balance USDT : ${formatNumber(
        cexBalanceUSDT,
        2
      )}USDT\naark balance USDC: ${formatNumber(aarkBalanceUSDC, 2)}USDC`,
      true,
      true,
      false
    );
  }

  if (
    Math.abs(
      aarkBalanceUSDC - INITIAL_BALANCE_USDT * BALANCE_RATIO_IN_AARK * usdcPrice
    ) >
    INITIAL_BALANCE_USDT * BALANCE_RATIO_DIFF_THRESHOLD * usdcPrice
  ) {
    await monitorService.slackMessage(
      "AARK BALANCE OUT OF RANGE",
      `okx balance USDT : ${formatNumber(
        cexBalanceUSDT,
        2
      )}USDT\naark balance USDC: ${formatNumber(aarkBalanceUSDC, 2)}USDC`,
      true,
      true,
      false
    );
  }
}

function updatePremiumEMA(
  crypto: string,
  cexOrderbook: Orderbook,
  aarkMarketStatus: IAarkMarketStatus,
  aarkIndexPrice: number,
  usdcPrice: number
) {
  const premiumEMA = LOCAL_STATE["premiumEMA"][crypto];

  const premium =
    ((aarkIndexPrice *
      usdcPrice *
      (1 + aarkMarketStatus.skewness / aarkMarketStatus.depthFactor / 100)) /
      (cexOrderbook.asks[0][0] + cexOrderbook.bids[0][0])) *
      2 -
    1;
  LOCAL_STATE["premiumEMA"][crypto] =
    premiumEMA === undefined
      ? premium
      : premiumEMA * (1 - 1 / EMA_WINDOW) + premium / EMA_WINDOW;
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
  if (Math.abs(unhedgedSize) * midPrice > UNHEDGED_THRESHOLD_USDT) {
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
  crypto: string,
  cexMarket: IMarket,
  aarkMarket: IAarkMarket,
  usdcPrice: number
): [number, any] {
  const cexOrderbook = cexMarket.orderbook!;
  const cexMidUSDT = (cexOrderbook.bids[0][0] + cexOrderbook.asks[0][0]) / 2;
  const cexMarketInfo = cexMarket.marketInfo!;
  const cexFundingRate = cexMarket.fundingRate!;
  const cexPosition = cexMarket.position!;
  const aarkStatus = aarkMarket.marketStatus!;
  const aarkIndexPrice = aarkMarket.indexPrice!;
  const aarkPosition = aarkMarket.position!;
  const aarkFundingRate = aarkStatus.fundingRatePrice24h / aarkIndexPrice;

  const enterLongThreshold = calcEnterThreshold(
    cexFundingRate,
    aarkFundingRate,
    LOCAL_STATE["premiumEMA"][crypto],
    true
  );
  const enterShortThreshold = calcEnterThreshold(
    cexFundingRate,
    aarkFundingRate,
    -LOCAL_STATE["premiumEMA"][crypto],
    false
  );

  const thresholdInfo = {
    enterLong: round_dp(enterLongThreshold, 8),
    enterShort: round_dp(enterShortThreshold, 8),
  };

  let orderSizeInAark;
  // ENTER AARK LONG
  orderSizeInAark = _getArbBuyAmountInAark(
    cexOrderbook,
    cexMarketInfo,
    aarkStatus,
    aarkIndexPrice,
    enterLongThreshold,
    usdcPrice
  );
  if (aarkStatus.skewness < 0 && orderSizeInAark > 0) {
    // console.log(`ENTER LONG ${formatNumber(orderSizeInAark, 8)}`);
    return [
      _limitBuyOrderSize(
        orderSizeInAark,
        cexMidUSDT,
        aarkPosition.size,
        aarkStatus.skewness,
        false
      ),
      thresholdInfo,
    ];
  }

  // ENTER AARK SHORT
  orderSizeInAark = _getArbSellAmountInAark(
    cexOrderbook,
    cexMarketInfo,
    aarkStatus,
    aarkIndexPrice,
    enterShortThreshold,
    usdcPrice
  );
  if (aarkStatus.skewness > 0 && orderSizeInAark < 0) {
    // console.log(`ENTER SHORT ${formatNumber(orderSizeInAark, 8)}`);
    return [
      _limitSellOrderSize(
        orderSizeInAark,
        cexMidUSDT,
        aarkPosition.size,
        aarkStatus.skewness,
        false
      ),
      thresholdInfo,
    ];
  }

  return [0, thresholdInfo];
}

function calcEnterThreshold(
  cexFundingRate: FundingRate,
  aarkFundingRate24h: number,
  ema: number,
  isLong: boolean // true = ENTER AARK LONG, false = ENTER AARK SHORT
): number {
  const ts = Date.now();
  const sign = isLong ? 1 : -1;
  const cexFundingAdjTerm =
    -sign *
    cexFundingRate.fundingRate *
    ((EIGHT_HOUR_IN_MS + ts - cexFundingRate.fundingTime) / EIGHT_HOUR_IN_MS) **
      2;
  const aarkFundingAdjTerm =
    sign * AARK_FUNDING_MULTIPLIER * aarkFundingRate24h;
  return (
    ema +
    Math.max(
      BASE_PRICE_DIFF_THRESHOLD + cexFundingAdjTerm + aarkFundingAdjTerm,
      MIN_PRICE_DIFF_THRESHOLD
    )
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

function hadOrderRecently(crypto: string, timestamp: number) {
  if (
    LOCAL_STATE.lastOrderTimestamp[crypto] !== undefined &&
    LOCAL_STATE.lastOrderTimestamp[crypto] > timestamp - MIN_ORDER_INTERVAL_MS
  ) {
    console.log(crypto, LOCAL_STATE.lastOrderTimestamp[crypto], timestamp);
    return true;
  } else {
    return false;
  }
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

function updateLastOrderTimestamp(crypto: string, timestamp: number) {
  LOCAL_STATE.lastOrderTimestamp[crypto] = timestamp;
}
