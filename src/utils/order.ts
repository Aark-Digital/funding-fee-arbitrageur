import { OpenOrder, Position } from "../interfaces/basic-interface";
import { IMarketInfo } from "../interfaces/market-interface";
import {
  ActionType,
  ICancelOrderParam,
  ILimitOrderParam,
  IMarketOrderParam,
  Side,
} from "../interfaces/order-interface";
import { IActionParam } from "../interfaces/order-interface";
import {
  convertSizeToContractAmount,
  floor_dp,
  numberToPrecision,
} from "./number";

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

export function clampOrderSize(n: number, min: number, max: number) {
  if (min > max) {
    return 0;
  } else {
    return Math.min(Math.max(n, min), max);
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

export function applyQtyPrecision(
  orderSize: number,
  marketInfos: IMarketInfo[]
): number {
  let result = Math.abs(orderSize);
  let minQtyPrecision = 100;
  for (const marketInfo of marketInfos) {
    const qtyPrecision = marketInfo.qtyPrecision;
    const contractSizePrecision = numberToPrecision(marketInfo.contractSize);
    if (qtyPrecision + contractSizePrecision < minQtyPrecision) {
      minQtyPrecision = qtyPrecision + contractSizePrecision;
      result = floor_dp(result, minQtyPrecision); // Use floor instead round
    }
  }
  return orderSize > 0 ? result : -result;
}
