import { ethers } from "ethers";
import cron from "node-cron";
import { Balance, Orderbook, Position } from "../interfaces/basic-interface";
import { IAarkMarket, IMarket } from "../interfaces/market-interface";
import { IActionParam } from "../interfaces/order-interface";
import { AarkService } from "../services/aark.service";
import { MonitorService } from "../services/monitor.service";
import { OkxSwapService } from "../services/okx.service";
import { EPSILON, formatNumber, round_dp } from "../utils/number";
import { addCreateMarketParams, applyQtyPrecision } from "../utils/order";
import { isValidData } from "../utils/validation";
import { ONE_MIN_IN_MS, sleep } from "../utils/time";
import { uniswapArbitrum } from "../utils/uniswap";
import { approveERC20, getERC20Balance, transferERC20 } from "../utils/erc20";
import { contractAddressMap } from "../constants/contract-address";

interface MarketIndicator {
  crypto: string;
  targetAarkPositionTheo: number;
  targetAarkPosition: number;
  okxFundingTerm: number;
  positionValue: number;
}

enum RebalanceState {
  NONE = "None",
  OKX_TO_AARK = "OKX to AARk",
  AARK_TO_OKX = "AARK to OKX",
  HALT = "HALT",
}

interface SkewnessInfo {
  crypto: string;
  skewnessValue: number;
  timestamp: undefined | number;
}

export class Strategy {
  private readonly aarkService: AarkService;
  private readonly okxService: OkxSwapService;
  private readonly monitorService = MonitorService.getInstance();

  private params: any = {};
  private readonly localState = {
    rebalanceState: { state: RebalanceState.NONE, timestamp: 0 },
    unhedgedCnt: 0,
    lastOrderTimestamp: {} as { [key: string]: number },
    premiumEMA: {} as { [key: string]: { value: number; weight: number } },
    tradeInfo: {},
    skewnessInfo: {} as {
      [key: string]: SkewnessInfo;
    },
    blackListInfo: {} as {
      [address: string]: {
        timestamp: number;
        priority: number;
        balance: undefined | Balance[];
        position: undefined | Position[];
      };
    },
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
    const timestamp = Date.now();
    await this.okxService.init();
    await this.aarkService.init();

    await this._fetchData();
    await this._fetchPriceData();

    await this._updateBlackListInfo();

    const aarkMarkets = this.aarkService.getMarketInfo();

    for (const crypto of this.params.TARGET_CRYPTO_LIST as string[]) {
      const aarkMarket = aarkMarkets[`${crypto}_USDC`]!;
      const aarkSkewnessValue =
        aarkMarket.marketStatus!.skewness * aarkMarket.indexPrice!;
      const marketParam = this.params.MARKET_PARAMS[crypto];
      this.localState.skewnessInfo[crypto] = {
        crypto,
        skewnessValue: aarkSkewnessValue,
        timestamp:
          Math.abs(aarkSkewnessValue) > marketParam.skewnessUSDTThreshold
            ? timestamp
            : undefined,
      };
    }

    if (this.params.OKX_DEPOSIT_ADDRESS === undefined) {
      throw Error("Undefined OKX_DEPOSIT_ADDRES");
    }

    this.monitorService.slackMessage(
      "ARBITRAGEUR START",
      `${JSON.stringify(this.params.TARGET_CRYPTO_LIST)}`,
      0,
      true,
      false
    );
    this._logBalanceToSlack();
    cron.schedule("*/10 * * * *", () => {
      this._logBalanceToSlack();
    });
  }

  async run() {
    const strategyStart = Date.now();
    const tradeInfo: any = {};
    const okxActionParams: IActionParam[] = [];
    const aarkActionParams: IActionParam[] = [];

    if (this.localState.rebalanceState.state === RebalanceState.HALT) {
      this.monitorService.slackMessage(
        `REBALANCE HALTED`,
        "",
        60_000,
        true,
        true
      );
      return;
    }

    if (!this.okxService.isOrderbookAvailable(Date.now())) {
      return;
    }

    if (!(await this._fetchData())) {
      return;
    }
    if (!(await this._fetchPriceData())) {
      return;
    }

    await this._updateBlackListInfo();

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
      const marketParam = this.params.MARKET_PARAMS[crypto];
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

      // this._updatePremiumEMA(crypto, okxMarket, aarkMarket, USDC_USDT_PRICE);
      // Object.assign(marketArbitrageInfo, {
      //   premiumEMA: this.localState.premiumEMA[crypto].value,
      // });

      /////////////////
      // HEDGE LOGIC //
      ////////////////

      const hedgeActionParams = this._getHedgeActionParam(
        crypto,
        okxMarket,
        aarkMarket
      );
      if (hedgeActionParams.length !== 0) {
        if (!this._hadOrderRecently(crypto, detectionStart, 20_000)) {
          hedged = false;
          aarkActionParams.push(...hedgeActionParams);
          this._updateLastOrderTimestamp(crypto, detectionStart);
          break;
        } else {
          continue;
        }
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
              marketParam.minOrderUSDT &&
            okxMarket.position!.size === orderSizeInAark
          ) // If position to close have size lower than minOrderUSDT, close it in one trade
        ) &&
        Math.abs(orderSizeInAark) * okxMidUSDT < marketParam.minOrderUSDT
      ) {
        orderSizeInAark = 0;
      }
      Object.assign(marketArbitrageInfo, {
        usdcPrice: USDC_USDT_PRICE,
        okxAsk: okxOrderbook.asks[0][0],
        okxBid: okxOrderbook.bids[0][0],
        okxPosition: okxMarket.position!.size,
        aarkPosition: aarkMarket.position!.size,
        aarkSkewnessValue:
          aarkMarket.marketStatus!.skewness * aarkMarket.indexPrice!,
        aarkIndexPrice: aarkMarket.indexPrice,
        orderSizeInAark,
        timestamp: detectionStart,
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
        Object.assign(tradeInfo, marketArbitrageInfo);
      }
    }
    this._logOverSkewedMarkets();
    this._logActionParams(okxActionParams);
    this._logActionParams(aarkActionParams);
    this._logBalance();

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
        false
      );
    }

    console.log(`Strategy end. Elapsed ${Date.now() - strategyStart}ms`);
    if (!hedged) {
      this.localState.unhedgedCnt += 1;
      if (this.localState.unhedgedCnt > 5) {
        this.monitorService.slackMessage(
          `ARBITRAGEUR UNHEDGED`,
          `Unhedged for ${this.localState.unhedgedCnt} iteration`,
          60_000,
          true,
          true
        );
      }
    } else {
      this._logOrderInfoToSlack(okxActionParams, aarkActionParams, tradeInfo);
      this.localState.unhedgedCnt = 0;
    }

    return;
  }

  _readEnvParams() {
    const [
      UNHEDGED_THRESHOLD_USDT,
      OKX_FUNDING_RATE_DODGE_THRESHOLD,

      MAX_LEVERAGE,
      MAX_ORDER_USDT,
      MAX_REBALANCE_USDT,
      MAX_TOTAL_POSITION_USDT,

      MIN_ORDER_INTERVAL_MS,

      INITIAL_BALANCE_USDT,
      LOSS_THRESHOLD,
      BALANCE_RATIO_IN_OKX,
      BALANCE_RATIO_IN_AARK,
      BALANCE_RATIO_DIFF_THRESHOLD,

      DATA_FETCH_TIME_THRESHOLD_MS,
    ] = [
      process.env.UNHEDGED_THRESHOLD_USDT!,
      process.env.OKX_FUNDING_RATE_DODGE_THRESHOLD!,

      process.env.MAX_LEVERAGE!,
      process.env.MAX_ORDER_USDT!,
      process.env.MAX_REBALANCE_USDT!,
      process.env.MAX_TOTAL_POSITION_USDT!,

      process.env.MIN_ORDER_INTERVAL_MS!,

      process.env.INITIAL_BALANCE_USDT!,
      process.env.LOSS_THRESHOLD!,
      process.env.BALANCE_RATIO_IN_OKX!,
      process.env.BALANCE_RATIO_IN_AARK!,
      process.env.BALANCE_RATIO_DIFF_THRESHOLD!,

      process.env.DATA_FETCH_TIME_THRESHOLD_MS!,
    ].map((param: string) => parseFloat(param));

    const BLACK_LIST = JSON.parse(process.env.BLACK_LIST!);
    const TARGET_CRYPTO_LIST = JSON.parse(process.env.TARGET_CRYPTO_LIST!);
    const MARKET_PARAMS = JSON.parse(process.env.MARKET_PARAMS!);
    const OKX_DEPOSIT_ADDRESS = process.env.OKX_DEPOSIT_ADDRESS!;

    this.params = {
      BLACK_LIST,
      TARGET_CRYPTO_LIST,
      MARKET_PARAMS,

      UNHEDGED_THRESHOLD_USDT,
      OKX_DEPOSIT_ADDRESS,
      OKX_FUNDING_RATE_DODGE_THRESHOLD,

      MAX_LEVERAGE,
      MAX_ORDER_USDT,
      MAX_REBALANCE_USDT,
      MAX_TOTAL_POSITION_USDT,

      MIN_ORDER_INTERVAL_MS,

      INITIAL_BALANCE_USDT,
      LOSS_THRESHOLD,
      BALANCE_RATIO_IN_OKX,
      BALANCE_RATIO_IN_AARK,
      BALANCE_RATIO_DIFF_THRESHOLD,

      DATA_FETCH_TIME_THRESHOLD_MS,
    };
  }

  async _updateBlackListInfo() {
    const timestamp = Date.now();
    const blackListInfo: [undefined | Balance[], undefined | Position[]][] =
      await Promise.all(
        this.params.BLACK_LIST.map((address: string) =>
          this.aarkService._fetchAddressStatus(address)
        )
      );

    (this.params.BLACK_LIST as string[]).forEach(
      (address: string, i: number) => {
        const [balance, position] = blackListInfo[i];
        if (
          this.localState.blackListInfo[address] === undefined ||
          balance === undefined ||
          position === undefined
        ) {
          this.localState.blackListInfo[address] = {
            timestamp: 0,
            priority: i,
            balance,
            position,
          };
        } else {
          const addressInfo = this.localState.blackListInfo[address];
          addressInfo.timestamp = timestamp;
          addressInfo.balance = balance;

          if (addressInfo.position === undefined) {
            addressInfo.position = position;
          } else {
            position.forEach((newPos, idx) => {
              if (addressInfo.position![idx].size != newPos.size) {
                this.monitorService.slackMessage(
                  `BLACK LIST ${address} TRADED IN ${newPos.symbol}`,
                  `Position changed from ${round_dp(
                    addressInfo.position![idx].size,
                    4
                  )} to ${round_dp(newPos.size, 4)}`,
                  10_000,
                  true,
                  false
                );
                addressInfo.position![idx] = newPos;
              }
            });
          }
        }
      }
    );
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
        "Rebalance State": this.localState.rebalanceState.state,
      }),
      60_000,
      false,
      false
    );
  }

  _logBalance() {
    const okx = this._getOkxUSDTBalance();
    const aark = this._getAarkUSDCBalance();
    const USDC_USDT_PRICE = this._getOKXMidPrice("USDC");
    console.log(
      JSON.stringify({
        "AARK USDC Balance": aark.toFixed(2),
        "OKX USDT Balance": okx.toFixed(2),
        "USDC/USDT": USDC_USDT_PRICE.toFixed(6),
        "TOTAL USDT": (okx + aark * USDC_USDT_PRICE).toFixed(2),
      })
    );
  }

  async _fetchData(): Promise<boolean> {
    const timestamp = Date.now();
    const dataFetchLatencyInfo: { [key: string]: number } = {};
    await Promise.all([
      this.aarkService.fetchSignerStatus().then(() => {
        dataFetchLatencyInfo["aarkService.fetchSignerStatus"] =
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
    Object.assign(this.localState.tradeInfo, dataFetchingTime);
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
    Object.assign(this.localState.tradeInfo, dataFetchingTime);
    console.log(`Data fetched : ${dataFetchingTime}ms`);
    if (dataFetchingTime > this.params.DATA_FETCH_TIME_THRESHOLD_MS) {
      return false;
    } else {
      return true;
    }
  }

  _checkBalance() {
    const timestamp = Date.now();
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
        rebalanceState: this.localState.rebalanceState.state,
      })
    );
    if (
      this.localState.rebalanceState.state === RebalanceState.NONE &&
      this.localState.rebalanceState.timestamp + 10_000 < timestamp &&
      okxBalanceUSDT + aarkBalanceUSDC <
        this.params.INITIAL_BALANCE_USDT - this.params.LOSS_THRESHOLD
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
      this.localState.rebalanceState.state === RebalanceState.NONE &&
      this.localState.rebalanceState.timestamp + 10_000 < timestamp &&
      okxBalanceUSDT <
        this.params.INITIAL_BALANCE_USDT *
          (this.params.BALANCE_RATIO_IN_OKX -
            this.params.BALANCE_RATIO_DIFF_THRESHOLD)
    ) {
      this.monitorService.slackMessage(
        "TOO LOW OKX BALANCE",
        `okx balance USDT : ${formatNumber(
          okxBalanceUSDT,
          2
        )}USDT\naark balance USDC: ${formatNumber(aarkBalanceUSDC, 2)}USDC`,
        60_000,
        true,
        false
      );
      this.localState.rebalanceState.state = RebalanceState.AARK_TO_OKX;
      this._rebalanceFromAarkToOkx();
    } else if (
      this.localState.rebalanceState.state === RebalanceState.NONE &&
      this.localState.rebalanceState.timestamp + 10_000 < timestamp &&
      aarkBalanceUSDC <
        this.params.INITIAL_BALANCE_USDT *
          (this.params.BALANCE_RATIO_IN_AARK -
            this.params.BALANCE_RATIO_DIFF_THRESHOLD)
    ) {
      this.monitorService.slackMessage(
        "TOO LOW AARK BALANCE",
        `okx balance USDT : ${formatNumber(
          okxBalanceUSDT,
          2
        )}USDT\naark balance USDC: ${formatNumber(aarkBalanceUSDC, 2)}USDC`,
        60_000,
        true,
        false
      );
      this.localState.rebalanceState.state = RebalanceState.OKX_TO_AARK;
      this._rebalanceFromOkxToAark();
    }
  }

  _getMarketIndicators(): {
    [crypto: string]: MarketIndicator;
  } {
    const timestamp = Date.now();
    const okxMarkets = this.okxService.getMarketInfo();
    const aarkMarkets = this.aarkService.getMarketInfo();

    const marketIndicators: MarketIndicator[] = [];
    const USDC_USDT_PRICE = this._getOKXMidPrice("USDC");

    const marketParams = this.params.MARKET_PARAMS;

    const blackListPositionSizeMap: { [crypto: string]: number } = {};

    for (const crypto of this.params.TARGET_CRYPTO_LIST as string[]) {
      let targetAarkPositionTheo = 0;

      let lastBlackListTradeTimestamp = 0;
      let blackListPosSum = 0;
      Object.keys(this.localState.blackListInfo)
        .filter(
          (address: string) =>
            this.localState.blackListInfo[address] !== undefined &&
            this.localState.blackListInfo[address].position !== undefined
        )
        .forEach((address: string) => {
          const positions = this.localState.blackListInfo[address].position!;

          const pos = positions.find(
            (val: Position) => val.symbol === `${crypto}_USDC`
          )!;
          lastBlackListTradeTimestamp = Math.max(
            lastBlackListTradeTimestamp,
            pos.timestamp
          );
          blackListPosSum += pos.size;
        });
      blackListPositionSizeMap[crypto] = blackListPosSum;

      const okxMarket = okxMarkets[`${crypto}_USDT`];
      const aarkMarket = aarkMarkets[`${crypto}_USDC`];

      const aarkStatus = aarkMarket.marketStatus!;
      const marketParam = marketParams[crypto];

      const aarkSkewnessValue = aarkStatus.skewness * aarkMarket.indexPrice!;

      this.localState.skewnessInfo[crypto].skewnessValue = aarkSkewnessValue;
      if (Math.abs(aarkSkewnessValue) < marketParam.skewnessUSDTThreshold) {
        this.localState.skewnessInfo[crypto].timestamp = undefined;
      } else {
        if (this.localState.skewnessInfo[crypto].timestamp === undefined) {
          this.localState.skewnessInfo[crypto].timestamp = timestamp;
        }
      }

      if (blackListPosSum !== 0) {
        // if (blackListPosSum > 0) {
        //   if (aarkStatus.skewness > 0) {
        //     targetAarkPositionTheo =
        //       aarkMarket.position!.size - aarkStatus.skewness;
        //   } else {
        //     targetAarkPositionTheo = Math.min(
        //       aarkMarket.position!.size - aarkStatus.skewness,
        //       0
        //     );
        //   }
        // } else {
        //   if (aarkStatus.skewness < 0) {
        //     targetAarkPositionTheo =
        //       aarkMarket.position!.size - aarkStatus.skewness;
        //   } else {
        //     targetAarkPositionTheo = Math.max(
        //       aarkMarket.position!.size - aarkStatus.skewness,
        //       0
        //     );
        //   }
        // }

        // Short-form of above logic
        if (blackListPosSum * aarkStatus.skewness >= 0) {
          targetAarkPositionTheo =
            aarkMarket.position!.size - aarkStatus.skewness;
        } else {
          targetAarkPositionTheo = (blackListPosSum > 0 ? Math.min : Math.max)(
            aarkMarket.position!.size - aarkStatus.skewness,
            0
          );
        }
      } else {
        if (
          Math.abs(aarkSkewnessValue) >
            marketParam.skewnessUSDTThreshold *
              (lastBlackListTradeTimestamp + 60_000 > timestamp ? 0.5 : 1) &&
          (this.localState.skewnessInfo[crypto].timestamp ?? Infinity) +
            marketParam.skewnessIntervalThreshold <
            timestamp
        ) {
          targetAarkPositionTheo =
            aarkMarket.position!.size - aarkStatus.skewness;
        } else {
          targetAarkPositionTheo = aarkMarket.position!.size;
        }
        targetAarkPositionTheo =
          (targetAarkPositionTheo > 0 ? 1 : -1) *
          Math.min(
            Math.abs(targetAarkPositionTheo),
            marketParam.maxPositionUSDT / aarkMarket.indexPrice!
          );
      }

      const okxFundingTerm =
        okxMarket.fundingRate!.fundingRate *
        (targetAarkPositionTheo > 0 ? 1 : -1);

      marketIndicators.push({
        crypto,
        targetAarkPositionTheo,
        targetAarkPosition: targetAarkPositionTheo,
        okxFundingTerm,
        positionValue: aarkMarket.position!.size * aarkMarket.indexPrice!,
      });
    }
    // marketIndicators.sort((a, b) => b.skewnessValue - a.skewnessValue);

    const okxUSDTBalance = this._getOkxUSDTBalance();
    const aarkUSDCBalance = this._getAarkUSDCBalance();
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
      const blackListHasPosition = blackListPositionSizeMap[crypto] !== 0;
      const maxPositionUSDT = Math.min(
        this.params.MAX_TOTAL_POSITION_USDT,
        Math.min(okxUSDTBalance, aarkUSDCBalance * USDC_USDT_PRICE) *
          (blackListHasPosition
            ? this.params.MAX_LEVERAGE + 5
            : this.params.MAX_LEVERAGE) // HARD MAX LEVERGAGE = 15
      );
      const price = this._getOKXMidPrice(crypto);
      const positionUSDTValue = Math.abs(okxMarket.position!.size) * price;
      let targetAarkPosition = marketIndicator.targetAarkPosition;

      const dodgeOKXFunding = (threshold: number) =>
        marketIndicator.okxFundingTerm < threshold &&
        okxMarket.fundingRate!.fundingTime - Date.now() < ONE_MIN_IN_MS * 10;

      if (
        !blackListHasPosition &&
        dodgeOKXFunding(-this.params.OKX_FUNDING_RATE_DODGE_THRESHOLD)
      ) {
        // Close position when impend to pay huge okx funding fee
        targetAarkPosition = 0;
      }

      targetAarkPosition =
        ((targetAarkPosition > 0 ? 1 : -1) *
          Math.min(
            Math.max(
              maxPositionUSDT - totalAbsPositionUSDT + positionUSDTValue,
              0,
              // To hedge skewness, position should be maintained
              // even if current leverage over MAX_LEVERAGE
              positionUSDTValue
            ),
            Math.abs(targetAarkPosition) * price
          )) /
        price;
      targetAarkPosition =
        Math.abs(targetAarkPosition) < EPSILON ? 0 : targetAarkPosition;

      marketIndicator.targetAarkPosition = targetAarkPosition;
      targetAarkPositions[marketIndicator.crypto] = marketIndicator;

      // totalAbsPositionUSDT += Math.max(
      //   0,
      //   (Math.abs(marketIndicator.targetAarkPositionTheo) * price >
      //   marketParam.minOrderUSDT
      //     ? Math.abs(marketIndicator.targetAarkPositionTheo)
      //     : 0) *
      //     price -
      //     positionUSDTValue
      // );
    }

    return targetAarkPositions;
  }

  // _updatePremiumEMA(
  //   crypto: string,
  //   okxMarket: IMarket,
  //   aarkMarket: IAarkMarket,
  //   usdcPrice: number
  // ) {
  //   const premiumEMA = this.localState.premiumEMA[crypto];
  //   const okxMidUSDT =
  //     (okxMarket.orderbook!.asks[0][0] + okxMarket.orderbook!.bids[0][0]) / 2;
  //   const premium = (aarkMarket.indexPrice! * usdcPrice) / okxMidUSDT - 1;
  //   if (premiumEMA === undefined) {
  //     this.localState.premiumEMA[crypto] = {
  //       value: premium,
  //       weight: 1,
  //     };
  //   } else {
  //     const emaWeight = Math.min(this.params.EMA_WINDOW - 1, premiumEMA.weight);

  //     this.localState.premiumEMA[crypto] = {
  //       value: (premiumEMA.value * emaWeight + premium) / (emaWeight + 1),
  //       weight: emaWeight + 1,
  //     };
  //   }
  // }

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
    maxOrderbookSlippage: number
  ): number {
    const bestPrice = okxOrderbook.bids[0][0];

    // Aark Buy
    let orderSizeInAark = 0;
    for (const [p, q] of okxOrderbook.bids) {
      if (p < bestPrice * (1 - maxOrderbookSlippage)) {
        break;
      }
      orderSizeInAark += q;
    }
    return orderSizeInAark;
  }

  _getArbSellAmountInAark(
    okxOrderbook: Orderbook,
    maxOrderbookSlippage: number
  ): number {
    const bestPrice = okxOrderbook.asks[0][0];

    let orderSizeInAark = 0;
    for (const [p, q] of okxOrderbook.asks) {
      if (p > bestPrice * (1 + maxOrderbookSlippage)) {
        break;
      }
      orderSizeInAark += q;
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
    const marketParam = this.params.MARKET_PARAMS[crypto];

    const midPriceUSDC =
      (okxMarket.orderbook!.asks[0][0] + okxMarket.orderbook!.bids[0][0]) /
      2 /
      usdcPrice;

    const targetPositionDelta =
      marketIndicator.targetAarkPosition - aarkMarket.position!.size;
    let orderSizeInAark = 0;
    if (targetPositionDelta > 0) {
      orderSizeInAark =
        this._getArbBuyAmountInAark(
          okxMarket.orderbook!,
          marketParam.maxOrderbookSlippage
        ) * okxMarket.marketInfo.contractSize;
      return Math.min(
        targetPositionDelta,
        orderSizeInAark,
        this.params.MAX_ORDER_USDT / midPriceUSDC
      );
    } else if (targetPositionDelta < 0) {
      orderSizeInAark =
        this._getArbSellAmountInAark(
          okxMarket.orderbook!,
          marketParam.maxOrderbookSlippage
        ) * okxMarket.marketInfo.contractSize;
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
    tradeInfo: any[]
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
        )}\n*Snpashot*\n${JSON.stringify(tradeInfo)}`,
        0,
        true,
        false
      );
    }
  }

  _logOverSkewedMarkets() {
    const overSkewedMarkets = [];
    for (const crypto of this.params.TARGET_CRYPTO_LIST as string[]) {
      const skewnessInfo = this.localState.skewnessInfo[crypto];
      if (skewnessInfo.timestamp !== undefined) {
        overSkewedMarkets.push({
          crypto,
          skewnessValue: skewnessInfo.skewnessValue,
          timestamp: new Date(skewnessInfo.timestamp).toISOString(),
        });
      }
    }
    console.log(JSON.stringify(overSkewedMarkets));
    if (overSkewedMarkets.length > 0) {
      this.monitorService.slackMessage(
        `Over Skewed Markets`,
        JSON.stringify(overSkewedMarkets),
        600_000,
        false,
        false
      );
    }
  }

  async _rebalanceFromOkxToAark(): Promise<boolean> {
    // 1. Withdraw USDT from OKX
    // 2. Convert USDT to USDC with Uniswap
    // 3. Deposit USDC to Aark futures account

    const timestamp = Date.now();

    this.monitorService.slackMessage(
      `REBALANCE START`,
      `Rebalance from OKX to AARK started : ${JSON.stringify({
        startTime: new Date().toISOString(),
      })}`,
      60_000,
      false,
      false
    );

    const aarkUSDC = this._getAarkUSDCBalance();
    const okxUSDT = this._getOkxUSDTBalance();
    const withdrawAmount = round_dp(
      Math.max(
        Math.min(
          okxUSDT -
            this.params.INITIAL_BALANCE_USDT * this.params.BALANCE_RATIO_IN_OKX,
          this.params.MAX_REBALANCE_USDT
        ),
        0
      ),
      4
    );
    const arbitrageur = this.aarkService.getSigner();

    if (withdrawAmount === undefined || Number.isNaN(withdrawAmount)) {
      this.monitorService.slackMessage(
        `REBALANCE ERROR`,
        `undefined withdrawAmount : ${withdrawAmount}`,
        60_000,
        true,
        true
      );
      this.localState.rebalanceState = {
        state: RebalanceState.HALT,
        timestamp,
      };
      return false;
    }

    if (withdrawAmount === 0) {
      this.localState.rebalanceState = {
        state: RebalanceState.NONE,
        timestamp,
      };
      return true;
    }

    const rebalanceInfo = {
      "AARK USDC Balance": aarkUSDC,
      "OKX USDT Balance": okxUSDT,
      "Amount to Rebalance": withdrawAmount,
    };

    console.log(arbitrageur.address, rebalanceInfo, withdrawAmount);

    this.localState.rebalanceState = {
      state: RebalanceState.HALT,
      timestamp,
    };
    return false;

    // Step 1 : Withdraw USDT from OKX
    try {
      const transferRes = await this.okxService.transferAsset(
        "USDT",
        withdrawAmount,
        true
      );
      const transId = transferRes.transId;
      let transferSuccess = false;
      do {
        await sleep(5000);
        const response = await this.okxService.fetchTransferState(transId);
        console.log(JSON.stringify(response));
        if (response.state === "success") {
          transferSuccess = true;
        }
      } while (!transferSuccess);
      console.log(
        `Transfer ${withdrawAmount} from Funding Account to Trading Account Done`
      );
      await sleep(5000);

      const fundingUSDTBalance = await this.okxService.fetchFundingBalance(
        "USDT"
      );

      const withdrawRes = await this.okxService.withdrawAssset(
        "USDT",
        fundingUSDTBalance.availBal,
        arbitrageur.address
      );
      const wdId = withdrawRes.wdId;
      let withdrawSuccess = false;
      do {
        await sleep(10000);
        const response = await this.okxService.fetchWithdrawState(wdId);
        console.log(JSON.stringify(response));
        const withdrawStatus = response.state.split(":")[0].toLowerCase();
        if (withdrawStatus === "cancellation complete") {
          throw new Error("Withdraw from OKX cancelled");
        } else if (withdrawStatus === "withdrawal complete") {
          withdrawSuccess = true;
        } else {
          withdrawSuccess = false;
        }
      } while (!withdrawSuccess);
      await sleep(5000);
    } catch (e) {
      console.log(e);
      this.monitorService.slackMessage(
        "REBALANCE OKX -> AARK FAILED",
        `OKX withdaw failed ${JSON.stringify(rebalanceInfo)}`,
        60_000,
        true,
        true
      );
      this.localState.rebalanceState = {
        state: RebalanceState.HALT,
        timestamp,
      };
      return false;
    }

    // Step 2 : Convert USDT to USDC with Uniswap
    try {
      const usdtBalance = await getERC20Balance(
        arbitrageur,
        "USDT",
        arbitrageur.address
      );

      let swappedUSDC = await uniswapArbitrum(
        arbitrageur,
        "USDT",
        "USDC",
        usdtBalance
      );
      console.log("Swapped USDC : ", swappedUSDC);
      await sleep(5000);
    } catch (e) {
      console.log(e);
      this.monitorService.slackMessage(
        "REBALANCE OKX -> AARK FAILED",
        `Convert USDT -> USDC fail : ${JSON.stringify(rebalanceInfo)}`,
        60_000,
        true,
        true
      );
      this.localState.rebalanceState = {
        state: RebalanceState.HALT,
        timestamp,
      };
      return false;
    }

    // Step 3 : Deposit USDC to Aark futures account
    try {
      const usdcBalance = await getERC20Balance(
        arbitrageur,
        "USDC",
        arbitrageur.address
      );
      const vaultAddress = contractAddressMap["vault"];
      await approveERC20(arbitrageur, vaultAddress, "USDC", usdcBalance);
      await this.aarkService.depositUSDC(usdcBalance);
      await sleep(5000);
    } catch (e) {
      console.log(e);
      this.monitorService.slackMessage(
        "REBALANCE OKX -> AARK FAILED",
        `Aark Deposit fail : ${JSON.stringify(rebalanceInfo)}`,
        60_000,
        true,
        true
      );
      this.localState.rebalanceState = {
        state: RebalanceState.HALT,
        timestamp,
      };
      return false;
    }

    this.localState.rebalanceState = {
      state: RebalanceState.NONE,
      timestamp,
    };

    this.monitorService.slackMessage(
      `REBALANCE FINISHED`,
      `Rebalance from OKX to AARK finished : ${JSON.stringify({
        endTime: new Date().toISOString(),
        elapsedTimeMs: Date.now() - timestamp,
      })}`,
      60_000,
      false,
      false
    );
    return true;
  }

  async _rebalanceFromAarkToOkx(): Promise<boolean> {
    // 1. Withdraw USDC from Aark
    // 2. Convert USDC to USDT
    // 3. Send converted USDT to given OKX deposit address.
    const timestamp = Date.now();

    this.monitorService.slackMessage(
      `REBALANCE START`,
      `Rebalance from AARK to OKX started : ${JSON.stringify({
        startTime: new Date().toISOString(),
      })}`,
      60_000,
      false,
      false
    );

    const aarkUSDC = this._getAarkUSDCBalance();
    const okxUSDT = this._getOkxUSDTBalance();
    const withdrawAmount = round_dp(
      Math.max(
        Math.min(
          aarkUSDC -
            this.params.INITIAL_BALANCE_USDT *
              this.params.BALANCE_RATIO_IN_AARK,
          this.params.MAX_REBALANCE_USDT
        ),
        0
      ),
      4
    );

    if (withdrawAmount === undefined || Number.isNaN(withdrawAmount)) {
      this.monitorService.slackMessage(
        `REBALANCE ERROR`,
        `undefined withdrawAmount : ${withdrawAmount}`,
        60_000,
        true,
        true
      );
      this.localState.rebalanceState = {
        state: RebalanceState.HALT,
        timestamp,
      };
      return false;
    }

    if (withdrawAmount === 0) {
      this.localState.rebalanceState = {
        state: RebalanceState.NONE,
        timestamp,
      };
      return true;
    }

    const arbitrageur = this.aarkService.getSigner();

    const rebalanceInfo = {
      "AARK USDC Balance": aarkUSDC,
      "OKX USDT Balance": okxUSDT,
      "Amount to Rebalance": withdrawAmount,
    };
    console.log(
      arbitrageur.address,
      rebalanceInfo,
      withdrawAmount,
      this.params.MAX_REBALANCE_USDT
    );

    this.localState.rebalanceState = {
      state: RebalanceState.HALT,
      timestamp,
    };
    return false;

    // Step 1 : Withdraw USDC from Aark
    try {
      await this.aarkService.withdrawUSDC(withdrawAmount);
      await sleep(5000);
    } catch (e) {
      console.log(e);
      this.monitorService.slackMessage(
        "REBALANCE AARK -> OKX FAILED",
        `Aark withdraw fail : ${JSON.stringify(rebalanceInfo)}`,
        60_000,
        true,
        true
      );
      this.localState.rebalanceState = {
        state: RebalanceState.HALT,
        timestamp,
      };
      return false;
    }

    // Step 2 : Convert USDC to USDT
    try {
      const usdcBalance = await getERC20Balance(
        arbitrageur,
        "USDC",
        arbitrageur.address
      );

      let swappedUSDT = await uniswapArbitrum(
        arbitrageur,
        "USDC",
        "USDT",
        usdcBalance
      );
      console.log("Swapped USDT : ", swappedUSDT);
      await sleep(5000);
    } catch (e) {
      console.log(e);
      this.monitorService.slackMessage(
        "REBALANCE AARK -> OKX FAILED",
        `Convert USDC -> USDT fail : ${JSON.stringify(rebalanceInfo)}`,
        60_000,
        true,
        true
      );
      this.localState.rebalanceState = {
        state: RebalanceState.HALT,
        timestamp,
      };
      return false;
    }

    // Step 3 : Send converted USDT to given OKX deposit address.
    try {
      if (this.params.OKX_DEPOSIT_ADDRESS === undefined) {
        throw Error("Undefined OKX_DEPOSIT_ADDRESS");
      }
      const usdtBalance = await getERC20Balance(
        arbitrageur,
        "USDT",
        arbitrageur.address
      );
      await transferERC20(
        arbitrageur,
        this.params.OKX_DEPOSIT_ADDRESS,
        "USDT",
        usdtBalance
      );
      await sleep(5000);
    } catch (e) {
      console.log(e);
      this.monitorService.slackMessage(
        "REBALANCE AARK -> OKX FAILED",
        `OKX deposit fail : ${JSON.stringify(rebalanceInfo)}`,
        60_000,
        true,
        true
      );
      this.localState.rebalanceState = {
        state: RebalanceState.HALT,
        timestamp,
      };
      return false;
    }

    this.localState.rebalanceState = {
      state: RebalanceState.NONE,
      timestamp,
    };

    this.monitorService.slackMessage(
      `REBALANCE FINISHED`,
      `Rebalance from AARK to OKX finished : ${JSON.stringify({
        endTime: new Date().toISOString(),
        elapsedTimeMs: Date.now() - timestamp,
      })}`,
      60_000,
      false,
      false
    );

    return true;
  }
}
