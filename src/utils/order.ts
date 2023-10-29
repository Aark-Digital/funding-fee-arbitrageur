import { OpenOrder, Position } from "../interfaces/basic-interface";
import {
  ActionType,
  ICancelOrderParam,
  ILimitOrderParam,
  IMarketOrderParam,
  Side,
} from "../interfaces/order-interface";
import { IActionParam } from "../interfaces/order-interface";

export function addCreateLimitParams(
  actionParams: IActionParam[],
  limitOrderParams: ILimitOrderParam[]
) {
  limitOrderParams.forEach((param: ILimitOrderParam) => {
    actionParams.push({
      symbol: param.symbol,
      order: param,
      type: ActionType.CreateLimit,
    });
  });
}

export function addCreateMarketParams(
  actionParams: IActionParam[],
  marketOrderParams: IMarketOrderParam[]
) {
  marketOrderParams.forEach((param: IMarketOrderParam) => {
    actionParams.push({
      symbol: param.symbol,
      order: param,
      type: ActionType.CreateMarket,
    });
  });
}

export function addCancelParams(
  actionParams: IActionParam[],
  cancelParams: ICancelOrderParam[]
) {
  cancelParams.forEach((param: ICancelOrderParam) => {
    actionParams.push({
      symbol: param.symbol,
      order: param,
      type: ActionType.Cancel,
    });
  });
}

export function getActionParamsFromTargetOrder(
  openOrders: OpenOrder[],
  targetOrders: ILimitOrderParam[]
) {
  const cancelParams: ICancelOrderParam[] = [];
  const limitOrderParams: ILimitOrderParam[] = [];
  for (const openOrder of openOrders) {
    let isTarget = false;
    for (const targetOrder of targetOrders) {
      if (
        // Check if target order have same price and same sign
        openOrder.price == targetOrder.price &&
        openOrder.size * targetOrder.size > 0
      ) {
        isTarget = true;
        break;
      }
    }
    if (!isTarget) {
      cancelParams.push({
        symbol: openOrder.symbol,
        orderId: openOrder.orderId,
      });
    }
  }

  for (const targetOrder of targetOrders) {
    let isExists = false;
    for (const openOrder of openOrders) {
      if (
        openOrder.price == targetOrder.price &&
        openOrder.size * targetOrder.size > 0
      ) {
        isExists = true;
        break;
      }
    }
    if (!isExists) {
      limitOrderParams.push(targetOrder);
    }
  }
}

export function adjustOrderSize(
  position: Position,
  orderSize: number,
  maxPosQty: number,
  minOrderQty: number = 0
) {
  let size;
  if (orderSize > 0) {
    size = Math.min(maxPosQty - position.size, orderSize);
  } else {
    size = Math.max(-maxPosQty - position.size, orderSize);
  }
  return Math.abs(size) < minOrderQty ? 0 : size;
}
