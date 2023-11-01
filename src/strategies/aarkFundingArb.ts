import { Orderbook, Position } from "../interfaces/basic-interface";
import { IAarkMarketStatus } from "../interfaces/market-interface";
import { IActionParam } from "../interfaces/order-interface";
import { AarkService } from "../services/aark.service";
import { BinanceService } from "../services/binance.service";
import { loadTargetMarketSymbols } from "../utils/env";
import { formatNumber } from "../utils/number";
import { addCreateMarketParams, adjustOrderSize } from "../utils/order";
import { validateAndReturnData } from "../utils/validation";
import { table } from "table";

const binanceService = new BinanceService(
  process.env.BINANCE_API_KEY!,
  process.env.BINANCE_SECRET!,
  JSON.parse(process.env.TARGET_CRYPTO_LIST!)
    .map((symbol: string) => `${symbol}_USDT`)
    .concat(["USDC_USDT"])
);

const aarkService = new AarkService(
  JSON.parse(process.env.TARGET_CRYPTO_LIST!).map(
    (symbol: string) => `${symbol}_USDC`
  ),
  process.env.SIGNER_PK!,
  Number(process.env.OCT_DELEGATE_EPOCH),
  process.env.OCT_DELEGATE_SEED,
  Boolean(process.env.OCT_IS_DELEGATED)
);

const [
  PRICE_DIFF_THRESHOLD,
  MAX_POSITION_USDT,
  UNHEDGED_THRESHOLD,
  MAX_ORDER_USDT,
] = [
  process.env.PRICE_DIFF_THRESHOLD!,
  process.env.MAX_POSITION_USDT!,
  process.env.UNHEDGED_THRESHOLD!,
  process.env.MAX_ORDER_USDT!,
].map((param: string) => parseFloat(param));

export async function strategy() {
  const binanceActionParams: IActionParam[] = [];
  const aarkActionParams: IActionParam[] = [];
  await Promise.all([
    binanceService.fetchOpenOrders(),
    binanceService.fetchPositions(),
    binanceService.fetchOrderbooks(),
    aarkService.fetchIndexPrices(),
    aarkService.fetchPositions(),
    aarkService.fetchMarketStatuses(),
  ]);

  const binanceInfo = binanceService.getMarketInfo();
  const aarkInfo = aarkService.getMarketInfo();
  const cryptoList: string[] = JSON.parse(process.env.TARGET_CRYPTO_LIST!);

  const binanceUSDCInfo = binanceInfo[`USDC_USDT`].orderbook;
  if (binanceUSDCInfo === undefined) {
    throw new Error(`[Data Fetch Fail] Failed to fetch USDC market Info`);
  }
  const USDC_USDT_PRICE =
    (binanceUSDCInfo.asks[0][0] + binanceUSDCInfo.bids[0][0]) / 2;

  const arbitrageDetected: string[][] = [
    ["crypto", "price_bn", "price_a", "skewness", "aark Prem. (%)"],
  ];
  const unhedgedDetected: string[][] = [
    ["crypto", "pos_bn", "pos_a", "unhedged value ($)"],
  ];

  for (const crypto of cryptoList) {
    const binanceMarketInfo = binanceInfo[`${crypto}_USDT`];
    const aarkMarketInfo = aarkInfo[`${crypto}_USDC`];

    const [
      bnPosition,
      bnOrderbook,
      aarkPosition,
      aarkMarketStatus,
      aarkIndexPrice,
    ]: [Position, Orderbook, Position, IAarkMarketStatus, number] =
      validateAndReturnData(
        [
          binanceMarketInfo.position,
          binanceMarketInfo.orderbook,
          aarkMarketInfo.position,
          aarkMarketInfo.marketStatus,
          aarkMarketInfo.indexPrice,
        ],
        3000
      );

    const binanceMidUSDT =
      (bnOrderbook.asks[0][0] + bnOrderbook.asks[0][0]) / 2;

    const unhedgedSize = bnPosition.size + aarkPosition.size;
    if (Math.abs(unhedgedSize) * binanceMidUSDT > UNHEDGED_THRESHOLD) {
      const absAmountToHedge = Math.min(
        Math.abs(unhedgedSize),
        MAX_ORDER_USDT / binanceMidUSDT
      );
      addCreateMarketParams(binanceActionParams, [
        {
          symbol: `${crypto}_USDT`,
          size: unhedgedSize < 0 ? absAmountToHedge : -absAmountToHedge,
        },
      ]);
      unhedgedDetected.push([
        crypto,
        bnPosition.size.toPrecision(4),
        aarkPosition.size.toPrecision(4),
        (Math.abs(unhedgedSize) * binanceMidUSDT).toPrecision(4),
      ]);
      continue;
    }

    let orderSizeInAark = calcArbAmount(
      bnOrderbook,
      aarkMarketStatus,
      aarkIndexPrice,
      PRICE_DIFF_THRESHOLD,
      USDC_USDT_PRICE
    );
    if (orderSizeInAark !== 0) {
      const bnPrice = binanceMidUSDT / USDC_USDT_PRICE;
      const aPrice =
        aarkIndexPrice *
        (1 + aarkMarketStatus.skewness / aarkMarketStatus.depthFactor / 100);
      const aarkPremium = aPrice / bnPrice - 1;
      arbitrageDetected.push([
        crypto,
        bnPrice.toPrecision(7),
        aPrice.toPrecision(7),
        aarkMarketStatus.skewness.toPrecision(5),
        (aarkPremium * 100).toPrecision(4),
      ]);
    }

    orderSizeInAark = adjustOrderSize(
      aarkPosition,
      orderSizeInAark,
      MAX_POSITION_USDT / binanceMidUSDT,
      10 / binanceMidUSDT // Min order value of binance is typically $5. Set $10 to be more safe
    );

    if (orderSizeInAark !== 0) {
      addCreateMarketParams(binanceActionParams, [
        {
          symbol: `${crypto}_USDT`,
          size: -orderSizeInAark,
        },
      ]);
      addCreateMarketParams(aarkActionParams, [
        {
          symbol: `${crypto}_USDC`,
          size: orderSizeInAark,
        },
      ]);
    }
  }

  console.log("------ Unhedged Detected ------");
  console.log(table(unhedgedDetected));
  console.log("------ Arbitrage Detected ------");
  console.log(table(arbitrageDetected));

  // console.log(
  //   "------ Binance ------\n",
  //   JSON.stringify(binanceActionParams, null, 2)
  // );
  // console.log(
  //   "------ Aark ------\n",
  //   JSON.stringify(aarkActionParams, null, 2)
  // );

  // await Promise.all([
  //   binanceService.executeOrders(binanceActionParams),
  //   aarkService.executeOrders(aarkActionParams),
  // ]);
}

function calcArbAmount(
  bnOrderbook: Orderbook,
  aarkMarketStatus: IAarkMarketStatus,
  aarkIndexPrice: number,
  threshold: number,
  usdcPrice: number
): number {
  // Approximate avg. trade price of binance = last traded binance quote price

  const depthFactor = Number(aarkMarketStatus.depthFactor);
  const skewness = Number(aarkMarketStatus.skewness);

  // Aark Buy
  let orderSizeInAark = 0;
  for (const [p, q] of bnOrderbook.bids) {
    const deltaAmount = Math.min(
      q,
      2 *
        (100 *
          depthFactor *
          (((p / usdcPrice) * (1 - threshold)) / aarkIndexPrice - 1) -
          skewness) -
        orderSizeInAark
    );
    if (deltaAmount < 0) {
      break;
    }
    orderSizeInAark += deltaAmount;
    if (deltaAmount !== q) {
      break;
    }
  }

  if (orderSizeInAark > 0) {
    if (aarkMarketStatus.skewness < 0) {
      return orderSizeInAark;
    } else {
      return 0;
    }
  }

  // Aark Sell
  for (const [p, q] of bnOrderbook.asks) {
    const deltaAmount = Math.min(
      q,
      2 *
        (-100 *
          depthFactor *
          (((p / usdcPrice) * (1 + PRICE_DIFF_THRESHOLD)) / aarkIndexPrice -
            1) +
          skewness) +
        orderSizeInAark
    );
    if (deltaAmount < 0) {
      break;
    }
    orderSizeInAark -= deltaAmount;
    if (deltaAmount !== q) {
      break;
    }
  }

  if (orderSizeInAark < 0) {
    if (aarkMarketStatus.skewness > 0) {
      return orderSizeInAark;
    } else {
      return 0;
    }
  }

  return 0;
}
