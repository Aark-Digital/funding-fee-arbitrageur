export interface MarketIndicator {
  crypto: string;
  // targetAarkPositionUSDTTheo: number;
  targetAarkPosition: number;
  expectedFundingRate: number;
  aarkFundingTerm: number;
  okxFundingTerm: number;
}
