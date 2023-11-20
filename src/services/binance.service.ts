// import BigNumber from "bignumber.js";
// import ccxt, { Order, Exchange } from "ccxt";
// import { OrderBook, binanceusdm } from "ccxt";
// import { sleep } from "../utils/time";
// import { loadTargetMarketSymbols } from "../utils/env";
// import { IExchangeService } from "../class/exchange-class";
// import { IMarket } from "../interfaces/market-interface";
// import {
//   ActionType,
//   IActionParam,
//   ICancelOrderParam,
//   ILimitOrderParam,
//   IMarketOrderParam,
//   Side,
// } from "../interfaces/order-interface";
// import { Position } from "../interfaces/basic-interface";
// export class BinanceService {
//   private client: Exchange;
//   private symbolList: string[];
//   private marketInfo: { [symbol: string]: IMarket } = {};

//   constructor(apiKey: string, secret: string, symbolList: string[]) {
//     this.client = new ccxt.binanceusdm({
//       apiKey,
//       secret,
//     });
//     this.symbolList = symbolList;
//     this.symbolList.forEach((symbol) => {
//       this.marketInfo[symbol] = {
//         orderbook: undefined,
//         position: undefined,
//         openOrders: undefined,
//         balance: undefined,
//         marketInfo: { contractSize: 0, pricePrecision: 0, qtyPrecision: 0 },
//       };
//     });
//   }

//   async init() {
//     return;
//   }

//   getFormattedSymbol(symbol: string) {
//     const [base, quote] = symbol.split("_");
//     return `${base}/${quote}`;
//   }

//   getMarketInfo() {
//     return this.marketInfo;
//   }

//   async fetchOrderbooks() {
//     const orderbooks: { [symbol: string]: OrderBook | undefined } = {};
//     for (const symbol of this.symbolList) {
//       try {
//         const ob = await this.client.fetchOrderBook(
//           this.getFormattedSymbol(symbol)
//         );
//         this.marketInfo[symbol].orderbook = {
//           symbol,
//           bids: ob.bids,
//           asks: ob.asks,
//           timestamp: ob.timestamp,
//         };
//       } catch (e) {
//         console.log(`[ERROR] Failed to fetch ${symbol} orderbook : ${e}`);
//         this.marketInfo[symbol].orderbook = undefined;
//       }
//       await sleep(100);
//     }
//     return orderbooks;
//   }

//   async fetchPositions() {
//     try {
//       const result: { [symbol: string]: Position } = {};
//       const balances = await this.client.fetchBalance();

//       this.symbolList.forEach((symbol: string) => {
//         const fsymbol = symbol.replace("_", "");
//         const positionInfo = balances.info.positions.find(
//           (pos: any) => pos.symbol === fsymbol
//         );
//         if (positionInfo !== undefined) {
//           const size = Number(positionInfo.positionAmt);
//           this.marketInfo[symbol].position = {
//             symbol,
//             size,
//             timestamp: new Date().getTime(),
//           };
//         }
//       });
//       return result;
//     } catch (e) {
//       console.log(`[ERROR] Failed to fetch Balance & Position Info : ${e}`);
//       this.symbolList.forEach((symbol: string) => {
//         this.marketInfo[symbol].position = undefined;
//       });
//     }
//   }

//   async fetchOpenOrders(): Promise<void> {
//     for (const symbol of this.symbolList) {
//       try {
//         const oo = await this.client.fetchOpenOrders(
//           this.getFormattedSymbol(symbol)
//         );
//         this.marketInfo[symbol].openOrders = {
//           timestamp: new Date().getTime(),
//           openOrders: oo.map((openOrder: any) => ({
//             symbol,
//             orderId: openOrder.id,
//             price: openOrder.price,
//             size:
//               openOrder.side === "buy" ? openOrder.amount : -openOrder.amount,
//             remaining:
//               openOrder.side === "buy"
//                 ? openOrder.remaining
//                 : -openOrder.remaining,
//             timestamp: openOrder.timestamp,
//           })),
//         };
//       } catch (e) {
//         console.log(`[ERROR] Failed to fetch ${symbol} open orders : ${e}`);
//         this.marketInfo[symbol].openOrders = undefined;
//       }
//       await sleep(100);
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

//     await Promise.all(
//       cancelParams.map((param: ICancelOrderParam) =>
//         this.client.cancelOrder(
//           param.orderId,
//           this.getFormattedSymbol(param.symbol)
//         )
//       )
//     );
//     await Promise.all(
//       marketOrderParams.map((param: IMarketOrderParam) =>
//         this.client.createOrder(
//           this.getFormattedSymbol(param.symbol),
//           "market",
//           param.size > 0 ? "buy" : "sell",
//           Math.abs(param.size)
//         )
//       )
//     );
//     console.log(JSON.stringify(limitOrderParams, null, 2));
//     await Promise.all(
//       limitOrderParams.map((param: ILimitOrderParam) =>
//         this.client.createOrder(
//           this.getFormattedSymbol(param.symbol),
//           "limit",
//           param.size > 0 ? "buy" : "sell",
//           Math.abs(param.size),
//           param.price
//         )
//       )
//     );
//   }
// }
