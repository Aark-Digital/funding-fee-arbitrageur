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

export class OkxSwapService {
  private baseUrl: string = "https://www.okx.com";
  private symbolList: string[];
  private markets: { [symbol: string]: IMarket } = {};
  private apiInfo: {
    apiKey: string;
    secret: string;
    password: string;
  };

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
        balance: undefined,
        marketInfo: { contractSize: 0, pricePrecision: 0, qtyPrecision: 0 },
      };
    });
  }

  async init() {
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

  async fetchOrderbooks() {
    try {
      const orderbooks: any[] = await Promise.all(
        this.symbolList.map((symbol: string) =>
          this._publicGet("/api/v5/market/books", {
            instId: this.getFormattedSymbol(symbol),
            sz: "100",
          })
        )
      );

      this.symbolList.forEach((symbol: string, idx: number) => {
        const ob = orderbooks[idx].data[0];
        this.markets[symbol].orderbook = {
          symbol: symbol,
          bids: ob.bids.map((bid: any) => [Number(bid[0]), Number(bid[1])]),
          asks: ob.bids.map((ask: any) => [Number(ask[0]), Number(ask[1])]),
          timestamp: Number(ob.ts),
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
      const positions = await this._privateGet("/api/v5/account/positions", {
        instType: "SWAP",
        instId: this.symbolList.map(this.getFormattedSymbol).join(","),
      });
      this.symbolList.forEach((symbol: string, idx: number) => {
        const contractSize = this.markets[symbol].marketInfo.contractSize;
        const position = positions.data.find(
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
          };
        } else {
          this.markets[symbol].position = {
            symbol,
            size: Number(position.pos) * contractSize,
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
    });
    return response.data;
  }

  private async _privateGet(
    endPoint: string,
    params: { [key: string]: string }
  ): Promise<any> {
    const timestamp = new Date();

    const headers = {
      "OK-ACCESS-KEY": this.apiInfo.apiKey,
      "OK-ACCESS-SIGN": this._getSignature(
        timestamp,
        endPoint + "?" + new URLSearchParams(params).toString(),
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
    });
    return response.data;
  }
}
