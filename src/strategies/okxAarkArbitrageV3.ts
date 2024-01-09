import cron from "node-cron";
import { Orderbook } from "../interfaces/basic-interface";
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
import { ONE_HOUR_IN_MS } from "../utils/time";
import { isValidData } from "../utils/validation";
import { MarketIndicator } from "../interfaces/okxAarkArbitrage-interface";

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
    this.aarkService = new AarkService(
      process.env.ARBITRAGEUR_PK!,
      this.params.TARGET_CRYPTO_LIST.map((symbol: string) => `${symbol}_USDC`)
    );
    this.okxService = new OkxSwapService(
      process.env.OKX_KEY!,
      process.env.OKX_API_SECRET!,
      process.env.OKX_API_PASSWORD!,
      this.params.TARGET_CRYPTO_LIST.map(
        (symbol: string) => `${symbol}_USDT`
      ).concat(["USDC_USDT"])
    );
  }

  async init() {
    await this.okxService.init();
    await this.aarkService.init();

    await this._fetchData();
    await this._fetchPriceData();

    this.monitorService.slackMessage(
      "ARBITRAGEUR START",
      `${JSON.stringify(this.params.TARGET_CRYPTO_LIST)}`,
      0,
      true,
      false
    );
    this._logBalanceToSlack();
    cron.schedule("0 * * * *", () => {
      this._logBalanceToSlack();
    });
  }

  async run() {
    const strategyStart = Date.now();
    const arbSnapshot: any = {};
    const okxActionParams: IActionParam[] = [];
    const aarkActionParams: IActionParam[] = [];

    if (!this.okxService.isOrderbookAvailable(Date.now())) {
      return;
    }

    if (!(await this._fetchData())) {
      return;
    }
    if (!(await this._fetchPriceData())) {
      return;
    }

    this._checkBalance();

    const okxMarkets = this.okxService.getMarketInfo();
    const aarkMarkets = this.aarkService.getMarketInfo();

    const marketIndicators = this._getMarketIndicators();
    console.log(JSON.stringify(marketIndicators));

    const USDC_USDT_PRICE = this._getOKXMidPrice("USDC");

    let hedged = true;
    let arbitrageFound = false;
    const detectionStart = Date.now();

    for (const crypto of this.params.TARGET_CRYPTO_LIST) {
      const marketArbitrageInfo: any = {
        crypto,
      };

      //////////
      // DATA //
      //////////
      const okxMarket = okxMarkets[`${crypto}_USDT`];
      const aarkMarket = aarkMarkets[`${crypto}_USDC`];
      const marketIndicator = marketIndicators[crypto];

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

      /////////////////
      // HEDGE LOGIC //
      ////////////////

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

      ////////////////
      // MAIN LOGIC //
      ////////////////

      let orderSizeInAark = this._getOrderAmountInAark(
        marketIndicator,
        USDC_USDT_PRICE
      );

      Object.assign(marketArbitrageInfo, { marketIndicator });

      orderSizeInAark = applyQtyPrecision(orderSizeInAark, [
        okxMarket.marketInfo,
        aarkMarket.marketInfo,
      ]);
      if (
        !(
          (
          marketIndicator.targetAarkPosition === 0 &&
            Math.abs(okxMarket.position!.size) * okxMidUSDT <=
              this.params.MIN_ORDER_USDT &&
            okxMarket.position!.size === orderSizeInAark
          ) // If position to close have size lower than MIN_ORDER_USDT, close it in one trade
        ) &&
        Math.abs(orderSizeInAark) * okxMidUSDT < this.params.MIN_ORDER_USDT
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
          this.params.MIN_ORDER_INTERVAL_MS
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

    ///////////////
    // EXECUTION //
    ///////////////

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
      EMA_WINDOW,
      ENTER_SKEWNESS_RATIO,
      UNHEDGED_THRESHOLD_USDT,
      BASE_PRICE_DIFF_THRESHOLD,
      OKX_FUNDING_RATE_DODGE_THRESHOLD,
      OPEN_AARK_FUNDING_TERM_THRESHOLD,
      CLOSE_AARK_FUNDING_TERM_THRESHOLD,

      MAX_LEVERAGE,
      MAX_ORDER_USDT,
      MAX_ORDERBOOK_SLIPPAGE,
      MAX_TOTAL_POSITION_USDT,

      MIN_ORDER_USDT,
      MIN_ORDER_INTERVAL_MS,

      INITIAL_BALANCE_USDT,
      BALANCE_RATIO_IN_OKX,
      BALANCE_RATIO_IN_AARK,
      BALANCE_RATIO_DIFF_THRESHOLD,

      DATA_FETCH_TIME_THRESHOLD_MS,
    ] = [
      process.env.EMA_WINDOW!,
      process.env.ENTER_SKEWNESS_RATIO!,
      process.env.UNHEDGED_THRESHOLD_USDT!,
      process.env.BASE_PRICE_DIFF_THRESHOLD!,
      process.env.OKX_FUNDING_RATE_DODGE_THRESHOLD!,
      process.env.OPEN_AARK_FUNDING_TERM_THRESHOLD!,
      process.env.CLOSE_AARK_FUNDING_TERM_THRESHOLD!,

      process.env.MAX_LEVERAGE!,
      process.env.MAX_ORDER_USDT!,
      process.env.MAX_ORDERBOOK_SLIPPAGE!,
      process.env.MAX_TOTAL_POSITION_USDT!,

      process.env.MIN_ORDER_USDT!,
      process.env.MIN_ORDER_INTERVAL_MS!,

      process.env.INITIAL_BALANCE_USDT!,
      process.env.BALANCE_RATIO_IN_OKX!,
      process.env.BALANCE_RATIO_IN_AARK!,
      process.env.BALANCE_RATIO_DIFF_THRESHOLD!,

      process.env.DATA_FETCH_TIME_THRESHOLD_MS!,
    ].map((param: string) => parseFloat(param));

    const TARGET_CRYPTO_LIST = JSON.parse(process.env.TARGET_CRYPTO_LIST!);

    this.params = {
      TARGET_CRYPTO_LIST,

      EMA_WINDOW,
      ENTER_SKEWNESS_RATIO,
      UNHEDGED_THRESHOLD_USDT,
      BASE_PRICE_DIFF_THRESHOLD,
      OKX_FUNDING_RATE_DODGE_THRESHOLD,
      OPEN_AARK_FUNDING_TERM_THRESHOLD,
      CLOSE_AARK_FUNDING_TERM_THRESHOLD,

      MAX_LEVERAGE,
      MAX_ORDER_USDT,
      MAX_ORDERBOOK_SLIPPAGE,
      MAX_TOTAL_POSITION_USDT,

      MIN_ORDER_USDT,
      MIN_ORDER_INTERVAL_MS,

      INITIAL_BALANCE_USDT,
      BALANCE_RATIO_IN_OKX,
      BALANCE_RATIO_IN_AARK,
      BALANCE_RATIO_DIFF_THRESHOLD,

      DATA_FETCH_TIME_THRESHOLD_MS,
    };
  }

  _getOkxUSDTBalance() {
    const okxBalance = this.okxService.getBalance();
    if (okxBalance === undefined) {
      this.monitorService.slackMessage(
        "BALANCE ERROR",
        `Failed to fetch OKX balance`,
        60,
        false,
        false
      );
      throw new Error(`[Data Fetch Fail] Failed to fetch OKX balance Info`);
    }
    const okxUSDT = okxBalance
      .filter((balance) => balance.currency === "USDT")
      .reduce((acc, balance) => acc + balance.total, 0);
    return okxUSDT;
  }

  _getAarkUSDCBalance() {
    const aarkBalance = this.aarkService.getBalance();
    if (aarkBalance === undefined) {
      this.monitorService.slackMessage(
        "BALANCE ERROR",
        `Failed to fetch AARK balance`,
        60,
        false,
        false
      );
      throw new Error(`[Data Fetch Fail] Failed to fetch AARK balance Info`);
    }
    const aarkMarkets = this.aarkService.getMarketInfo();
    const aarkLastTradePrices = this.aarkService.getLastTradePrices();
    const positionValueDelta = Object.keys(aarkMarkets).reduce(
      (acc, symbol) => {
        const position = aarkMarkets[symbol].position!;
        const marketStatus = aarkMarkets[symbol].marketStatus!;
        const indexPrice = aarkMarkets[symbol].indexPrice!;
        const markPrice =
          indexPrice *
          (1 + marketStatus.skewness / marketStatus.depthFactor / 100);
        return acc + position.size * (markPrice - aarkLastTradePrices[symbol]);
      },
      0
    );
    const aarkUSDC = aarkBalance
      .filter((balance) => balance.currency === "USDC")
      .reduce((acc, balance) => acc + balance.total, 0);
    return aarkUSDC + positionValueDelta;
  }

  _getOKXMidPrice(crypto: string) {
    const orderbook =
      this.okxService.getMarketInfo()[`${crypto}_USDT`].orderbook!;
    return (orderbook.asks[0][0] + orderbook.bids[0][0]) / 2;
  }

  _logBalanceToSlack() {
    const okx = this._getOkxUSDTBalance();
    const aark = this._getAarkUSDCBalance();
    const USDC_USDT_PRICE = this._getOKXMidPrice("USDC");
    this.monitorService.slackMessage(
      "BALANCE INFO",
      JSON.stringify({
        "AARK USDC Balance": aark.toFixed(2),
        "OKX USDT Balance": okx.toFixed(2),
        "USDC/USDT": USDC_USDT_PRICE.toFixed(6),
        "TOTAL USDT": (okx + aark * USDC_USDT_PRICE).toFixed(2),
      }),
      60_000,
      false,
      false
    );
  }

  async _fetchData(): Promise<boolean> {
    const timestamp = Date.now();
    const dataFetchLatencyInfo: { [key: string]: number } = {};
    await Promise.all([
      this.aarkService.fetchUserStatus().then(() => {
        dataFetchLatencyInfo["aarkService.fetchUserStatus"] =
          Date.now() - timestamp;
      }),
      this.aarkService.fetchLastTradePrices().then(() => {
        dataFetchLatencyInfo["aarkService.fetchLastTradePrices"] =
          Date.now() - timestamp;
      }),
      this.aarkService.fetchMarketStatuses().then(() => {
        dataFetchLatencyInfo["aarkService.fetchMarketStatuses"] =
          Date.now() - timestamp;
      }),
      this.aarkService.fetchLpPoolValue().then(() => {
        dataFetchLatencyInfo["aarkService.fetchLpPoolValue"] =
          Date.now() - timestamp;
      }),
      this.okxService.fetchPositions().then(() => {
        dataFetchLatencyInfo["okxService.fetchPositions"] =
          Date.now() - timestamp;
      }),
      this.okxService.fetchBalances().then(() => {
        dataFetchLatencyInfo["okxService.fetchBalances"] =
          Date.now() - timestamp;
      }),
      this.okxService.fetchFundingRate().then(() => {
        dataFetchLatencyInfo["okxService.fetchFundingRate"] =
          Date.now() - timestamp;
      }),
    ]);
    const dataFetchingTime = Date.now() - timestamp;
    console.log(JSON.stringify(dataFetchLatencyInfo));
    Object.assign(this.localState.arbSnapshot, { dataFetchingTime });
    console.log(`Data fetched : ${dataFetchingTime}ms`);
    if (dataFetchingTime > 2000) {
      return false;
    } else {
      return true;
    }
  }

  async _fetchPriceData() {
    const timestamp = Date.now();
    const dataFetchLatencyInfo: { [key: string]: number } = {};
    await Promise.all([
      this.aarkService.fetchIndexPrices().then(() => {
        dataFetchLatencyInfo["aarkService.fetchIndexPrices"] =
          Date.now() - timestamp;
      }),
      this.okxService.fetchOrderbooks().then(() => {
        dataFetchLatencyInfo["okxService.fetchOrderbooks"] =
          Date.now() - timestamp;
      }),
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
    const okxBalanceUSDT = this._getOkxUSDTBalance();
    const aarkBalanceUSDC = this._getAarkUSDCBalance();
    const USDC_USDT_PRICE = this._getOKXMidPrice("USDC");
    console.log(
      JSON.stringify({
        okxUSDT: round_dp(okxBalanceUSDT, 2),
        aarkUSDC: round_dp(aarkBalanceUSDC, 2),
        totalUSDT: round_dp(
          okxBalanceUSDT + aarkBalanceUSDC * USDC_USDT_PRICE,
          2
        ),
      })
    );
    if (
      okxBalanceUSDT + aarkBalanceUSDC <
      this.params.INITIAL_BALANCE_USDT * 0.95
    ) {
      this.monitorService.slackMessage(
        "TOTAL BALANCE TOO LOW",
        `okx balance USDT : ${formatNumber(
          okxBalanceUSDT,
          2
        )}USDT\naark balance USDC: ${formatNumber(aarkBalanceUSDC, 2)}USDC`,
        60_000,
        true,
        true
      );
    } else if (
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
    } else if (
      Math.abs(
        aarkBalanceUSDC -
          this.params.INITIAL_BALANCE_USDT * this.params.BALANCE_RATIO_IN_AARK
      ) >
      this.params.INITIAL_BALANCE_USDT *
        this.params.BALANCE_RATIO_DIFF_THRESHOLD
    ) {
      this.monitorService.slackMessage(
        "AARK BALANCE OUT OF RANGE",
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

  _getMarketIndicators(): {
    [crypto: string]: MarketIndicator;
  } {
    const okxMarkets = this.okxService.getMarketInfo();
    const aarkMarkets = this.aarkService.getMarketInfo();
    const alpPoolValue = this.aarkService.getLpPoolValue();

    if (alpPoolValue === undefined) {
      this.monitorService.slackMessage(
        `ALP POOL VALUE ERROR`,
        `UNDEFINED alpPoolValue`,
        60_000,
        true,
        true
      );
      throw new Error("Failed to fetch ALP Pool Value");
    }

    const marketIndicators: MarketIndicator[] = [];
    const USDC_USDT_PRICE = this._getOKXMidPrice("USDC");
    for (const crypto of this.params.TARGET_CRYPTO_LIST) {
      const okxMarket = okxMarkets[`${crypto}_USDT`];
      const aarkMarket = aarkMarkets[`${crypto}_USDC`];

      const aarkStatus = aarkMarket.marketStatus!;

      const targetAarkPositionTheo =
        -(aarkStatus.skewness - aarkMarket.position!.size) *
        this.params.ENTER_SKEWNESS_RATIO;
      let targetAarkPosition = targetAarkPositionTheo;
      const skewnessAfter =
        aarkStatus.skewness - aarkMarket.position!.size + targetAarkPosition;
      const aarkFundingTerm =
        (((-(aarkStatus.coefficient * skewnessAfter) / aarkStatus.depthFactor) *
          Math.max(
            1,
            (skewnessAfter * aarkMarket.indexPrice!) /
              (alpPoolValue * aarkStatus.targetLeverage)
          )) /
          100) *
        (targetAarkPosition > 0 ? 1 : -1);

      const okxFundingTerm =
        okxMarket.fundingRate!.fundingRate * (targetAarkPosition > 0 ? 1 : -1);
      marketIndicators.push({
        crypto,
        targetAarkPositionTheo,
        targetAarkPosition,
        aarkFundingTerm,
        okxFundingTerm,
        skewnessValue: skewnessAfter * aarkMarket.indexPrice! * USDC_USDT_PRICE,
      });
    }
    marketIndicators.sort((a, b) => b.aarkFundingTerm - a.aarkFundingTerm);

    const okxUSDTBalance = this._getOkxUSDTBalance();
    const aarkUSDCBalance = this._getAarkUSDCBalance();
    const maxPositionUSDT = Math.min(
      this.params.MAX_TOTAL_POSITION_USDT,
      Math.min(okxUSDTBalance, aarkUSDCBalance * USDC_USDT_PRICE) *
        this.params.MAX_LEVERAGE
    );
    let totalAbsPositionUSDT = this.params.TARGET_CRYPTO_LIST.reduce(
      (acc: number, crypto: string) => {
        const midPriceUSDT = this._getOKXMidPrice(crypto);
        return (
          acc +
          Math.abs(okxMarkets[`${crypto}_USDT`].position!.size) * midPriceUSDT
        );
      },
      0
    );
    const targetAarkPositions: { [crypto: string]: MarketIndicator } = {};
    for (const marketIndicator of marketIndicators) {
      const crypto = marketIndicator.crypto;
      const okxMarket = okxMarkets[`${crypto}_USDT`];
      const price = this._getOKXMidPrice(crypto);
      const positionUSDTValue = Math.abs(okxMarket.position!.size) * price;
      let targetAarkPosition = marketIndicator.targetAarkPosition;

      const dodgeOKXFunding = (threshold: number) =>
        marketIndicator.okxFundingTerm < threshold &&
        okxMarket.fundingRate!.fundingTime - Date.now() < ONE_HOUR_IN_MS;

      if (dodgeOKXFunding(-this.params.OKX_FUNDING_RATE_DODGE_THRESHOLD)) {
        // Close position when impend to pay huge okx funding fee
        targetAarkPosition = 0;
      } else if (
        // Do not enter position if expected aark profit is too low
        positionUSDTValue === 0 &&
        marketIndicator.aarkFundingTerm <
          this.params.OPEN_AARK_FUNDING_TERM_THRESHOLD
      ) {
        targetAarkPosition = 0;
      } else if (
        positionUSDTValue !== 0 &&
        (marketIndicator.aarkFundingTerm <
          this.params.CLOSE_AARK_FUNDING_TERM_THRESHOLD ||
          dodgeOKXFunding(0))
      ) {
        // Do not close posiion until aark funding term is too low or impend to pay okx funding fee
        targetAarkPosition = 0;
      }

      targetAarkPosition =
        ((targetAarkPosition > 0 ? 1 : -1) *
          Math.min(
            Math.max(
              maxPositionUSDT - totalAbsPositionUSDT + positionUSDTValue,
              0
            ),
            Math.abs(targetAarkPosition) * price
          )) /
        price;
      targetAarkPosition =
        Math.abs(targetAarkPosition) < 1e-5 ? 0 : targetAarkPosition;

      marketIndicator.targetAarkPosition = targetAarkPosition;
      targetAarkPositions[marketIndicator.crypto] = marketIndicator;

      totalAbsPositionUSDT += Math.max(
        0,
        (Math.abs(marketIndicator.targetAarkPositionTheo) >
        this.params.MIN_ORDER_USDT
          ? Math.abs(marketIndicator.targetAarkPositionTheo)
          : 0) *
          price -
          positionUSDTValue
      );
    }

    return targetAarkPositions;
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
    const premium = (aarkMarket.indexPrice! * usdcPrice) / okxMidUSDT - 1;
    if (premiumEMA === undefined) {
      this.localState.premiumEMA[crypto] = {
        value: premium,
        weight: 1,
      };
    } else {
      const emaWeight = Math.min(this.params.EMA_WINDOW - 1, premiumEMA.weight);

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
    const okxPosition = okxMarket.position!;
    const aarkPosition = aarkMarket.position!;
    const midPrice =
      (okxMarket.orderbook!.asks[0][0] + okxMarket.orderbook!.bids[0][0]) / 2;
    const hedgeActionParams: IActionParam[] = [];
    const unhedgedSize = okxPosition.size + aarkPosition.size;
    if (
      Math.abs(unhedgedSize) * midPrice >
      this.params.UNHEDGED_THRESHOLD_USDT
    ) {
      const absSizeToHedge = Math.min(
        Math.abs(unhedgedSize),
        this.params.MAX_ORDER_USDT / midPrice
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
      return true;
    } else {
      return false;
    }
  }

  _getArbBuyAmountInAark(
    okxOrderbook: Orderbook,
    okxMarketInfo: IMarketInfo,
    aarkMarketStatus: IAarkMarketStatus,
    aarkIndexPrice: number,
    threshold: number,
    usdcPrice: number
  ): number {
    const depthFactor = aarkMarketStatus.depthFactor;
    const skewness = aarkMarketStatus.skewness;

    const bestPrice = okxOrderbook.bids[0][0];

    // Aark Buy
    let orderSizeInAark = 0;
    for (const [p, q] of okxOrderbook.bids) {
      if (p < bestPrice * (1 - this.params.MAX_ORDERBOOK_SLIPPAGE)) {
        break;
      }
      const deltaAmount = Math.min(
        q * okxMarketInfo.contractSize,
        2 *
          (100 *
            depthFactor *
            (((p / usdcPrice) * (1 + threshold)) / aarkIndexPrice - 1) -
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
    const depthFactor = aarkMarketStatus.depthFactor;
    const skewness = aarkMarketStatus.skewness;

    const bestPrice = okxOrderbook.asks[0][0];

    let orderSizeInAark = 0;
    for (const [p, q] of okxOrderbook.asks) {
      if (p > bestPrice * (1 + this.params.MAX_ORDERBOOK_SLIPPAGE)) {
        break;
      }
      const deltaAmount = Math.min(
        q * okxMarketInfo.contractSize,
        -2 *
          (100 *
            depthFactor *
            (((p / usdcPrice) * (1 + threshold)) / aarkIndexPrice - 1) -
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

    return -orderSizeInAark;
  }

  _getOrderAmountInAark(
    marketIndicator: MarketIndicator,
    usdcPrice: number
  ): number {
    const crypto = marketIndicator.crypto;
    const okxMarket = this.okxService.getMarketInfo()[`${crypto}_USDT`];
    const aarkMarket = this.aarkService.getMarketInfo()[`${crypto}_USDC`];

    const premiumEMA = this.localState.premiumEMA[crypto].value;
    const midPriceUSDC =
      (okxMarket.orderbook!.asks[0][0] + okxMarket.orderbook!.bids[0][0]) /
      2 /
      usdcPrice;

    const targetPositionDelta =
      marketIndicator.targetAarkPosition - aarkMarket.position!.size;
    let orderSizeInAark = 0;
    if (targetPositionDelta > 0) {
      orderSizeInAark = this._getArbBuyAmountInAark(
        okxMarket.orderbook!,
        okxMarket.marketInfo,
        aarkMarket.marketStatus!,
        aarkMarket.indexPrice!,
        premiumEMA - this.params.BASE_PRICE_DIFF_THRESHOLD,
        usdcPrice
      );
      return Math.min(
        targetPositionDelta,
        orderSizeInAark,
        this.params.MAX_ORDER_USDT / midPriceUSDC
      );
    } else if (targetPositionDelta < 0) {
      orderSizeInAark = this._getArbSellAmountInAark(
        okxMarket.orderbook!,
        okxMarket.marketInfo,
        aarkMarket.marketStatus!,
        aarkMarket.indexPrice!,
        premiumEMA + this.params.BASE_PRICE_DIFF_THRESHOLD,
        usdcPrice
      );
      return Math.max(
        targetPositionDelta,
        orderSizeInAark,
        -this.params.MAX_ORDER_USDT / midPriceUSDC
      );
    } else {
      return 0;
    }
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
