import { Balance, OpenOrder, Orderbook, Position } from "./basic-interface";

export interface IMarketInfo {
  position: Position | undefined;
  orderbook: Orderbook | undefined;
  balance: Balance | undefined;
  openOrders: OpenOrder[] | undefined;
}

export interface IAarkMarketStatus {
  skewness: number;
  depthFactor: number;
  oiSoftCap: number;
  oiHardCap: number;
}

export interface IAarkMarketInfo extends IMarketInfo {
  indexPrice: number | undefined;
  marketStatus: IAarkMarketStatus | undefined;
}
