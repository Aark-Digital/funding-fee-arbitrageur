import { IMarketInfo } from "../interfaces/market-interface";
import {
  IActionParam,
  ICancelOrderParam,
  ILimitOrderParam,
  IMarketOrderParam,
} from "../interfaces/order-interface";

export abstract class IExchangeService {
  symbolList: string[] = [];
  marketInfo: { [symbol: string]: IMarketInfo } = {};

  _notImplemented() {
    throw new Error("Not Implemented");
  }

  formatSymbol(symbol: string): string {
    return "";
  }

  async fetchAll() {
    await Promise.all([
      this.fetchBalance(),
      this.fetchPosition(),
      this.fetchOrderbook(),
      this.fetchOpenOrders(),
    ]);
  }

  async fetchPosition() {
    this._notImplemented();
  }

  async fetchBalance() {
    this._notImplemented();
  }

  async fetchOrderbook() {
    this._notImplemented();
  }

  async fetchOpenOrders() {
    this._notImplemented();
  }

  getMarketInfo() {
    return this.marketInfo;
  }

  async executeOrder(actionParams: IActionParam[]) {
    this._notImplemented();
  }

  async createOrder(
    createOrderParams: (ILimitOrderParam | IMarketOrderParam)[]
  ) {
    this._notImplemented();
  }

  async cancelOrder(canelOrderParams: ICancelOrderParam[]) {
    this._notImplemented();
  }
}
