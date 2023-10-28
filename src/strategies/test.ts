import { ActionType, Side } from "../interfaces/order-interface";
import { BinanceService } from "../services/binance.service";
import { loadTargetMarketSymbols } from "../utils/env";
import { round_dp } from "../utils/number";

const binanceService = new BinanceService(
  process.env.BINANCE_API_KEY!,
  process.env.BINANCE_SECRET!,
  loadTargetMarketSymbols()
);

export async function strategy() {
  const symbol = "MATIC_USDT";
  await Promise.all([
    binanceService.fetchOrderbooks(),
    binanceService.fetchPositions(),
    binanceService.fetchOpenOrders(),
  ]);

  const marketInfo = binanceService.getMarketInfo();
  const maticInfo = marketInfo[symbol];
  if (maticInfo.orderbook === undefined || maticInfo.openOrders === undefined) {
    console.log("undefined matic info");
    return;
  }
  const maticMid =
    (maticInfo.orderbook.bids[0][0] + maticInfo.orderbook.asks[0][0]) / 2;

  const upperLimit = maticMid * 1.01;
  const lowerLimit = maticMid * 0.99;

  const actionParams = [];
  for (const openOrder of maticInfo.openOrders) {
    actionParams.push({
      symbol,
      order: {
        symbol,
        orderId: openOrder.orderId,
      },
      type: ActionType.Cancel,
    });
  }
  actionParams.push({
    symbol,
    order: {
      symbol,
      price: round_dp(upperLimit, 4),
      qty: 10,
      side: Side.Sell,
    },
    type: ActionType.CreateLimit,
  });
  actionParams.push({
    symbol,
    order: {
      symbol,
      price: round_dp(lowerLimit, 4),
      qty: 10,
      side: Side.Buy,
    },
    type: ActionType.CreateLimit,
  });

  await binanceService.executeOrders(actionParams);
}
