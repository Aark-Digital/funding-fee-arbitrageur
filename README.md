# funding-fee-arbitrageur

Premium &amp; Funding Fee Arb. Strategy

# Parameters Description

Every time-related value is in "ms" unit

```
// Strategy to run
STRATEGY_NAME=okxAarkArbitrageV3
// Strategy periods
STRATEGY_PERIOD_MS=10000

// Parameter for twilio monitoring
TWILIO_PARAM={"accountSid":"xxxxxxxxxx","authToken":"xxxxxxx","managerNumber":"xxxxx","twilioNumber":"xxxxx","url":"https://xxxxxxxxx"}
// Parameter for slack monitoring
SLACK_PARAM={"url":"https://hooks.slack.com/services/xxxxxxxxx","messageInterval":60000,"managerSlackId":"xxxxx"}

// Markets to arbitrage.
TARGET_CRYPTO_LIST=["XXX","YYY","ZZZ"]

// EMA window for calculating aark index price premium
EMA_WINDOW=3600
// Ratio of skewness to enter.
ENTER_SKEWNESS_RATIO=0.5
// Unhedged USDT value threshold for hedge logic activation
UNHEDGED_THRESHOLD_USDT=10
// Price diff ratio threshold to enter/exit position. Enter Aark long if (aark price) / (okx price) > 1 + (aark premium ema) + BASE_PRICE_DIFF_THRESHOLD, and vice versa
BASE_PRICE_DIFF_THRESHOLD=0.0002
// Funding fee threshold for closing position to dodge okx funding fee
OKX_FUNDING_RATE_DODGE_THRESHOLD=0.0005
// Aark funding fee threshold for opening position
OPEN_AARK_FUNDING_TERM_THRESHOLD=0.0004
// Aark funding fee threshold for closing position
CLOSE_AARK_FUNDING_TERM_THRESHOLD=0.0002

// Max leverage in both OKX and AARK
MAX_LEVERAGE=6
// Max order value
MAX_ORDER_USDT=10000
// Max absolute position value sum in OKX and AARK
MAX_TOTAL_POSITION_USDT=50000
// Max OKX orderbook slippage
MAX_ORDERBOOK_SLIPPAGE=0.001

// Min order value
MIN_ORDER_USDT=2000
// Min order interval in each market
MIN_ORDER_INTERVAL_MS=60000

// Initial balance value in USDT (OKX + AARK)
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
AARK_INDEX_PRICE_URL=https://xxxxx

```
