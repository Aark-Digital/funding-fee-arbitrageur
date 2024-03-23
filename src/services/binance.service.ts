import axios from "axios";
import CryptoJS from "crypto-js";
import { IMarket } from "../interfaces/market-interface";
import {
  ActionType,
  IActionParam,
  ICancelOrderParam,
  ILimitOrderParam,
  IMarketOrderParam,
} from "../interfaces/order-interface";
import {
  ceil_dp,
  convertSizeToContractAmount,
  floor_dp,
  numberToPrecision,
} from "../utils/number";
import { Balance, OpenOrders, Position } from "../interfaces/basic-interface";
import { stream } from "tardis-dev";
import AVLTree from "avl";
import {
  avlTreeToArray,
  emptyAVLTree,
  updateAVLTree,
} from "../utils/orderbook";
import { MonitorService } from "./monitor.service";
import { sleep } from "../utils/time";

export class BinanceSwapService {
  private baseUrl: string = "https://fapi.binance.com";
  private symbolList: string[];
  private markets: { [symbol: string]: IMarket } = {};
  private balances: undefined | Balance[];
  private orderbookUpdates: { [symbol: string]: any[] } = {};
  private apiInfo: {
    apiKey: string;
    secret: string;
  };
  private avlOrderbooks: {
    [symbol: string]:
      | undefined
      | {
          timestamp: number;
          seqId: number;
          asks: AVLTree<number, number>;
          bids: AVLTree<number, number>;
        };
  } = {};
  private orderbookAvailableTimestamp: number = 0;
  private monitorService: MonitorService = MonitorService.getInstance();

  constructor(apiKey: string, secret: string, symbolList: string[]) {
    this.apiInfo = {
      apiKey,
      secret,
    };
    this.symbolList = symbolList;
    this.symbolList.forEach((symbol) => {
      this.markets[symbol] = {
        position: undefined,
        orderbook: undefined,
        fundingRate: undefined,
        openOrders: undefined,
        marketInfo: { contractSize: 0, pricePrecision: 0, qtyPrecision: 0 },
      };
    });
    this.balances = undefined;
  }

  async init() {
    this.initializeOrderbookStream();
    const totalMarketInfo = await this._publicGet("/fapi/v1/exchangeInfo", {});
    // console.log(totalMarketInfo);
    this.symbolList.forEach((symbol: string) => {
      const targetSymbol = `${this.getFormattedSymbol(symbol)}`;
      const marketInfo = totalMarketInfo.symbols.find(
        (info: any) =>
          info.symbol === targetSymbol && info.contractType === "PERPETUAL"
      )!;
      const priceFilter = marketInfo.filters.find(
        (filter: any) => filter.filterType === "PRICE_FILTER"
      );
      const qtyFilter = marketInfo.filters.find(
        (filter: any) => filter.filterType === "LOT_SIZE"
      );
      this.markets[symbol].marketInfo = {
        contractSize: 1,
        pricePrecision: numberToPrecision(Number(priceFilter.tickSize)),
        qtyPrecision: numberToPrecision(Number(qtyFilter.stepSize)),
      };
    });

    await sleep(5000);
  }

  private async initializeOrderbookStream() {
    do {
      const timestamp = Date.now();
      this._initializeOrderbookStream(timestamp);
      await sleep(1000);
      for (const symbol of this.symbolList) {
        await this.__initializeOrderbookSnapshot(
          this.getFormattedSymbol(symbol).toLowerCase()
        );
      }
      console.log("Finished to initialize orderbook");
      await sleep(timestamp + 3_600_000 - Date.now());
      console.log("RE-INITIALIZE ORDERBOOK : ", new Date().toISOString());
      this.symbolList.forEach((symbol) => {
        const fsymbol = this.getFormattedSymbol(symbol).toLowerCase();
        this.avlOrderbooks[fsymbol] = undefined;
        this.orderbookUpdates[fsymbol] = [];
      });
      this.avlOrderbooks = {};
      this.orderbookUpdates = {};
    } while (1);
  }

  private async _initializeOrderbookStream(ts: number) {
    this.monitorService.slackMessage(
      "INITIALIZE ORDERBOOK STREAM",
      "",
      60_000,
      false,
      false
    );
    console.log(`INITIALIZE ORDERBOK STREAM at ${new Date().toISOString()}`);
    for (const symbol of this.symbolList) {
      const fsymbol = this.getFormattedSymbol(symbol).toLowerCase();
      this.orderbookUpdates[fsymbol] = [];
      this.avlOrderbooks[fsymbol] = undefined;
    }

    const messages = stream({
      exchange: "binance-futures",
      filters: [
        {
          channel: "depth",
          symbols: this.symbolList.map((symbol) =>
            this.getFormattedSymbol(symbol).toLowerCase()
          ),
        } as any,
      ],
    });
    for await (const messageResponse of messages) {
      const message = messageResponse.message;
      if (message.stream === undefined) {
        continue;
      }
      const symbol = message.stream.split("@")[0];
      const update = message.data;
      if (this.avlOrderbooks[symbol] === undefined) {
        this.orderbookUpdates[symbol].push(message.data);
      } else {
        const orderbook = this.avlOrderbooks[symbol];
        if (orderbook!.seqId !== update.pu) {
          console.log(
            `${symbol} : orderbook.seqId !== update.pu : ${
              orderbook!.seqId
            } !== ${update.pu}`
          );
          this.avlOrderbooks[symbol] = undefined;
          this.orderbookUpdates[symbol] = [];
          this.__initializeOrderbookSnapshot(symbol);
        } else {
          const asks = orderbook!.asks;
          const bids = orderbook!.bids;
          updateAVLTree(
            asks,
            update.a.map((d: any) => [Number(d[0]), Number(d[1])])
          );
          updateAVLTree(
            bids,
            update.b.map((d: any) => [Number(d[0]), Number(d[1])])
          );
          orderbook!.seqId = update.u;
        }
      }
      const currentTimestamp = Date.now();
      if (currentTimestamp - ts > 3_600_000) {
        console.log(`CLEAR-ORDERBOOK  ${new Date().toISOString()}`);
        break;
      }
    }
  }

  async __initializeOrderbookSnapshot(symbol: string) {
    let done = false;
    const startTime = Date.now();
    let cnt = 1;
    do {
      if (Date.now() - startTime > 60_000) {
        this.monitorService.slackMessage(
          `BINANCE ORDERBOOK ERROR`,
          `Failed to fetch ${symbol} orderbook ${cnt} times`,
          60_000,
          true,
          true
        );
      }
      try {
        console.log(`Fetch Binance Futures ${symbol} Orderbook`);
        const orderbook = await axios
          .get(
            `https://fapi.binance.com/fapi/v1/depth?symbol=${symbol.toUpperCase()}&limit=1000`
          )
          .then((res) => res.data);
        console.log(orderbook.lastUpdateId);
        const targetOrderbookUpdates = this.orderbookUpdates[symbol].filter(
          (update) => update.u >= orderbook.lastUpdateId
        );
        if (targetOrderbookUpdates.length > 0) {
          const firstUpdate = targetOrderbookUpdates[0];
          if (
            firstUpdate.U > orderbook.lastUpdateId ||
            firstUpdate.u < orderbook.lastUpdateId
          ) {
            throw new Error("Invalid lastUpdateId");
          } else {
            this.orderbookUpdates[symbol] = targetOrderbookUpdates;
            const avlOrderbook = {
              timestamp: orderbook.E,
              asks: emptyAVLTree(true),
              bids: emptyAVLTree(false),
              seqId: orderbook.lastUpdateId,
            };
            updateAVLTree(
              avlOrderbook.asks,
              orderbook.asks.map((d: any) => [Number(d[0]), Number(d[1])])
            );
            updateAVLTree(
              avlOrderbook.bids,
              orderbook.bids.map((d: any) => [Number(d[0]), Number(d[1])])
            );

            while (this.orderbookUpdates[symbol].length > 0) {
              const update = this.orderbookUpdates[symbol].pop();
              updateAVLTree(
                avlOrderbook.asks,
                update.a.map((x: any) => [Number(x[0]), Number(x[1])])
              );
              updateAVLTree(
                avlOrderbook.bids,
                update.b.map((x: any) => [Number(x[0]), Number(x[1])])
              );
              avlOrderbook.seqId = update.u;
            }

            this.avlOrderbooks[symbol] = avlOrderbook;
            done = true;
          }
        } else {
          throw new Error("No available updates");
        }
      } catch (e) {
        console.log(`Failed to fetch ${symbol} orderbook`);
        await sleep(2000);
      }

      // break;
    } while (!done);
  }

  getFormattedSymbol(symbol: string) {
    const [base, quote] = symbol.split("_");
    return `${base}${quote}`;
  }

  getMarketInfo() {
    return this.markets;
  }

  getBalance() {
    return this.balances;
  }

  isOrderbookAvailable(ts: number) {
    return this.orderbookAvailableTimestamp < ts;
  }

  async fetchOrderbooks() {
    try {
      this.symbolList.forEach((symbol: string, idx: number) => {
        const orderbook =
          this.avlOrderbooks[this.getFormattedSymbol(symbol).toLowerCase()]!;
        if (orderbook === undefined) {
          this.markets[symbol].orderbook = undefined;
        } else {
          const asks = orderbook.asks;
          const bids = orderbook.bids;
          const timestamp = orderbook.timestamp;
          this.markets[symbol].orderbook = {
            symbol: symbol,
            bids: avlTreeToArray(bids),
            asks: avlTreeToArray(asks),
            timestamp: timestamp,
          };
        }
      });
    } catch (e) {
      console.log(`[ERROR] Failed to fetch orderbooks : ${e}`);
      for (const symbol of this.symbolList) {
        this.markets[symbol].orderbook = undefined;
      }
    }
  }

  async fetchOpenOrders(): Promise<void> {
    const timestamp = new Date().getTime();
    try {
      const openOrders = await Promise.all(
        this.symbolList.map((symbol) =>
          this._privateGet("/fapi/v1/openOrders", {
            symbol: this.getFormattedSymbol(symbol),
            timestamp: timestamp.toString(),
          })
        )
      );
      this.symbolList.forEach((symbol: string, idx: number) => {
        const marketOpenOrders = openOrders[idx].data;
        this.markets[symbol].openOrders = {
          openOrders: marketOpenOrders.map((oo: any) => ({
            timestamp,
            symbol,
            orderId: oo.orderId,
            price: Number(oo.price),
            size: oo.side === "BUY" ? Number(oo.origQty) : -Number(oo.origQty),
            remaining: Number(oo.origQty) - Number(oo.executeQty),
          })),
          timestamp,
        };
      });
    } catch (e) {
      console.log(`[ERROR] Failed to fetch open orders : ${e}`);
    }
  }

  async fetchFundingRate(): Promise<void> {
    const timestamp = new Date().getTime();
    try {
      const fundingRates: any[] = await this._publicGet(
        "/fapi/v1/premiumIndex",
        {}
      );
      console.log(fundingRates);
      this.symbolList.forEach((symbol: string) => {
        const fsymbol = this.getFormattedSymbol(symbol);
        const fr = fundingRates.find((v) => v.symbol === fsymbol);
        this.markets[symbol].fundingRate = {
          timestamp,
          symbol,
          fundingRate: Number(fr.lastFundingRate),
          fundingTime: Number(fr.nextFundingTime),
        };
      });
    } catch (e) {
      console.log(`[ERROR] Failed to fetch funding rates : ${e}`);
      for (const symbol of this.symbolList) {
        this.markets[symbol].fundingRate = undefined;
      }
    }
  }

  async fetchAccountInfo(): Promise<void> {
    const timestamp = new Date().getTime();
    try {
      const accountInfo: any = await this._privateGet("/fapi/v2/account", {
        timestamp: Date.now().toString(),
      });
      this.balances = (accountInfo.data.assets as any[])
        .filter((assetInfo: any) => Number(assetInfo.walletBalance) !== 0)
        .map((assetInfo: any) => ({
          currency: assetInfo.asset,
          total: Number(assetInfo.walletBalance),
          available: Number(assetInfo.maxWithdrawAmount),
          timestamp,
        }));
      this.symbolList.forEach((symbol: string) => {
        const targetSymbol = this.getFormattedSymbol(symbol);
        const position = accountInfo.data.positions.find(
          (position: any) => position.symbol === targetSymbol
        );
        this.markets[symbol].position = {
          symbol,
          timestamp,
          price: Number(position.entryPrice),
          size: Number(position.positionAmt),
        };
      });
    } catch (e) {
      console.log(`[ERROR] Failed to fetch account info : ${e}`);
      this.balances = undefined;
      for (const symbol of this.symbolList) {
        this.markets[symbol].position = undefined;
      }
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

    await Promise.all(cancelParams.map((param) => this._cancelOrder(param)));
    await Promise.all(
      marketOrderParams.map((param) => this._createMarketOrder(param))
    );
    await Promise.all(
      limitOrderParams.map((param) => this._createLimitOrder(param))
    );
  }

  private async _createMarketOrder(param: IMarketOrderParam) {
    return this._privatePost("/fapi/v1/order", {
      symbol: this.getFormattedSymbol(param.symbol),
      side: param.size > 0 ? "BUY" : "SELL",
      type: "MARKET",
      quantity: Math.abs(param.size).toString(),
      timestamp: Date.now().toString(),
    });
  }

  private async _createLimitOrder(param: ILimitOrderParam) {
    return this._privatePost("/fapi/v1/order", {
      symbol: this.getFormattedSymbol(param.symbol),
      side: param.size > 0 ? "BUY" : "SELL",
      type: "LIMIT",
      quantity: Math.abs(param.size).toString(),
      price: param.price.toString(),
      timeinforce: "GTC",
      timestamp: Date.now().toString(),
    });
  }

  private async _cancelOrder(param: ICancelOrderParam) {
    return this._delete("/fapi/v1/order", {
      symbol: this.getFormattedSymbol(param.symbol),
      orderId: param.orderId,
      timestamp: Date.now().toString(),
    });
  }

  _getSignatureFromParams(
    params: { [key: string]: string },
    secret: string
  ): string {
    return CryptoJS.HmacSHA256(
      CryptoJS.enc.Utf8.parse(new URLSearchParams(params).toString()),
      CryptoJS.enc.Utf8.parse(secret)
    ).toString(CryptoJS.enc.Hex);
  }

  private async _publicGet(
    endPoint: string,
    params: { [key: string]: string }
  ): Promise<any> {
    const queryString = new URLSearchParams(params).toString();
    const url =
      this.baseUrl +
      (Object.keys(params).length === 0
        ? endPoint
        : endPoint + "?" + queryString);

    // Public Request
    const response = await axios.get(url, { timeout: 5000 });
    return response.data;
  }

  private async _privateGet(
    endPoint: string,
    params: { [key: string]: string }
  ): Promise<any> {
    const paramsWithSignature = Object.assign(params, {
      signature: this._getSignatureFromParams(params, this.apiInfo.secret),
    });
    const queryString = new URLSearchParams(paramsWithSignature).toString();
    const url =
      this.baseUrl +
      (Object.keys(params).length === 0
        ? endPoint
        : endPoint + "?" + queryString);
    const response = await axios.get(url, {
      headers: {
        "X-MBX-APIKEY": process.env.BINANCE_API_KEY!,
      },
      timeout: 5000,
    });

    return response;
  }

  private async _privatePost(
    endPoint: string,
    params: { [key: string]: string }
  ): Promise<any> {
    const paramsWithSignature = Object.assign(params, {
      signature: this._getSignatureFromParams(params, this.apiInfo.secret),
    });
    const url = this.baseUrl + endPoint;
    console.log(url);
    console.log(paramsWithSignature);
    const response = await axios.post(this.baseUrl + endPoint, null, {
      headers: {
        "X-MBX-APIKEY": process.env.BINANCE_API_KEY!,
      },
      params: paramsWithSignature,
      timeout: 5000,
    });
    return response.data;
  }

  private async _delete(endPoint: string, params: { [key: string]: string }) {
    const paramsWithSignature = Object.assign(params, {
      signature: this._getSignatureFromParams(
        params,
        process.env.BINANCE_SECRET!
      ),
    });
    const url = this.baseUrl + endPoint;
    console.log(url);
    console.log(paramsWithSignature);
    const response = await axios.delete(this.baseUrl + endPoint, {
      headers: {
        "X-MBX-APIKEY": process.env.BINANCE_API_KEY!,
      },
      params: paramsWithSignature,
      timeout: 5000,
    });
    return response.data;
  }
}
