import { Side } from "./order-interface";

export interface Position {
  timestamp: number;
  symbol: string;
  qty: number;
  side: Side;
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
  balance: number;
}

export interface OpenOrder {
  timestamp: number;
  symbol: string;
  orderId: string;
  price: number;
  qty: number;
  side: Side;
  remaining: number;
}
