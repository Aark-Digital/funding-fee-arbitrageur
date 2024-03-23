// import axios from "axios";
// import CryptoJS from "crypto-js";
// import { IMarket } from "../interfaces/market-interface";
// import {
//   ActionType,
//   IActionParam,
//   ICancelOrderParam,
//   ILimitOrderParam,
//   IMarketOrderParam,
// } from "../interfaces/order-interface";
// import {
//   ceil_dp,
//   convertSizeToContractAmount,
//   floor_dp,
//   numberToPrecision,
// } from "../utils/number";
// import { Balance, OpenOrders, Position } from "../interfaces/basic-interface";
// import { stream } from "tardis-dev";
// import AVLTree from "avl";
// import {
//   avlTreeToArray,
//   emptyAVLTree,
//   updateAVLTree,
// } from "../utils/orderbook";
// import { MonitorService } from "./monitor.service";
// import { sleep } from "../utils/time";

// export class BinanceSwapService {
//   private baseUrl: string = "https://fapi.binance.com";
//   private symbolList: string[];
//   private markets: { [symbol: string]: IMarket } = {};
//   private balances: undefined | Balance[];
//   private positions: undefined | Position[];
//   private openOrders: undefined | OpenOrders[];
//   private apiInfo: {
//     apiKey: string;
//     secret: string;
//   };
//   private avlOrderbooks: {
//     [symbol: string]: {
//       timestamp: number;
//       seqId: number;
//       asks: AVLTree<number, number>;
//       bids: AVLTree<number, number>;
//     };
//   } = {};
//   private orderbookAvailableTimestamp: number = 0;
//   private monitorService: MonitorService = MonitorService.getInstance();

//   constructor(apiKey: string, secret: string, symbolList: string[]) {
//     this.apiInfo = {
//       apiKey,
//       secret,
//     };
//     this.symbolList = symbolList;
//     this.symbolList.forEach((symbol) => {
//       this.markets[symbol] = {
//         orderbook: undefined,
//         fundingRate: undefined,
//         marketInfo: { contractSize: 0, pricePrecision: 0, qtyPrecision: 0 },
//       };
//     });
//     this.balances = undefined;
//     this.positions = undefined;
//     this.openOrders = undefined;
//   }

//   async init() {
//     this.initializeOrderbookStream();
//     const totalMarketInfo = await this._publicGet("/fapi/v1/exchangeInfo", {});
//     this.symbolList.forEach((symbol: string) => {
//       const targetSymbol = `${this.getFormattedSymbol(symbol)}`;
//       const marketInfo = totalMarketInfo.symbols.find(
//         (info: any) =>
//           info.symbol === targetSymbol && info.contractType === "PERPETUAL"
//       )!;
//       const priceFilter = marketInfo.filters.find(
//         (filter: any) => filter.filterType === "PRICE_FILTER"
//       );
//       const qtyFilter = marketInfo.filters.find(
//         (filter: any) => filter.filterType === "LOT_SIZE"
//       );
//       this.markets[symbol].marketInfo = {
//         contractSize: 1,
//         pricePrecision: numberToPrecision(Number(priceFilter.tickSize)),
//         qtyPrecision: numberToPrecision(Number(qtyFilter.stepSize)),
//       };
//     });

//     await sleep(5000);
//   }

//   private async initializeOrderbookStream() {
//     while (1) {
//       await this._initializeOrderbookStream(Date.now());
//     }
//   }

//   private async _initializeOrderbookStream(ts: number) {
//     this.monitorService.slackMessage(
//       "INITIALIZE ORDERBOOK STREAM",
//       "",
//       60_000,
//       false,
//       false
//     );
//     console.log(`INITIALIZE ORDERBOK STREAM at ${new Date(ts).toISOString()}`);
//     const messages = stream({
//       exchange: "okex-swap",
//       filters: [
//         {
//           channel: "books",
//           symbols: this.symbolList.map(
//             (symbol: string) => `${this.getFormattedSymbol(symbol)}`
//           ),
//         } as any,
//       ],
//     });
//     for await (const messageResponse of messages) {
//       if (messageResponse.message.action === undefined) {
//         continue;
//       }
//       const message = messageResponse.message;
//       if (message.action === "snapshot") {
//         const asks = emptyAVLTree(true);
//         const bids = emptyAVLTree(false);
//         for (const ask of message.data[0].asks) {
//           asks.insert(Number(ask[0]), Number(ask[1]));
//         }
//         for (const bid of message.data[0].bids) {
//           bids.insert(Number(bid[0]), Number(bid[1]));
//         }
//         this.avlOrderbooks[message.arg.instId] = {
//           timestamp: new Date(message.localTimestamp).getTime(),
//           asks,
//           bids,
//           seqId: message.data[0].seqId,
//         };
//       } else if (message.action === "update") {
//         const orderbook = this.avlOrderbooks[message.arg.instId];
//         const asks = orderbook.asks;
//         const bids = orderbook.bids;
//         const data = message.data[0];
//         if (data.prevSeqId != orderbook.seqId) {
//           this.monitorService.slackMessage(
//             "OKX ORDERBOOK ERROR",
//             `(${message.arg.instId}) Sequence Skipped : ${data.prevSeqId}, ${orderbook.seqId}`,
//             10_000,
//             true,
//             true
//           );
//         }
//         updateAVLTree(
//           asks,
//           data.asks.map((quote: string[]) => [
//             Number(quote[0]),
//             Number(quote[1]),
//           ])
//         );
//         updateAVLTree(
//           bids,
//           data.bids.map((quote: string[]) => [
//             Number(quote[0]),
//             Number(quote[1]),
//           ])
//         );
//         orderbook.timestamp = Number(data.ts);
//         orderbook.seqId = data.seqId;
//       }
//       const currentTimestamp = Date.now();
//       if (currentTimestamp - ts > 1_800_000) {
//         this.orderbookAvailableTimestamp = currentTimestamp + 10_000;
//         break;
//       }
//     }
//   }

//   getFormattedSymbol(symbol: string) {
//     const [base, quote] = symbol.split("_");
//     return `${base}${quote}`;
//   }

//   getMarketInfo() {
//     return this.markets;
//   }

//   getBalance() {
//     return this.balances;
//   }

//   isOrderbookAvailable(ts: number) {
//     return this.orderbookAvailableTimestamp < ts;
//   }

//   async fetchOrderbooks() {
//     try {
//       this.symbolList.forEach((symbol: string, idx: number) => {
//         const orderbook = this.avlOrderbooks[this.getFormattedSymbol(symbol)];
//         const asks = orderbook.asks;
//         const bids = orderbook.bids;
//         const timestamp = orderbook.timestamp;
//         this.markets[symbol].orderbook = {
//           symbol: symbol,
//           bids: avlTreeToArray(bids),
//           asks: avlTreeToArray(asks),
//           timestamp: timestamp,
//         };
//       });
//     } catch (e) {
//       console.log(`[ERROR] Failed to fetch orderbooks : ${e}`);
//       for (const symbol of this.symbolList) {
//         this.markets[symbol].orderbook = undefined;
//       }
//     }
//   }

//   // ONLY CROSS MARGIN IS AVAILABLE
//   async fetchPositions() {
//     const timestamp = new Date().getTime();
//     try {
//       const totalChunksNumber = Math.floor((this.symbolList.length + 9) / 10);
//       const symbolChunks = Array.from(
//         new Array(totalChunksNumber),
//         (_, i: number) =>
//           this.symbolList.filter(
//             (_: any, j: number) => Math.floor(j / 10) === i
//           )
//       );
//       const positionResponses = await Promise.all(
//         symbolChunks.map((chunk: string[]) =>
//           this._privateGet("/api/v5/account/positions", {
//             instType: "SWAP",
//             instId: chunk.map(this.getFormattedSymbol).join(","),
//           }).then((response: any) => response.data)
//         )
//       );
//       const positions = positionResponses.reduce(
//         (acc: any[], positionResponse: any) => acc.concat(positionResponse),
//         []
//       );
//       const newPositions: Position[] = [];
//       this.symbolList.forEach((symbol: string, idx: number) => {
//         const contractSize = this.markets[symbol].marketInfo.contractSize;
//         const position = positions.find(
//           (pos: any) =>
//             pos.mgnMode === "cross" &&
//             pos.instId === this.getFormattedSymbol(symbol)
//         );
//         if (position === undefined) {
//           console.log(
//             `No previous trade in ${this.getFormattedSymbol(symbol)}.`
//           );
//           newPositions.push({
//             symbol,
//             timestamp,
//             size: 0,
//             price: 0,
//           });
//         } else {
//           newPositions.push({
//             symbol,
//             size: Number(position.pos) * contractSize,
//             price: Number(position.avgPx),
//             timestamp,
//           });
//         }
//       });
//     } catch (e) {
//       console.log(`[ERROR] Failed to fetch positions : ${e}`);
//       this.positions = undefined;
//     }
//   }

//   async fetchOpenOrders(): Promise<void> {
//     const timestamp = new Date().getTime();
//     try {
//       const openOrders = await this._privateGet(
//         "/api/v5/trade/orders-pending",
//         {
//           instType: "SWAP",
//         }
//       );
//       const newOpenOrders: OpenOrders[] = [];
//       this.symbolList.forEach((symbol: string) => {
//         const marketOpenOrders = openOrders.data.filter(
//           (oo: any) => oo.instId === this.getFormattedSymbol(symbol)
//         );
//         newOpenOrders.push({
//           openOrders: marketOpenOrders.map((oo: any) => ({
//             timestamp,
//             symbol,
//             orderId: oo.ordId,
//             price: Number(oo.px),
//             size: oo.side === "buy" ? Number(oo.sz) : -Number(oo.sz),
//             remaining: Number(oo.fillSz),
//           })),
//           timestamp,
//         });
//       });
//     } catch (e) {
//       console.log(`[ERROR] Failed to fetch open orders : ${e}`);
//       this.openOrders = undefined;
//     }
//   }

//   async fetchBalances(): Promise<void> {
//     const timestamp = new Date().getTime();
//     try {
//       const balances = await this._privateGet("/api/v5/account/balance", {});
//       this.balances = balances.data[0].details.map((balance: any) => ({
//         timestamp,
//         currency: balance.ccy,
//         total: Number(balance.eq),
//         available: Number(balance.availEq),
//       }));
//     } catch (e) {
//       console.log(`[ERROR] Failed to fetch balances : ${e}`);
//       this.balances = undefined;
//     }
//   }

//   async fetchFundingRate(): Promise<void> {
//     const timestamp = new Date().getTime();
//     try {
//       const fundingRates: any[] = await Promise.all(
//         this.symbolList.map((symbol: string) =>
//           this._publicGet("/api/v5/public/funding-rate", {
//             instId: this.getFormattedSymbol(symbol),
//           })
//         )
//       );
//       this.symbolList.forEach((symbol: string, idx: number) => {
//         const fr = fundingRates[idx].data[0];
//         this.markets[symbol].fundingRate = {
//           timestamp,
//           symbol,
//           fundingRate: Number(fr.fundingRate),
//           fundingTime: Number(fr.fundingTime),
//         };
//       });
//     } catch (e) {
//       console.log(`[ERROR] Failed to fetch funding rates : ${e}`);
//       for (const symbol of this.symbolList) {
//         this.markets[symbol].fundingRate = undefined;
//       }
//     }
//   }

//   async fetchAccountInfo(): Promise<void> {
//     const timestamp = new Date().getTime();
//     try {
//       const accountInfo: any = await Promise.all(
//         this.symbolList.map((symbol: string) =>
//           this._publicGet("/fapi/v2/account", {})
//         )
//       );
//       this.balances = (accountInfo.assets as any[]).map((assetInfo: any) => ({
//         currency: assetInfo.asset,
//         total: Number(assetInfo.walletBalance),
//         available: Number(assetInfo.maxWithdrawAmount),
//         timestamp,
//       }));
//       const newPositions: Position[] = [];
//       this.symbolList.forEach((symbol: string) => {
//         const targetSymbol = this.getFormattedSymbol(symbol);
//         const position = accountInfo.positions.find(
//           (position: any) => position.symbol === targetSymbol
//         );
//         newPositions.push({
//           symbol,
//           timestamp,
//           price: Number(position.entryPrice),
//           size: Number(position.positionAmt),
//         });
//       });
//     } catch (e) {
//       console.log(`[ERROR] Failed to fetch account info : ${e}`);
//       this.balances = undefined;
//       this.positions = undefined;
//       for (const symbol of this.symbolList) {
//         this.markets[symbol].fundingRate = undefined;
//       }
//     }
//   }

//   // TODO: Is there better way to do this??
//   async executeOrders(actionParams: IActionParam[]) {
//     const cancelParams = actionParams
//       .filter((param: IActionParam) => param.type === ActionType.Cancel)
//       .map((param: IActionParam) => param.order) as ICancelOrderParam[];
//     const marketOrderParams = actionParams
//       .filter((param: IActionParam) => param.type === ActionType.CreateMarket)
//       .map((param: IActionParam) => param.order) as IMarketOrderParam[];
//     const limitOrderParams = actionParams
//       .filter((param: IActionParam) => param.type === ActionType.CreateLimit)
//       .map((param: IActionParam) => param.order) as ILimitOrderParam[];

//     await Promise.all(cancelParams.map((param) => this._cancelOrder(param)));
//     await Promise.all(
//       marketOrderParams.map((param) => this._createMarketOrder(param))
//     );
//     await Promise.all(
//       limitOrderParams.map((param) => this._createLimitOrder(param))
//     );
//   }

//   private async _createMarketOrder(param: IMarketOrderParam) {
//     return this._post("/fapi/v1/order", {
//       symbol: this.getFormattedSymbol(param.symbol),
//       side: param.size > 0 ? "BUY" : "SELL",
//       type: "MARKET",
//       quantity: Math.abs(param.size).toString(),
//       timestamp: Date.now().toString(),
//     });
//   }

//   private async _createLimitOrder(param: ILimitOrderParam) {
//     return this._post("/fapi/v1/order", {
//       symbol: this.getFormattedSymbol(param.symbol),
//       side: param.size > 0 ? "BUY" : "SELL",
//       type: "LIMIT",
//       quantity: Math.abs(param.size).toString(),
//       price: param.price.toString(),
//       timeinforce: "GTC",
//       timestamp: Date.now().toString(),
//     });
//   }

//   private async _cancelOrder(param: ICancelOrderParam) {
//     return this._delete("/fapi/v1/order", {
//       symbol: this.getFormattedSymbol(param.symbol),
//       orderId: param.orderId,
//       timestamp: Date.now().toString(),
//     });
//   }

//   _getSignatureFromParams(
//     params: { [key: string]: string },
//     secret: string
//   ): string {
//     return CryptoJS.HmacSHA256(
//       CryptoJS.enc.Utf8.parse(new URLSearchParams(params).toString()),
//       CryptoJS.enc.Utf8.parse(secret)
//     ).toString(CryptoJS.enc.Hex);
//   }

//   private async _publicGet(
//     endPoint: string,
//     params: { [key: string]: string }
//   ): Promise<any> {
//     const queryString = new URLSearchParams(params).toString();
//     const url =
//       this.baseUrl +
//       (Object.keys(params).length === 0
//         ? endPoint
//         : endPoint + "?" + queryString);

//     // Public Request
//     const response = await axios.get(url, { timeout: 5000 });
//     return response.data;
//   }

//   private async _privateGet(
//     endPoint: string,
//     params: { [key: string]: string }
//   ): Promise<any> {
//     const paramsWithSignature = Object.assign(params, {
//       signature: this._getSignatureFromParams(
//         params,
//         process.env.BINANCE_SECRET!
//       ),
//     });
//     const queryString = new URLSearchParams(paramsWithSignature).toString();
//     const url =
//       this.baseUrl +
//       (Object.keys(params).length === 0
//         ? endPoint
//         : endPoint + "?" + queryString);
//     const response = await axios.get(url, {
//       headers: {
//         "X-MBX-APIKEY": process.env.BINANCE_API_KEY!,
//       },
//       timeout: 5000,
//     });

//     return response;
//   }

//   private async _post(
//     endPoint: string,
//     params: { [key: string]: string }
//   ): Promise<any> {
//     const paramsWithSignature = Object.assign(params, {
//       signature: this._getSignatureFromParams(
//         params,
//         process.env.BINANCE_SECRET!
//       ),
//     });
//     const url = this.baseUrl + endPoint;
//     console.log(url);
//     console.log(paramsWithSignature);
//     const response = await axios.post(this.baseUrl + endPoint, null, {
//       headers: {
//         "X-MBX-APIKEY": process.env.BINANCE_API_KEY!,
//       },
//       params: paramsWithSignature,
//       timeout: 5000,
//     });
//     return response.data;
//   }

//   private async _delete(endPoint: string, params: { [key: string]: string }) {
//     const paramsWithSignature = Object.assign(params, {
//       signature: this._getSignatureFromParams(
//         params,
//         process.env.BINANCE_SECRET!
//       ),
//     });
//     const url = this.baseUrl + endPoint;
//     console.log(url);
//     console.log(paramsWithSignature);
//     const response = await axios.delete(this.baseUrl + endPoint, {
//       headers: {
//         "X-MBX-APIKEY": process.env.BINANCE_API_KEY!,
//       },
//       params: paramsWithSignature,
//       timeout: 5000,
//     });
//     return response.data;
//   }
// }
