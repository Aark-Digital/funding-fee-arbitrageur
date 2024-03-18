export enum Side {
  Buy = "buy",
  Sell = "sell",
  Zero = "zero",
}

export enum OrderType {
  Limit = "Limit",
  Market = "Market",
}

export enum ActionType {
  CreateLimit = "CreateLimit",
  CreateMarket = "CreateMarket",
  Cancel = "Cancel",
}
export interface ILimitOrderParam {
  symbol: string;
  price: number;
  size: number;
}

export interface IMarketOrderParam {
  symbol: string;
  size: number;
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

export interface ITransferParam {
  currency: string;
  amount: number;
  toAddress: string;
  fee: number;
  chain: string;
}
