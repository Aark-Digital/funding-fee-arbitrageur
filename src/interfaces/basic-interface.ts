import { Side } from "./order-interface";

export interface Position {
  timestamp: number;
  symbol: string;
  price: number;
  size: number;
}

export interface Orderbook {
  timestamp: number;
  symbol: string;
  bids: [number, number][];
  asks: [number, number][];
}

export interface Balance {
  timestamp: number;
  currency: string;
  total: number;
  available: number;
  weight?: number;
}

export interface Balances {
  balances: Balance[];
  timestamp: number;
}

export interface OpenOrder {
  timestamp: number;
  symbol: string;
  orderId: string;
  price: number;
  size: number;
  remaining: number;
}

export interface OpenOrders {
  openOrders: OpenOrder[];
  timestamp: number;
}

export interface FundingRate {
  timestamp: number;
  symbol: string;
  fundingRate: number;
  fundingTime: number;
}
