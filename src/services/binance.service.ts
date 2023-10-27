import BigNumber from "bignumber.js";
import ccxt, { Order } from "ccxt";
import { BinancePosition } from "../interfaces/binance-interface";
import { OrderBook, binanceusdm } from "ccxt";
import { sleep } from "../utils/time";
import { loadTargetMarketSymbols } from "../utils/env";
import { OrderInfo } from "../interfaces/order-interface";
export class BinanceService {
  private client: binanceusdm;
  private symbolList: string[];
  private marketStatus: {
    [symbol: string]: {
      orderbook: OrderBook | undefined;
      position: BinancePosition | undefined;
    };
  };

  constructor(symbolList: string[]) {
    this.client = new ccxt.binanceusdm({
      apiKey: process.env.BINANCE_API_KEY,
      secret: process.env.BINANCE_SECRET,
    });
    this.symbolList = symbolList;
    this.marketStatus = {};
    this.symbolList.forEach((symbol) => {
      this.marketStatus[symbol] = { orderbook: undefined, position: undefined };
    });
  }

  async fetchAll(): Promise<
    [
      { [symbol: string]: OrderBook | undefined },
      { [symbol: string]: BinancePosition },
      number
    ]
  > {
    const [orderbooks, positions, USDC_USDT_PRICE] = await Promise.all([
      this.fetchOrderbooks(),
      this.fetchPositions(),
      this.fetchUSDCPrice(),
    ]);

    return [orderbooks, positions, USDC_USDT_PRICE];
  }

  async fetchUSDCPrice(): Promise<number> {
    try {
      const orderbook = await this.client.fetchOrderBook("USDC/USDT");
      return (orderbook.asks[0][0] + orderbook.bids[0][0]) / 2;
    } catch (e) {
      throw new Error(`[Error] Failed to get USDC Price : ${e}`);
    }
  }

  async fetchOrderbooks(): Promise<{
    [symbol: string]: OrderBook | undefined;
  }> {
    const orderbooks: { [symbol: string]: OrderBook | undefined } = {};
    for (const symbol of this.symbolList) {
      try {
        const ob = await this.client.fetchOrderBook(`${symbol}/USDT`);
        orderbooks[symbol] = ob;
      } catch (e) {
        console.log(`[ERROR] Failed to fetch ${symbol} orderbook : ${e}`);
        orderbooks[symbol] = undefined;
      }
      await sleep(100);
    }
    return orderbooks;
  }

  async fetchPositions(): Promise<{ [symbol: string]: BinancePosition }> {
    try {
      const result: { [symbol: string]: BinancePosition } = {};
      const balances = await this.client.fetchBalance();

      const targetPositions = balances.info.positions.filter((info: any) =>
        this.symbolList.includes(info.symbol.replace("USDT", ""))
      );
      targetPositions.forEach((position: any) => {
        result[position.symbol.replace("USDT", "")] = {
          symbol: position.symbol.replace("USDT", ""),
          amount: Number(position.positionAmt),
          notionalValue: Number(position.notional),
        };
      });

      return result;
    } catch (e) {
      throw new Error(`[Error] Failed to fetch Position : ${e}`);
    }
  }

  async createOrders(orderInfo: { [symbol: string]: OrderInfo }) {
    return;
  }
}
