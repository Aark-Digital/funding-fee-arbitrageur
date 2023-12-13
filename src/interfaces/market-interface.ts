import {
  Balances,
  FundingRate,
  OpenOrders,
  Orderbook,
  Position,
} from "./basic-interface";

export interface IMarketInfo {
  contractSize: number;
  qtyPrecision: number;
  pricePrecision: number;
}
export interface IMarket {
  position: Position | undefined;
  orderbook: Orderbook | undefined;
  openOrders: OpenOrders | undefined;
  fundingRate: FundingRate | undefined;
  marketInfo: IMarketInfo;
}

export interface IAarkMarketStatus {
  skewness: number;
  depthFactor: number;
  oiSoftCap: number;
  oiHardCap: number;
  fundingRatePrice24h: number;
  targetLeverage: number;
  coefficient: number;
}

export interface IAarkMarket extends IMarket {
  indexPrice: number | undefined;
  marketStatus: IAarkMarketStatus | undefined;
}
