import BigNumber from "bignumber.js";
import ccxt, { Order, Exchange } from "ccxt";
import { BinancePosition } from "../interfaces/binance-interface";
import { OrderBook, binanceusdm } from "ccxt";
import { sleep } from "../utils/time";
import { loadTargetMarketSymbols } from "../utils/env";
import { IExchangeService } from "../class/exchange-class";
import { IMarketInfo } from "../interfaces/market-interface";
import {
  ActionType,
  IActionParam,
  ICancelOrderParam,
  ILimitOrderParam,
  IMarketOrderParam,
  Side,
} from "../interfaces/order-interface";
export class BinanceService {
  private client: Exchange;
  private symbolList: string[];
  private marketInfo: { [symbol: string]: IMarketInfo } = {};

  constructor(apiKey: string, secret: string, symbolList: string[]) {
    this.client = new ccxt.binanceusdm({
      apiKey,
      secret,
    });
    this.symbolList = symbolList;
    this.symbolList.forEach((symbol) => {
      this.marketInfo[symbol] = {
        orderbook: undefined,
        position: undefined,
        openOrders: undefined,
        balance: undefined,
      };
    });
  }

  getFormattedSymbol(symbol: string) {
    const [base, quote] = symbol.split("_");
    return `${base}/${quote}`;
  }

  getMarketInfo() {
    return this.marketInfo;
  }

  async fetchOrderbooks() {
    const orderbooks: { [symbol: string]: OrderBook | undefined } = {};
    for (const symbol of this.symbolList) {
      try {
        const ob = await this.client.fetchOrderBook(
          this.getFormattedSymbol(symbol)
        );
        this.marketInfo[symbol].orderbook = {
          symbol,
          bids: ob.bids,
          asks: ob.asks,
          timestamp: ob.timestamp,
        };
      } catch (e) {
        console.log(`[ERROR] Failed to fetch ${symbol} orderbook : ${e}`);
        this.marketInfo[symbol].orderbook = undefined;
      }
      await sleep(100);
    }
    return orderbooks;
  }

  async fetchPositions() {
    try {
      const result: { [symbol: string]: BinancePosition } = {};
      const balances = await this.client.fetchBalance();

      this.symbolList.forEach((symbol: string) => {
        const fsymbol = this.getFormattedSymbol(symbol);
        const positionInfo = balances.info.positions.find(
          (pos: any) => pos.symbol === fsymbol
        );
        if (positionInfo !== undefined) {
          const qty = Math.abs(Number(positionInfo.positionAmt));
          const side = qty > 0 ? Side.Buy : qty < 0 ? Side.Sell : Side.Zero;
          this.marketInfo[symbol].position = {
            symbol,
            qty,
            side,
            timestamp: positionInfo.updateTime,
          };
        }
      });
      return result;
    } catch (e) {
      console.log(`[ERROR] Failed to fetch Balance & Position Info : ${e}`);
      this.symbolList.forEach((symbol: string) => {
        this.marketInfo[symbol].position = undefined;
      });
    }
  }

  async fetchOpenOrders(): Promise<void> {
    for (const symbol of this.symbolList) {
      try {
        const oo = await this.client.fetchOpenOrders(
          this.getFormattedSymbol(symbol)
        );
        this.marketInfo[symbol].openOrders = oo.map((openOrder: any) => ({
          symbol,
          orderId: openOrder.id,
          price: openOrder.price,
          qty: openOrder.amount,
          side: openOrder.side === "buy" ? Side.Buy : Side.Sell,
          remaining: openOrder.remaining,
          timestamp: openOrder.timestamp,
        }));
      } catch (e) {
        console.log(`[ERROR] Failed to fetch ${symbol} open orders : ${e}`);
        this.marketInfo[symbol].openOrders = undefined;
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
          param.side.toString(),
          param.qty
        )
      )
    );
    console.log(JSON.stringify(limitOrderParams, null, 2));
    await Promise.all(
      limitOrderParams.map((param: ILimitOrderParam) =>
        this.client.createOrder(
          this.getFormattedSymbol(param.symbol),
          "limit",
          param.side.toString(),
          param.qty,
          param.price
        )
      )
    );
  }
}
