export enum Side {
  Buy = "buy",
  Sell = "sell",
  Zero = "zero",
}

export enum OrderType {
  Limit,
  Market,
}

export enum ActionType {
  CreateLimit,
  CreateMarket,
  Cancel,
}
export interface ILimitOrderParam {
  symbol: string;
  price: number;
  qty: number;
  side: Side;
}

export interface IMarketOrderParam {
  symbol: string;
  qty: number;
  side: Side;
}

export interface ICancelOrderParam {
  symbol: string;
  orderId: string;
}

export interface IActionParam {
  symbol: string;
  order: ILimitOrderParam | IMarketOrderParam | ICancelOrderParam;
  type: ActionType;
}
