import { Balance, OpenOrders, Orderbook, Position } from "./basic-interface";

export interface IMarketInfo {
  contractSize: number;
  qtyPrecision: number;
  pricePrecision: number;
}
export interface IMarket {
  position: Position | undefined;
  orderbook: Orderbook | undefined;
  balance: Balance | undefined;
  openOrders: OpenOrders | undefined;
  marketInfo: IMarketInfo;
}

export interface IAarkMarketStatus {
  skewness: number;
  depthFactor: number;
  oiSoftCap: number;
  oiHardCap: number;
  fundingRatePrice24h: number;
}

export interface IAarkMarket extends IMarket {
  indexPrice: number | undefined;
  marketStatus: IAarkMarketStatus | undefined;
}
