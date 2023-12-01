import { checkObjectKeys } from "../utils/env";
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
import { MonitorService } from "../services/monitor.service";
import { OkxSwapService } from "../services/okx.service";
import { formatNumber, round_dp } from "../utils/number";
import { addCreateMarketParams, applyQtyPrecision } from "../utils/order";
import { EIGHT_HOUR_IN_MS } from "../utils/time";
import { isValidData } from "../utils/validation";

export class Strategy {
  private readonly aarkService: AarkService;
  private readonly okxService: OkxSwapService;
  private readonly monitorService = MonitorService.getInstance();
  private params: any = {};
  private readonly localState = {
    unhedgedCnt: 0,
    lastOrderTimestamp: {} as { [key: string]: number },
    premiumEMA: {} as { [key: string]: { value: number; weight: number } },
    arbSnapshot: {},
  };

  constructor() {
    this._readEnvParams();
    const targetCryptoList = Object.keys(this.params.MARKET_PARAMS);
    this.aarkService = new AarkService(
      process.env.ARBITRAGEUR_PK!,
      targetCryptoList.map((symbol: string) => `${symbol}_USDC`)
    );
    this.okxService = new OkxSwapService(
      process.env.OKX_API_KEY!,
      process.env.OKX_API_SECRET!,
      process.env.OKX_API_PASSWORD!,
      targetCryptoList
        .map((symbol: string) => `${symbol}_USDT`)
        .concat(["USDC_USDT"])
    );
  }

  async init() {
    await this.okxService.init();
    await this.aarkService.init();
  }

  async run() {
    const strategyStart = Date.now();
    const arbSnapshot: any = {};
    const marketParams = this.params.MARKET_PARAMS;
    const okxActionParams: IActionParam[] = [];
    const aarkActionParams: IActionParam[] = [];

    if (!(await this._fetchData())) {
      return;
    }
    this._checkBalance();

    const okxMarkets = this.okxService.getMarketInfo();
    const aarkMarkets = this.aarkService.getMarketInfo();

    const cryptoList: string[] = Object.keys(marketParams);
    const okxUSDCOrderbook = okxMarkets[`USDC_USDT`].orderbook!;
    const USDC_USDT_PRICE =
      (okxUSDCOrderbook.asks[0][0] + okxUSDCOrderbook.bids[0][0]) / 2;

    let hedged = true;
    let arbitrageFound = false;
    const detectionStart = Date.now();
    for (const crypto of cryptoList) {
      const marketArbitrageInfo: any = {
        crypto,
      };
      const okxMarket = okxMarkets[`${crypto}_USDT`];
      const aarkMarket = aarkMarkets[`${crypto}_USDC`];

      if (
        !isValidData(
          [
            okxMarket.position,
            okxMarket.orderbook,
            okxMarket.fundingRate,
            aarkMarket.position,
            aarkMarket.marketStatus,
            aarkMarket.indexPrice,
          ],
          10000
        )
      ) {
        this.monitorService.slackMessage(
          "Data Validation Fail",
          "",
          60_000,
          false,
          false
        );
        continue;
      }
      const okxOrderbook = okxMarket.orderbook!;
      const okxMidUSDT =
        (okxOrderbook.asks[0][0] + okxOrderbook.bids[0][0]) / 2;

      this._updatePremiumEMA(crypto, okxMarket, aarkMarket, USDC_USDT_PRICE);
      Object.assign(marketArbitrageInfo, {
        premiumEMA: this.localState.premiumEMA[crypto].value,
      });

      const hedgeActionParams = this._getHedgeActionParam(
        crypto,
        okxMarket,
        aarkMarket
      );
      if (
        hedgeActionParams.length !== 0 &&
        !this._hadOrderRecently(crypto, detectionStart, 20_000)
      ) {
        hedged = false;
        aarkActionParams.push(...hedgeActionParams);
        this._updateLastOrderTimestamp(crypto, detectionStart);
        break;
      }

      let [orderSizeInAark, thresholdInfo] = this._getArbAmountInAark(
        crypto,
        okxMarket,
        aarkMarket,
        USDC_USDT_PRICE
      );
      Object.assign(marketArbitrageInfo, thresholdInfo);

      orderSizeInAark = applyQtyPrecision(orderSizeInAark, [
        okxMarket.marketInfo,
        aarkMarket.marketInfo,
      ]);
      if (
        Math.abs(orderSizeInAark) * okxMidUSDT <
        marketParams[crypto].MIN_ORDER_USDT
      ) {
        orderSizeInAark = 0;
      }
      Object.assign(marketArbitrageInfo, {
        usdcPrice: USDC_USDT_PRICE,
        okxAsk: okxOrderbook.asks[0][0],
        okxBid: okxOrderbook.bids[0][0],
        okxFundingRate: okxMarket.fundingRate,
        okxPosition: okxMarket.position,
        aarkPosition: aarkMarket.position,
        aarkMarketStatus: aarkMarket.marketStatus,
        aarkIndexPrice: aarkMarket.indexPrice,
        orderSizeInAark,
        timestamp: Date.now(),
      });
      console.log(JSON.stringify(marketArbitrageInfo));
      if (
        orderSizeInAark !== 0 &&
        !this._hadOrderRecently(
          crypto,
          detectionStart,
          marketParams[crypto].MIN_ORDER_INTERVAL_MS
        ) &&
        !arbitrageFound
      ) {
        addCreateMarketParams(okxActionParams, [
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
        this._updateLastOrderTimestamp(crypto, detectionStart);
        arbitrageFound = true;
        Object.assign(arbSnapshot, marketArbitrageInfo);
      }
    }
    this._logActionParams(okxActionParams);
    this._logActionParams(aarkActionParams);

    try {
      await Promise.all([
        this.okxService.executeOrders(okxActionParams),
        this.aarkService.executeOrders(aarkActionParams),
      ]);
    } catch (e) {
      this.monitorService.slackMessage(
        `EXECUTION ERROR`,
        `Failed to execute order : ${e}`,
        0,
        true,
        true
      );
    }

    console.log(`Strategy end. Elapsed ${Date.now() - strategyStart}ms`);
    if (!hedged) {
      this.monitorService.slackMessage(
        `ARBITRAGEUR UNHEDGED`,
        `Unhedged for ${this.localState.unhedgedCnt} iteration`,
        60_000,
        true,
        true
      );
    } else {
      this._logOrderInfoToSlack(okxActionParams, aarkActionParams, arbSnapshot);
    }

    return;
  }

  _readEnvParams() {
    const [
      INITIAL_BALANCE_USDT,
      BALANCE_RATIO_IN_OKX,
      BALANCE_RATIO_IN_AARK,
      BALANCE_RATIO_DIFF_THRESHOLD,

      DATA_FETCH_TIME_THRESHOLD_MS,
    ] = [
      process.env.INITIAL_BALANCE_USDT!,
      process.env.BALANCE_RATIO_IN_OKX!,
      process.env.BALANCE_RATIO_IN_AARK!,
      process.env.BALANCE_RATIO_DIFF_THRESHOLD!,

      process.env.DATA_FETCH_TIME_THRESHOLD_MS!,
    ].map((param: string) => parseFloat(param));

    const MARKET_PARAMS = JSON.parse(process.env.MARKET_PARAMS!);
    if (
      !checkObjectKeys(Object.values(MARKET_PARAMS), [
        "EMA_WINDOW",
        "BASE_PRICE_DIFF_THRESHOLD",
        "MIN_PRICE_DIFF_THRESHOLD",
        "MAX_POSITION_USDT",
        "MAX_ORDER_USDT",
        "MIN_ORDER_USDT",
        "MIN_ORDER_INTERVAL_MS",
        "UNHEDGED_THRESHOLD_USDT",
        "AARK_FUNDING_MULTIPLIER",
        "MAX_MARKET_SKEWNESS_USDT",
      ])
    ) {
      throw new Error("Market key test failed. Check keys for each param.");
    }
    this.params = {
      INITIAL_BALANCE_USDT,
      BALANCE_RATIO_IN_OKX,
      BALANCE_RATIO_IN_AARK,
      BALANCE_RATIO_DIFF_THRESHOLD,
      DATA_FETCH_TIME_THRESHOLD_MS,
      MARKET_PARAMS,
    };
  }

  async _fetchData(): Promise<boolean> {
    const timestamp = Date.now();
    const dataFetchLatencyInfo: { [key: string]: number } = {};
    await Promise.all([
      this.aarkService.fetchIndexPrices().then(() => {
        dataFetchLatencyInfo["aarkService.fetchIndexPrices"] =
          Date.now() - timestamp;
      }),
      this.aarkService.fetchUserStatus().then(() => {
        dataFetchLatencyInfo["aarkService.fetchUserStatus"] =
          Date.now() - timestamp;
      }),
      ,
      this.aarkService.fetchMarketStatuses().then(() => {
        dataFetchLatencyInfo["aarkService.fetchMarketStatuses"] =
          Date.now() - timestamp;
      }),
      this.okxService.fetchOpenOrders().then(() => {
        dataFetchLatencyInfo["okxService.fetchOpenOrders"] =
          Date.now() - timestamp;
      }),
      ,
      this.okxService.fetchPositions().then(() => {
        dataFetchLatencyInfo["okxService.fetchPositions"] =
          Date.now() - timestamp;
      }),
      ,
      this.okxService.fetchBalances().then(() => {
        dataFetchLatencyInfo["okxService.fetchBalances"] =
          Date.now() - timestamp;
      }),
      ,
      this.okxService.fetchOrderbooks().then(() => {
        dataFetchLatencyInfo["okxService.fetchOrderbooks"] =
          Date.now() - timestamp;
      }),
      ,
      this.okxService.fetchFundingRate().then(() => {
        dataFetchLatencyInfo["okxService.fetchFundingRate"] =
          Date.now() - timestamp;
      }),
      ,
    ]);
    const dataFetchingTime = Date.now() - timestamp;
    console.log(JSON.stringify(dataFetchLatencyInfo));
    Object.assign(this.localState.arbSnapshot, { dataFetchingTime });
    console.log(`Data fetched : ${dataFetchingTime}ms`);
    if (dataFetchingTime > this.params.DATA_FETCH_TIME_THRESHOLD_MS) {
      return false;
    } else {
      return true;
    }
  }

  _checkBalance() {
    const okxBalance = this.okxService.getBalance();
    if (okxBalance === undefined) {
      throw new Error(`[Data Fetch Fail] Failed to fetch OKX balance Info`);
    }

    const aarkBalance = this.aarkService.getBalance();
    if (aarkBalance === undefined) {
      throw new Error(`[Data Fetch Fail] Failed to fetch AARK balance Info`);
    }

    const okxBalanceUSDT = okxBalance
      .filter((balance) => balance.currency === "USDT")
      .reduce((acc, balance) => acc + balance.total, 0);
    const aarkBalanceUSDC = aarkBalance
      .filter((balance) => balance.currency === "USDC")
      .reduce((acc, balance) => acc + balance.total, 0);
    console.log(
      JSON.stringify({
        okxUSDT: round_dp(okxBalanceUSDT, 2),
        aarkUSDC: round_dp(aarkBalanceUSDC, 2),
      })
    );
    if (
      Math.abs(
        okxBalanceUSDT -
          this.params.INITIAL_BALANCE_USDT * this.params.BALANCE_RATIO_IN_OKX
      ) >
      this.params.INITIAL_BALANCE_USDT *
        this.params.BALANCE_RATIO_DIFF_THRESHOLD
    ) {
      this.monitorService.slackMessage(
        "OKX BALANCE OUT OF RANGE",
        `okx balance USDT : ${formatNumber(
          okxBalanceUSDT,
          2
        )}USDT\naark balance USDC: ${formatNumber(aarkBalanceUSDC, 2)}USDC`,
        60_000,
        true,
        true
      );
    }
  }

  _updatePremiumEMA(
    crypto: string,
    okxMarket: IMarket,
    aarkMarket: IAarkMarket,
    usdcPrice: number
  ) {
    const premiumEMA = this.localState.premiumEMA[crypto];
    const okxMidUSDT =
      (okxMarket.orderbook!.asks[0][0] + okxMarket.orderbook!.bids[0][0]) / 2;
    const premium =
      (aarkMarket.indexPrice! *
        usdcPrice *
        (1 +
          aarkMarket.marketStatus!.skewness /
            aarkMarket.marketStatus!.depthFactor /
            100)) /
        okxMidUSDT -
      1;
    if (premiumEMA === undefined) {
      this.localState.premiumEMA[crypto] = {
        value: premium,
        weight: 1,
      };
    } else {
      const emaWeight = Math.min(
        this.params.MARKET_PARAMS[crypto].EMA_WINDOW - 1,
        premiumEMA.weight
      );

      this.localState.premiumEMA[crypto] = {
        value: (premiumEMA.value * emaWeight + premium) / (emaWeight + 1),
        weight: emaWeight + 1,
      };
    }
  }

  _getHedgeActionParam(
    crypto: string,
    okxMarket: IMarket,
    aarkMarket: IAarkMarket
  ) {
    const marketParam = this.params.MARKET_PARAMS[crypto];
    const okxPosition = okxMarket.position!;
    const aarkPosition = aarkMarket.position!;
    const midPrice =
      (okxMarket.orderbook!.asks[0][0] + okxMarket.orderbook!.bids[0][0]) / 2;
    const hedgeActionParams: IActionParam[] = [];
    const unhedgedSize = okxPosition.size + aarkPosition.size;
    if (
      Math.abs(unhedgedSize) * midPrice >
      marketParam.UNHEDGED_THRESHOLD_USDT
    ) {
      const absSizeToHedge = Math.min(
        Math.abs(unhedgedSize),
        marketParam.MAX_ORDER_USDT / midPrice
      );
      addCreateMarketParams(hedgeActionParams, [
        {
          symbol: `${crypto}_USDC`,
          size: applyQtyPrecision(
            unhedgedSize < 0 ? absSizeToHedge : -absSizeToHedge,
            [aarkMarket.marketInfo]
          ),
        },
      ]);
    }
    return hedgeActionParams;
  }

  _updateLastOrderTimestamp(crypto: string, timestamp: number) {
    this.localState.lastOrderTimestamp[crypto] = timestamp;
  }

  _hadOrderRecently(crypto: string, timestamp: number, interval: number) {
    if (
      this.localState.lastOrderTimestamp[crypto] !== undefined &&
      this.localState.lastOrderTimestamp[crypto] > timestamp - interval
    ) {
      console.log(
        crypto,
        this.localState.lastOrderTimestamp[crypto],
        timestamp
      );
      return true;
    } else {
      return false;
    }
  }

  _calcEnterThreshold(
    crypto: string,
    okxFundingRate: FundingRate,
    aarkFundingRate24h: number,
    ema: number,
    isLong: boolean // true = ENTER AARK LONG, false = ENTER AARK SHORT
  ): number {
    const marketParam = this.params.MARKET_PARAMS[crypto];
    const ts = Date.now();
    const sign = isLong ? 1 : -1;
    const okxFundingAdjTerm =
      -sign *
      okxFundingRate.fundingRate *
      ((EIGHT_HOUR_IN_MS + ts - okxFundingRate.fundingTime) /
        EIGHT_HOUR_IN_MS) **
        2;
    const aarkFundingAdjTerm =
      sign * marketParam.AARK_FUNDING_MULTIPLIER * aarkFundingRate24h;
    return (
      -sign * ema +
      Math.max(
        marketParam.BASE_PRICE_DIFF_THRESHOLD +
          okxFundingAdjTerm +
          aarkFundingAdjTerm,
        marketParam.MIN_PRICE_DIFF_THRESHOLD
      )
    );
  }

  _getArbBuyAmountInAark(
    okxOrderbook: Orderbook,
    okxMarketInfo: IMarketInfo,
    aarkMarketStatus: IAarkMarketStatus,
    aarkIndexPrice: number,
    threshold: number,
    usdcPrice: number
  ): number {
    const depthFactor = Number(aarkMarketStatus.depthFactor);
    const skewness = Number(aarkMarketStatus.skewness);

    // Aark Buy
    let orderSizeInAark = 0;
    for (const [p, q] of okxOrderbook.bids) {
      const deltaAmount = Math.min(
        q * okxMarketInfo.contractSize,
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

  _getArbSellAmountInAark(
    okxOrderbook: Orderbook,
    okxMarketInfo: IMarketInfo,
    aarkMarketStatus: IAarkMarketStatus,
    aarkIndexPrice: number,
    threshold: number,
    usdcPrice: number
  ): number {
    const depthFactor = Number(aarkMarketStatus.depthFactor);
    const skewness = Number(aarkMarketStatus.skewness);

    let orderSizeInAark = 0;
    for (const [p, q] of okxOrderbook.asks) {
      const deltaAmount = Math.min(
        q * okxMarketInfo.contractSize,
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

  _limitBuyOrderSize(
    crypto: string,
    orderSizeInAark: number,
    okxMidUSDT: number,
    aarkPositionSize: number,
    skewness: number,
    isExit: boolean
  ): number {
    const marketParam = this.params.MARKET_PARAMS[crypto];
    return Math.min(
      orderSizeInAark,
      marketParam.MAX_ORDER_USDT / okxMidUSDT,
      marketParam.MAX_POSITION_USDT / okxMidUSDT - aarkPositionSize,
      isExit
        ? -aarkPositionSize
        : Math.max(
            -(skewness + aarkPositionSize) / 2,
            -skewness - marketParam.MAX_MARKET_SKEWNESS_USDT / okxMidUSDT,
            0
          )
    );
  }

  _limitSellOrderSize(
    crypto: string,
    orderSizeInAark: number,
    okxMidUSDT: number,
    aarkPositionSize: number,
    skewness: number,
    isExit: boolean
  ): number {
    const marketParam = this.params.MARKET_PARAMS[crypto];
    return Math.max(
      orderSizeInAark,
      -marketParam.MAX_ORDER_USDT / okxMidUSDT,
      -marketParam.MAX_POSITION_USDT / okxMidUSDT - aarkPositionSize,
      isExit
        ? -aarkPositionSize
        : Math.min(
            -(skewness + aarkPositionSize) / 2,
            -skewness + marketParam.MAX_MARKET_SKEWNESS_USDT / okxMidUSDT,
            0
          )
    );
  }

  _getArbAmountInAark(
    crypto: string,
    okxMarket: IMarket,
    aarkMarket: IAarkMarket,
    usdcPrice: number
  ): [number, { enterLong: number; enterShort: number }] {
    const okxOrderbook = okxMarket.orderbook!;
    const okxMidUSDT = (okxOrderbook.bids[0][0] + okxOrderbook.asks[0][0]) / 2;
    const okxMarketInfo = okxMarket.marketInfo!;
    const okxFundingRate = okxMarket.fundingRate!;
    const okxPosition = okxMarket.position!;
    const aarkStatus = aarkMarket.marketStatus!;
    const aarkIndexPrice = aarkMarket.indexPrice!;
    const aarkPosition = aarkMarket.position!;
    const aarkFundingRate = aarkStatus.fundingRatePrice24h / aarkIndexPrice;
    const premiumEMA = this.localState.premiumEMA[crypto].value;

    const enterLongThreshold = this._calcEnterThreshold(
      crypto,
      okxFundingRate,
      aarkFundingRate,
      premiumEMA,
      true
    );
    const enterShortThreshold = this._calcEnterThreshold(
      crypto,
      okxFundingRate,
      aarkFundingRate,
      premiumEMA,
      false
    );

    const thresholdInfo = {
      enterLong: round_dp(enterLongThreshold, 8),
      enterShort: round_dp(enterShortThreshold, 8),
    };

    let orderSizeInAark;
    // ENTER AARK LONG
    orderSizeInAark = this._getArbBuyAmountInAark(
      okxOrderbook,
      okxMarket.marketInfo,
      aarkStatus,
      aarkIndexPrice,
      enterLongThreshold,
      usdcPrice
    );
    if (orderSizeInAark > 0) {
      // console.log(`ENTER LONG ${formatNumber(orderSizeInAark, 8)}`);
      return [
        this._limitBuyOrderSize(
          crypto,
          orderSizeInAark,
          okxMidUSDT,
          aarkPosition.size,
          aarkStatus.skewness,
          false
        ),
        thresholdInfo,
      ];
    }

    // ENTER AARK SHORT
    orderSizeInAark = this._getArbSellAmountInAark(
      okxOrderbook,
      okxMarket.marketInfo,
      aarkStatus,
      aarkIndexPrice,
      enterShortThreshold,
      usdcPrice
    );
    if (orderSizeInAark < 0) {
      // console.log(`ENTER SHORT ${formatNumber(orderSizeInAark, 8)}`);
      return [
        this._limitSellOrderSize(
          crypto,
          orderSizeInAark,
          okxMidUSDT,
          aarkPosition.size,
          aarkStatus.skewness,
          false
        ),
        thresholdInfo,
      ];
    }

    return [0, thresholdInfo];
  }

  _logActionParams(actionParams: IActionParam[]) {
    console.log(
      JSON.stringify(actionParams.map((ap: IActionParam) => ap.order))
    );
  }

  _logOrderInfoToSlack(
    cexActionParams: IActionParam[],
    aarkActionParams: IActionParam[],
    arbSnapshot: any[]
  ) {
    if (cexActionParams.length !== 0 || aarkActionParams.length !== 0) {
      const cryptoList = Array.from(
        new Set(
          cexActionParams
            .concat(aarkActionParams)
            .map((ap) => ap.symbol.split("_")[0])
        )
      ).join(",");
      this.monitorService.slackMessage(
        `Arbitrage Detected : ${cryptoList}`,
        `\n*CEX ORDER*\n${JSON.stringify(
          cexActionParams
        )}\n*AARK ORDER*\n${JSON.stringify(
          aarkActionParams
        )}\n*Snpashot*\n${JSON.stringify(arbSnapshot)}`,
        0,
        true,
        false
      );
    }
  }
}
