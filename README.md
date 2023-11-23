# funding-fee-arbitrageur

Premium &amp; Funding Fee Arb. Strategy

# Parameters Description

Every time-related value is in "ms" unit

```
// Strategy to run
STRATEGY=okxAarkArbitrage
// Strategy periods
STRATEGY_PERIOD_MS=10000

// Parameter for twilio monitoring
TWILIO_PARAM={"accountSid":"xxxxxxxxxx","authToken":"xxxxxxx","managerNumber":"xxxxx","twilioNumber":"xxxxx","url":"https://xxxxxxxxx"}
// Parameter for slack monitoring
SLACK_PARAM={"url":"https://hooks.slack.com/services/xxxxxxxxx","messageInterval":60000,"managerSlackId":"xxxxx"}

// Markets to arbitrage
TARGET_CRYPTO_LIST=[]
// EMA weight parameter, weight of new value will be 1 / EMA_WINDOW
EMA_WINDOW
// Base threshold for price difference ratio
BASE_PRICE_DIFF_THRESHOLD=0.0004
// MIN diff threshold from ema premium
MIN_PRICE_DIFF_THRESHOLD=0.0002
// Max position value in USDT for each market
MAX_POSITION_USDT=1000000
// Max order value in USDT for each order
MAX_ORDER_USDT=100000
// Min order value in USDT for each order.
MIN_ORDER_USDT=10000
// Min interval between adjacent order in each market, (to prevent fast,useless position swap)
MIN_ORDER_INTERVAL_MS=60000
// Unhedged value threshold in USDT for each market
UNHEDGED_THRESHOLD_USDT=10
// Multiplier for aarkFunding adjustment term when calculating enter threshold
AARK_FUNDING_MULTIPLIER=1
// Max allowed market skewnes value in USDT. Arbitrageur try to reduce each market's skewness under this value if possible.
MAX_MARKET_SKEWNESS_USDT=30000

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

// Select show table log or not
DEBUG_MODE=0
```
