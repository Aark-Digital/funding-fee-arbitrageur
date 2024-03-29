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
  round_dp,
} from "../utils/number";
import { Balance } from "../interfaces/basic-interface";
import { stream } from "tardis-dev";
import AVLTree from "avl";
import {
  avlTreeToArray,
  emptyAVLTree,
  updateAVLTree,
} from "../utils/orderbook";
import { MonitorService } from "./monitor.service";
import { sleep } from "../utils/time";

export class OkxSwapService {
  private baseUrl: string = "https://www.okx.com";
  private symbolList: string[];
  private markets: { [symbol: string]: IMarket } = {};
  private balances: undefined | Balance[];
  private apiInfo: {
    apiKey: string;
    secret: string;
    password: string;
  };
  private avlOrderbooks: {
    [symbol: string]: {
      timestamp: number;
      seqId: number;
      asks: AVLTree<number, number>;
      bids: AVLTree<number, number>;
    };
  } = {};
  private orderbookAvailableTimestamp: number = 0;
  private monitorService: MonitorService = MonitorService.getInstance();

  constructor(
    apiKey: string,
    secret: string,
    password: string,
    symbolList: string[]
  ) {
    this.apiInfo = {
      apiKey,
      secret,
      password,
    };
    this.symbolList = symbolList;
    this.symbolList.forEach((symbol) => {
      this.markets[symbol] = {
        orderbook: undefined,
        position: undefined,
        openOrders: undefined,
        fundingRate: undefined,
        marketInfo: { contractSize: 0, pricePrecision: 0, qtyPrecision: 0 },
      };
    });
    this.balances = undefined;
  }

  async init() {
    this.initializeOrderbookStream();
    const totalMarketInfo = await this._publicGet(
      "/api/v5/public/instruments",
      {
        instType: "SWAP",
      }
    );
    this.symbolList.forEach((symbol: string) => {
      const targetInstId = `${this.getFormattedSymbol(symbol)}`;
      const marketInfo = totalMarketInfo.data.find(
        (info: any) => info.instId === targetInstId
      )!;
      this.markets[symbol].marketInfo = {
        contractSize: Number(marketInfo.ctVal),
        pricePrecision: numberToPrecision(marketInfo.tickSz),
        qtyPrecision: numberToPrecision(marketInfo.lotSz),
      };
    });

    await sleep(5000);
  }

  private async initializeOrderbookStream() {
    while (1) {
      await this._initializeOrderbookStream(Date.now());
    }
  }

  private async _initializeOrderbookStream(ts: number) {
    this.monitorService.slackMessage(
      "INITIALIZE ORDERBOOK STREAM",
      "",
      60_000,
      false,
      false
    );
    console.log(`INITIALIZE ORDERBOK STREAM at ${new Date(ts).toISOString()}`);
    const messages = stream({
      exchange: "okex-swap",
      filters: [
        {
          channel: "books",
          symbols: this.symbolList.map(
            (symbol: string) => `${this.getFormattedSymbol(symbol)}`
          ),
        } as any,
      ],
    });
    for await (const messageResponse of messages) {
      if (messageResponse.message.action === undefined) {
        continue;
      }
      const message = messageResponse.message;
      if (message.action === "snapshot") {
        const asks = emptyAVLTree(true);
        const bids = emptyAVLTree(false);
        for (const ask of message.data[0].asks) {
          asks.insert(Number(ask[0]), Number(ask[1]));
        }
        for (const bid of message.data[0].bids) {
          bids.insert(Number(bid[0]), Number(bid[1]));
        }
        this.avlOrderbooks[message.arg.instId] = {
          timestamp: new Date(message.localTimestamp).getTime(),
          asks,
          bids,
          seqId: message.data[0].seqId,
        };
      } else if (message.action === "update") {
        const orderbook = this.avlOrderbooks[message.arg.instId];
        const asks = orderbook.asks;
        const bids = orderbook.bids;
        const data = message.data[0];
        if (data.prevSeqId != orderbook.seqId) {
          this.monitorService.slackMessage(
            "OKX ORDERBOOK ERROR",
            `(${message.arg.instId}) Sequence Skipped : ${data.prevSeqId}, ${orderbook.seqId}`,
            10_000,
            true,
            true
          );
        }
        updateAVLTree(
          asks,
          data.asks.map((quote: string[]) => [
            Number(quote[0]),
            Number(quote[1]),
          ])
        );
        updateAVLTree(
          bids,
          data.bids.map((quote: string[]) => [
            Number(quote[0]),
            Number(quote[1]),
          ])
        );
        orderbook.timestamp = Number(data.ts);
        orderbook.seqId = data.seqId;
      }
      const currentTimestamp = Date.now();
      if (currentTimestamp - ts > 1_800_000) {
        this.orderbookAvailableTimestamp = currentTimestamp + 10_000;
        break;
      }
    }
  }

  private _getSignature(
    timestamp: Date,
    requestPath: string,
    body: string,
    secretKey: string,
    method: string
  ) {
    const signature = CryptoJS.enc.Base64.stringify(
      CryptoJS.HmacSHA256(
        timestamp.toISOString() + method.toUpperCase() + requestPath + body,
        secretKey
      )
    );
    return signature;
  }

  getFormattedSymbol(symbol: string) {
    const [base, quote] = symbol.split("_");
    return `${base}-${quote}-SWAP`;
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
        const orderbook = this.avlOrderbooks[this.getFormattedSymbol(symbol)];
        const asks = orderbook.asks;
        const bids = orderbook.bids;
        const timestamp = orderbook.timestamp;
        this.markets[symbol].orderbook = {
          symbol: symbol,
          bids: avlTreeToArray(bids),
          asks: avlTreeToArray(asks),
          timestamp: timestamp,
        };
      });
    } catch (e) {
      console.log(`[ERROR] Failed to fetch orderbooks : ${e}`);
      for (const symbol of this.symbolList) {
        this.markets[symbol].orderbook = undefined;
      }
    }
  }

  // ONLY CROSS MARGIN IS AVAILABLE
  async fetchPositions() {
    const timestamp = new Date().getTime();
    try {
      const totalChunksNumber = Math.floor((this.symbolList.length + 9) / 10);
      const symbolChunks = Array.from(
        new Array(totalChunksNumber),
        (_, i: number) =>
          this.symbolList.filter(
            (_: any, j: number) => Math.floor(j / 10) === i
          )
      );
      const positionResponses = await Promise.all(
        symbolChunks.map((chunk: string[]) =>
          this._privateGet("/api/v5/account/positions", {
            instType: "SWAP",
            instId: chunk.map(this.getFormattedSymbol).join(","),
          }).then((response: any) => response.data)
        )
      );
      const positions = positionResponses.reduce(
        (acc: any[], positionResponse: any) => acc.concat(positionResponse),
        []
      );
      // const positions = await this._privateGet("/api/v5/account/positions", {
      //   instType: "SWAP",
      //   instId: this.symbolList.map(this.getFormattedSymbol).join(","),
      // });
      // console.log(positions);
      this.symbolList.forEach((symbol: string, idx: number) => {
        const contractSize = this.markets[symbol].marketInfo.contractSize;
        const position = positions.find(
          (pos: any) =>
            pos.mgnMode === "cross" &&
            pos.instId === this.getFormattedSymbol(symbol)
        );
        if (position === undefined) {
          console.log(
            `No previous trade in ${this.getFormattedSymbol(symbol)}.`
          );
          this.markets[symbol].position = {
            symbol,
            timestamp,
            size: 0,
            price: 0,
          };
        } else {
          this.markets[symbol].position = {
            symbol,
            size: Number(position.pos) * contractSize,
            price: Number(position.avgPx),
            timestamp,
          };
        }
      });
    } catch (e) {
      console.log(`[ERROR] Failed to fetch positions : ${e}`);
      for (const symbol of this.symbolList) {
        this.markets[symbol].position = undefined;
      }
    }
  }

  async fetchOpenOrders(): Promise<void> {
    const timestamp = new Date().getTime();
    try {
      const openOrders = await this._privateGet(
        "/api/v5/trade/orders-pending",
        {
          instType: "SWAP",
        }
      );
      this.symbolList.forEach((symbol: string) => {
        const marketOpenOrders = openOrders.data.filter(
          (oo: any) => oo.instId === this.getFormattedSymbol(symbol)
        );
        this.markets[symbol].openOrders = {
          openOrders: marketOpenOrders.map((oo: any) => ({
            timestamp,
            symbol,
            orderId: oo.ordId,
            price: Number(oo.px),
            size: oo.side === "buy" ? Number(oo.sz) : -Number(oo.sz),
            remaining: Number(oo.fillSz),
          })),
          timestamp,
        };
      });
    } catch (e) {
      console.log(`[ERROR] Failed to fetch open orders : ${e}`);
      for (const symbol of this.symbolList) {
        this.markets[symbol].openOrders = undefined;
      }
    }
  }

  async fetchBalances(): Promise<void> {
    const timestamp = new Date().getTime();
    try {
      const balances = await this._privateGet("/api/v5/account/balance", {});
      this.balances = balances.data[0].details.map((balance: any) => ({
        timestamp,
        currency: balance.ccy,
        total: Number(balance.eq),
        available: Number(balance.availEq),
      }));
    } catch (e) {
      console.log(`[ERROR] Failed to fetch balances : ${e}`);
      this.balances = undefined;
    }
  }

  async fetchFundingBalance(symbol: string) {
    const result = await this._privateGet("/api/v5/asset/balances", {
      symbol,
    });
    return result.data[0];
  }

  async fetchFundingRate(): Promise<void> {
    const timestamp = new Date().getTime();
    try {
      const fundingRates: any[] = await Promise.all(
        this.symbolList.map((symbol: string) =>
          this._publicGet("/api/v5/public/funding-rate", {
            instId: this.getFormattedSymbol(symbol),
          })
        )
      );
      this.symbolList.forEach((symbol: string, idx: number) => {
        const fr = fundingRates[idx].data[0];
        this.markets[symbol].fundingRate = {
          timestamp,
          symbol,
          fundingRate: Number(fr.fundingRate),
          fundingTime: Number(fr.fundingTime),
        };
      });
    } catch (e) {
      console.log(`[ERROR] Failed to fetch funding rates : ${e}`);
      for (const symbol of this.symbolList) {
        this.markets[symbol].fundingRate = undefined;
      }
    }
  }

  async fetchCurrencyInfo() {
    const result = await this._privateGet("/api/v5/asset/currencies", {});
    return result.data;
  }

  async withdrawAssset(currency: string, amount: number, toAddress: string) {
    if (!["USDT"].includes(currency)) {
      throw new Error(`Unexpected currency to withdraw : ${currency}`);
    }

    const totalCurrencyInfo = await this.fetchCurrencyInfo();
    const chain = `${currency}-Arbitrum One`;
    const currencyInfo = totalCurrencyInfo.find(
      (info: any) => info.chain === chain
    )!;
    const fee = currencyInfo.minFee;
    console.log();

    const response = await this._post("/api/v5/asset/withdrawal", {
      ccy: currency,
      amt: floor_dp(amount - fee, 6).toString(),
      dest: "4",
      toAddr: toAddress,
      fee,
      chain,
      walletType: "private",
    });
    console.log("withdrawAsset", JSON.stringify(response));
    return response.data[0];
  }

  async fetchWithdrawState(wdId: string) {
    const response = await this._privateGet(
      "/api/v5/asset/deposit-withdraw-status",
      {
        wdId,
      }
    );
    return response.data[0];
  }

  async transferAsset(currency: string, amount: number, fromTrading: boolean) {
    const response = await this._post("/api/v5/asset/transfer", {
      type: "0",
      ccy: currency,
      amt: round_dp(amount, 4).toString(),
      from: fromTrading ? "18" : "6",
      to: fromTrading ? "6" : "18",
    });
    console.log("transferAsset", JSON.stringify(response));
    return response.data[0];
  }

  async fetchTransferState(transId: string) {
    const response = await this._privateGet("/api/v5/asset/transfer-state", {
      transId,
    });
    return response.data[0];
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
    return this._post("/api/v5/trade/order", {
      instId: this.getFormattedSymbol(param.symbol),
      tdMode: "cross",
      side: param.size > 0 ? "buy" : "sell",
      ordType: "market",
      sz: `${convertSizeToContractAmount(
        param.size,
        this.markets[param.symbol].marketInfo
      )}`,
    });
  }

  private async _createLimitOrder(param: ILimitOrderParam) {
    return this._post("/api/v5/trade/order", {
      instId: this.getFormattedSymbol(param.symbol),
      tdMode: "cross",
      side: param.size > 0 ? "buy" : "sell",
      ordType: "limit",
      sz: convertSizeToContractAmount(
        param.size,
        this.markets[param.symbol].marketInfo
      ).toString(),
      px: (param.size > 0
        ? floor_dp(
            param.price,
            this.markets[param.symbol].marketInfo.pricePrecision
          )
        : ceil_dp(
            param.price,
            this.markets[param.symbol].marketInfo.pricePrecision
          )
      ).toString(),
    });
  }

  private async _cancelOrder(param: ICancelOrderParam) {
    return this._post("/api/v5/trade/cancel-order", {
      instId: this.getFormattedSymbol(param.symbol),
      ordId: param.orderId,
    });
  }
  private async _publicGet(
    endPoint: string,
    params: { [key: string]: string }
  ) {
    const response = await axios.get(this.baseUrl + endPoint, {
      params,
      timeout: 5000,
    });
    return response.data;
  }

  private async _privateGet(
    endPoint: string,
    params: { [key: string]: string }
  ): Promise<any> {
    const timestamp = new Date();

    const url =
      Object.keys(params).length === 0
        ? endPoint
        : endPoint + "?" + new URLSearchParams(params).toString();

    const headers = {
      "OK-ACCESS-KEY": this.apiInfo.apiKey,
      "OK-ACCESS-SIGN": this._getSignature(
        timestamp,
        url,
        "",
        this.apiInfo.secret,
        "GET"
      ),
      "OK-ACCESS-TIMESTAMP": timestamp.toISOString(),
      "OK-ACCESS-PASSPHRASE": this.apiInfo.password,
      "Content-Type": "application/json",
    };
    const response = await axios.get(
      this.baseUrl + endPoint + "?" + new URLSearchParams(params).toString(),
      {
        headers,
        timeout: 5000,
      }
    );
    return response.data;
  }

  private async _post(
    endPoint: string,
    params: { [key: string]: string }
  ): Promise<any> {
    const timestamp = new Date();

    const headers = {
      "OK-ACCESS-KEY": this.apiInfo.apiKey,
      "OK-ACCESS-SIGN": this._getSignature(
        timestamp,
        endPoint,
        JSON.stringify(params),
        this.apiInfo.secret,
        "POST"
      ),
      "OK-ACCESS-TIMESTAMP": timestamp.toISOString(),
      "OK-ACCESS-PASSPHRASE": this.apiInfo.password,
      "Content-Type": "application/json",
    };
    const response = await axios.post(this.baseUrl + endPoint, params, {
      headers,
      timeout: 5000,
    });
    return response.data;
  }
}
