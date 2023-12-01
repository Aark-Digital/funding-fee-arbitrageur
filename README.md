# funding-fee-arbitrageur

Premium &amp; Funding Fee Arb. Strategy

# Parameters Description

Every time-related value is in "ms" unit

```
// Strategy to run
STRATEGY_NAME=okxAarkArbitrage
// Strategy periods
STRATEGY_PERIOD_MS=10000

// Parameter for twilio monitoring
TWILIO_PARAM={"accountSid":"xxxxxxxxxx","authToken":"xxxxxxx","managerNumber":"xxxxx","twilioNumber":"xxxxx","url":"https://xxxxxxxxx"}
// Parameter for slack monitoring
SLACK_PARAM={"url":"https://hooks.slack.com/services/xxxxxxxxx","messageInterval":60000,"managerSlackId":"xxxxx"}

// Markets to arbitrage. Use marketConfig.ts to stringify parameter
MARKET_PARAMS : {
    "BTC" : {
        // EMA weight parameter, weight of new value will be 1 / EMA_WINDOW
        EMA_WINDOW
        // Base threshold for price difference ratio
        BASE_PRICE_DIFF_THRESHOLD=0.0004
        // MIN diff threshold from ema premium
        MIN_PRICE_DIFF_THRESHOLD=0.0002
        // Max position value in USDT for market
        MAX_POSITION_USDT=1000000
        // Max order value in USDT for order
        MAX_ORDER_USDT=100000
        // Min order value in USDT for order.
        MIN_ORDER_USDT=10000
        // Min interval between adjacent order in market, (to prevent fast,useless position swap)
        MIN_ORDER_INTERVAL_MS=60000
        // Unhedged value threshold in USDT for market
        UNHEDGED_THRESHOLD_USDT=10
        // Multiplier for aarkFunding adjustment term when calculating enter threshold
        AARK_FUNDING_MULTIPLIER=1
        // Max allowed market skewnes value in USDT. Arbitrageur try to reduce each market's skewness under this value if possible.
        MAX_MARKET_SKEWNESS_USDT=30000
    },
    "ETH": {
        ...
    }
}


// Initial balance value in USDT in both market
INITIAL_BALANCE_USDT=10000
// Initial balance value ratio in OKX
BALANCE_RATIO_IN_OKX=0.5
// Initial balance value ratio in AARK
BALANCE_RATIO_IN_AARK=0.5
// Threshold for difference between initial & current balance value ratio.
BALANCE_RATIO_DIFF_THRESHOLD=0.2

// Max elapsed to time for fetching data.
DATA_FETCH_TIME_THRESHOLD_MS=1000

// URL for making order in aark via One Click Trading
OCT_BACKEND_URL=https://xxxxx
// URL that provides aark index price
AARK_INDEX_PRICE_URL=https://xxxxxxx

```

# marketConfig.ts

To generate MARKET_PARAMS, Run below script and then Copy & Paste string 'MARKET_PARAMS string'section to .env

```
import { checkObjectKeys } from "src/utils/env";

const TARGET_MARKET_CONFIG = {
  ETH: {
    EMA_WINDOW: 1,
    BASE_PRICE_DIFF_THRESHOLD: 0.01,
    MIN_PRICE_DIFF_THRESHOLD: 0.005,
    MAX_POSITION_USDT: 10000,
    MAX_ORDER_USDT: 20000,
    MIN_ORDER_USDT: 5000,
    MIN_ORDER_INTERVAL_MS: 60000,
    UNHEDGED_THRESHOLD_USDT: 10,
    AARK_FUNDING_MULTIPLIER: 0.5,
    MAX_MARKET_SKEWNESS_USDT: 50000,
  },
  // ...And add more market configs here
};

if (
  !checkObjectKeys(Object.values(TARGET_MARKET_CONFIG), [
    "EMA_WINDOW",
    "BASE_PRICE_DIFF_THRESHOLD",
    "MIN_PRICE_DIFF_THRESHOLD",
    "MAX_POSITION_USDT",
    "MAX_ORDER_USDT",
    "MIN_ORDER_USDT",
    "MIN_ORDER_INTERVAL_MS",
    "UNHEDGED_THRESHOLD_USDT",
    "AARK_FUNDING_MULTIPLIER",
    "MAX_MARKET_SKEWNESS_USDT",
  ])
) {
  throw new Error("Object key test failed");
}
console.log('---------- MARKET_PARAMS string ----------')
console.log(JSON.stringify(TARGET_MARKET_CONFIG));
console.log('------------------------------------------')
console.log(
  `Selected markets : ${Object.keys(TARGET_MARKET_CONFIG).join(",")}`
);

```
