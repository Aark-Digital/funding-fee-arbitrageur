import BigNumber from "bignumber.js";

export interface MarketStatus {
  accFundingFactor: string;
  fundingRate: string;
  openInterest: string;
  lastFundingRateUpdateTimestamp: string;
  depthFactor: string;
  oiSoftCap: string;
  oiHardCap: string;
}

function convertToBignumber(x: any): BigNumber {
  return new BigNumber(x.toString());
}
export function decodeMarketStatus(rawData: string): MarketStatus {
  return {
    accFundingFactor: convertToBignumber(rawData[0]).dividedBy(1e18).toFixed(),
    fundingRate: convertToBignumber(rawData[1]).dividedBy(1e18).toFixed(),
    openInterest: convertToBignumber(rawData[2]).dividedBy(1e10).toFixed(),
    lastFundingRateUpdateTimestamp: convertToBignumber(rawData[3]).toFixed(),
    depthFactor: convertToBignumber(rawData[4]).dividedBy(1e10).toFixed(),
    oiSoftCap: convertToBignumber(rawData[5]).dividedBy(1e10).toFixed(),
    oiHardCap: convertToBignumber(rawData[6]).dividedBy(1e10).toFixed(),
  };
}
