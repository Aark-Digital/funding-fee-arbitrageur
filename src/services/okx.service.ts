import ccxt, { Exchange } from "ccxt";
import { sleep } from "../utils/time";
import { IMarket } from "../interfaces/market-interface";
import {
  ActionType,
  IActionParam,
  ICancelOrderParam,
  ILimitOrderParam,
  IMarketOrderParam,
  Side,
} from "../interfaces/order-interface";
import {
  ceil_dp,
  convertSizeToContractAmount,
  floor_dp,
  numberToPrecision,
  round_dp,
} from "../utils/number";

export class OkxSwapService {
  private client: Exchange;
  private symbolList: string[];
  private markets: { [symbol: string]: IMarket } = {};

  constructor(
    apiKey: string,
    secret: string,
    password: string,
    symbolList: string[]
  ) {
    this.client = new ccxt.okex({
      apiKey,
      secret,
      password,
    });
    this.symbolList = symbolList;
    this.symbolList.forEach((symbol) => {
      this.markets[symbol] = {
        orderbook: undefined,
        position: undefined,
        openOrders: undefined,
        balance: undefined,
        marketInfo: { contractSize: 0, pricePrecision: 0, qtyPrecision: 0 },
      };
    });
  }

  async init() {
    const totalMarketInfo = await this.client.fetchMarkets();
    this.symbolList.forEach((symbol: string) => {
      const targetInstId = `${symbol.replace("_", "-")}-SWAP`;
      const marketInfo = totalMarketInfo.find(
        (info: any) => info.id === targetInstId
      )!;
      this.markets[symbol].marketInfo = {
        contractSize: marketInfo.contractSize!,
        pricePrecision: numberToPrecision(marketInfo.precision.price!),
        qtyPrecision: numberToPrecision(marketInfo.precision.amount!),
      };
    });
  }

  getFormattedSymbol(symbol: string) {
    const [base, quote] = symbol.split("_");
    return `${base}/${quote}:${quote}`;
  }

  getMarketInfo() {
    return this.markets;
  }

  async fetchOrderbooks() {
    for (const symbol of this.symbolList) {
      try {
        const ob = await this.client.fetchOrderBook(
          this.getFormattedSymbol(symbol)
        );
        this.markets[symbol].orderbook = {
          symbol,
          bids: ob.bids,
          asks: ob.asks,
          timestamp: ob.timestamp,
        };
      } catch (e) {
        console.log(`[ERROR] Failed to fetch ${symbol} orderbook : ${e}`);
        this.markets[symbol].orderbook = undefined;
      }
      await sleep(100);
    }
  }

  async fetchPositions() {
    for (const symbol of this.symbolList) {
      try {
        const position = await this.client.fetchPosition(
          this.getFormattedSymbol(symbol)
        );
        this.markets[symbol].position = {
          symbol,
          price: position.entryPrice ?? 0,
          size:
            position.contracts! *
            position.contractSize! *
            (position.side === "long" ? 1 : -1),
          timestamp: new Date().getTime()!,
        };
      } catch (e) {
        console.log(`[ERROR] Failed to fetch ${symbol} position : ${e}`);
        this.markets[symbol].orderbook = undefined;
      }
      await sleep(100);
    }
  }

  async fetchOpenOrders(): Promise<void> {
    for (const symbol of this.symbolList) {
      try {
        const oo = await this.client.fetchOpenOrders(
          this.getFormattedSymbol(symbol)
        );
        this.markets[symbol].openOrders = {
          timestamp: new Date().getTime(),
          openOrders: oo.map((openOrder: any) => ({
            symbol,
            orderId: openOrder.id,
            price: openOrder.price,
            size:
              openOrder.side === "buy" ? openOrder.amount : -openOrder.amount,
            remaining:
              openOrder.side === "buy"
                ? openOrder.remaining
                : -openOrder.remaining,
            timestamp: openOrder.timestamp,
          })),
        };
      } catch (e) {
        console.log(`[ERROR] Failed to fetch ${symbol} open orders : ${e}`);
        this.markets[symbol].openOrders = undefined;
      }
      await sleep(100);
    }
  }

  // TODO: Is there better way to do this??
  async executeOrders(actionParams: IActionParam[]) {
    const cancelParams = actionParams
      .filter((param: IActionParam) => param.type === ActionType.Cancel)
      .map((param: IActionParam) => param.order) as ICancelOrderParam[];
    const marketOrderParams = actionParams
      .filter((param: IActionParam) => param.type === ActionType.CreateMarket)
      .map((param: IActionParam) => param.order) as IMarketOrderParam[];
    const limitOrderParams = actionParams
      .filter((param: IActionParam) => param.type === ActionType.CreateLimit)
      .map((param: IActionParam) => param.order) as ILimitOrderParam[];

    await Promise.all(
      cancelParams.map((param: ICancelOrderParam) =>
        this.client.cancelOrder(
          param.orderId,
          this.getFormattedSymbol(param.symbol)
        )
      )
    );
    await Promise.all(
      marketOrderParams.map((param: IMarketOrderParam) =>
        this.client.createOrder(
          this.getFormattedSymbol(param.symbol),
          "market",
          param.size > 0 ? "buy" : "sell",
          convertSizeToContractAmount(
            param.size,
            this.markets[param.symbol].marketInfo
          )
        )
      )
    );
    await Promise.all(
      limitOrderParams.map((param: ILimitOrderParam) =>
        this.client.createOrder(
          this.getFormattedSymbol(param.symbol),
          "limit",
          param.size > 0 ? "buy" : "sell",
          convertSizeToContractAmount(
            param.size,
            this.markets[param.symbol].marketInfo
          ),
          param.size > 0
            ? floor_dp(
                param.price,
                this.markets[param.symbol].marketInfo.pricePrecision
              )
            : ceil_dp(
                param.price,
                this.markets[param.symbol].marketInfo.pricePrecision
              )
        )
      )
    );
  }
}
