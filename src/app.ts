import ccxt, { Position } from "ccxt";
import { OrderBook } from "ccxt";
import { ethers } from "ethers";
import BigNumber from "bignumber.js";
import { contractAddresses } from "./constants/contract-address";
import { abi as ContractReader } from "./abis/ContractReader.json";
import { abi as PriceOracle } from "./abis/PriceOracle.json";
import { abi as FuturesManager } from "./abis/FuturesManager.json";
import { MarketStatus, decodeMarketStatus } from "./utils/decoder";
// FUCKING MATIC GUY
require("dotenv").config();

interface BinancePosition {
  symbol: string;
  positionAmt: string;
  notional: string;
}

interface AarkPosition {
  qty: number;
  lastFundingFactor: number;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const symbolIdMap: { [symbol: string]: string } = {
  ETH: "1",
  BTC: "2",
  BNB: "3",
  XRP: "4",
  MATIC: "5",
  ARB: "6",
  SOL: "7",
  USDT: "8",
  DOGE: "9",
  LINK: "10",
};

const provider = new ethers.AlchemyProvider(
  "arbitrum",
  process.env.ALCHEMY_API_KEY!
);
const client = new ccxt.binanceusdm({
  apiKey: process.env.BINANCE_API_KEY,
  secret: process.env.BINANCE_SECRET,
});

const signer = new ethers.Wallet(process.env.SIGNER_PK!, provider);
const priceOracleContract = new ethers.Contract(
  contractAddresses["priceOracle"],
  PriceOracle,
  signer
);
const contractReaderContract = new ethers.Contract(
  contractAddresses["contractReader"],
  ContractReader,
  signer
);
const futuresManagerContract = new ethers.Contract(
  contractAddresses["futuresManager"],
  FuturesManager,
  signer
);

const run = async () => {
  // Constants
  const symbol = process.env.TARGET_MARKET_SYMBOL!;
  const PRICE_DIFF_THRESHOLD = Number(process.env.PRICE_DIFF_THRESHOLD!);
  const MAX_POSITION_USDT = Number(process.env.MAX_POSITION_USDT!);
  const UNHEDGED_THRESHOLD = Number(process.env.UNHEDGED_THRESHOLD!);
  const MAX_ORDER_USDT = Number(process.env.MAX_ORDER_USDT!);
  const marketId = symbolIdMap[symbol];
  // Fetch Market Data
  const [
    aarkMarketIP,
    aarkMarketStatus,
    aarkMarketPosition,
    binanceOrderbook,
    usdcOrderbook,
    binancePosition,
  ]: [
    number,
    MarketStatus,
    AarkPosition,
    OrderBook,
    OrderBook,
    BinancePosition
  ] = await Promise.all([
    contractReaderContract
      .getPriceFeed(marketId)
      .then((price: any) =>
        Number(new BigNumber(price.toString()).dividedBy(1e8).toString())
      ),
    contractReaderContract
      .getMarket(marketId)
      .then((rawData: any) => decodeMarketStatus(rawData)),
    futuresManagerContract
      .positions(signer.address, marketId)
      .then((data: any) => ({
        qty: Number(
          new BigNumber(data[0].toString()).dividedBy(1e10).toString()
        ),
        lastFundingFactor: Number(
          new BigNumber(data[1].toString).dividedBy(1e18).toString()
        ),
      })),
    client.fetchOrderBook(`${symbol}/USDT`),
    client.fetchOrderBook(`USDC/USDT`),
    client
      .fetchBalance()
      .then(
        (response: any) =>
          response.info.positions.filter(
            (info: any) => info.symbol === `${symbol}USDT`
          )[0]
      ),
  ]);

  // console.log(binancePosition);
  const binancePositionQty = Number(binancePosition.positionAmt);
  const aarkPositionQty = Number(aarkMarketPosition.qty);

  const USDC_USDT_PRICE =
    (usdcOrderbook.bids[0][0] + usdcOrderbook.asks[0][0]) / 2;

  const [binanceMid, binanceAsk, binanceBid] = [
    (binanceOrderbook.asks[0][0] + binanceOrderbook.asks[0][0]) /
      2 /
      USDC_USDT_PRICE,
    binanceOrderbook.asks[0][0] / USDC_USDT_PRICE,
    binanceOrderbook.bids[0][0] / USDC_USDT_PRICE,
  ];
  const depthFactor = Number(aarkMarketStatus.depthFactor);
  const skewness = Number(aarkMarketStatus.openInterest);
  const aarkMarketMP = aarkMarketIP * (1 + skewness / depthFactor / 100);

  console.log(`
-------------- ${new Date().toISOString()} --------------
Depth Factor     : ${depthFactor.toFixed(6)}
Skewness         : ${skewness.toFixed(6)} 
Index Price      : ${aarkMarketIP.toFixed(6)}
Mark Price       : ${aarkMarketMP.toFixed(6)} 

Binance Bid Price : ${binanceBid.toFixed(6)}
Binance Ask Price : ${binanceAsk.toFixed(6)}

Aark Position    : ${aarkPositionQty.toFixed(6)}
Binance Position : ${binancePositionQty.toFixed(6)}

AARK / BINANCE   : ${(binanceMid / aarkMarketMP).toFixed(6)}
`);

  const unhedgedValue =
    Math.abs(aarkPositionQty - binancePositionQty) * binanceMid;
  if (unhedgedValue > UNHEDGED_THRESHOLD) {
    let absAmountToHedge = Math.min(
      Math.abs(aarkPositionQty - binancePositionQty),
      MAX_ORDER_USDT / binanceMid
    );
    let side = aarkPositionQty > binancePositionQty ? "buy" : "sell";
    console.log(
      `
!!!! UNHEDGED !!!!
Unhedged Value : $${unhedgedValue.toFixed(2)}
>> Hedge Position by ${side.toUpperCase() + "ING"} ${absAmountToHedge.toFixed(
        6
      )} ${symbol} in BINANCE`
    );

    await client.createOrder(
      `${symbol}/USDT`,
      "market",
      side,
      absAmountToHedge
    );
    return;
  }

  let amountInAark = 0;
  if (aarkMarketMP < binanceBid) {
    for (const [p, q] of binanceOrderbook.bids) {
      const deltaAmount = Math.min(
        q,
        2 *
          (100 *
            depthFactor *
            ((p * (1 - PRICE_DIFF_THRESHOLD)) / aarkMarketIP - 1) -
            skewness -
            amountInAark)
      );
      if (deltaAmount < 0) {
        break;
      }
      amountInAark += deltaAmount;
      if (deltaAmount !== q) {
        break;
      }
    }
  } else if (aarkMarketMP > binanceAsk) {
    for (const [p, q] of binanceOrderbook.asks) {
      const deltaAmount = Math.min(
        q,
        2 *
          (-100 *
            depthFactor *
            ((p * (1 + PRICE_DIFF_THRESHOLD)) / aarkMarketIP - 1) +
            skewness +
            amountInAark)
      );
      if (deltaAmount < 0) {
        break;
      }
      amountInAark -= deltaAmount;
      if (deltaAmount !== q) {
        break;
      }
    }
  }

  if (amountInAark > 0) {
    amountInAark = Math.min(
      (MAX_POSITION_USDT + Number(binancePosition.notional)) / binanceMid,
      Math.abs(amountInAark)
    );
    console.log(`
~~~~ ARBITRIGING ~~~~
BUY IN AARK, SELL IN BINANCE
AARK Mark Price      : ${aarkMarketMP.toFixed(6)}
Binance Bid Price    : ${binanceBid.toFixed(6)}
Price Ratio          : ${(binanceBid / aarkMarketMP - 1).toFixed(6)}
Order Amount in AARK : ${amountInAark.toFixed(6)}
    `);
    await Promise.all([
      client.createOrder(`${symbol}/USDT`, "market", "sell", amountInAark),
      orderAarkMarketOrder(marketId, "buy", amountInAark),
    ]);
  } else if (amountInAark < 0) {
    amountInAark = Math.min(
      (MAX_POSITION_USDT - Number(binancePosition.notional)) / binanceMid,
      Math.abs(amountInAark)
    );
    console.log(`
~~~~ ARBITRIGING ~~~~
BUY IN BINANCE, SELL IN AARK
AARK Mark Price      : ${aarkMarketMP.toFixed(6)}
Binance Ask Price    : ${binanceAsk.toFixed(6)}
Price Ratio          : ${(binanceAsk / aarkMarketMP - 1).toFixed(6)}
Order Amount in Aark : ${amountInAark.toFixed(6)}
    `);

    await Promise.all([
      client.createOrder(`${symbol}/USDT`, "market", "buy", amountInAark),
      orderAarkMarketOrder(marketId, "buy", -amountInAark),
    ]);
  }
};

async function main() {
  while (true) {
    await run();
    await sleep(5000);
  }
}
main().then(() => {
  console.log("Done!");
});

async function orderAarkMarketOrder(
  marketId: string,
  side: string,
  amount: number
) {
  // TODO!!
  return;
}
