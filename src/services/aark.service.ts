import { AlchemyProvider, ethers } from "ethers";
import BigNumber from "bignumber.js";
import { abi as ContractReader } from "../abis/ContractReader.json";
import { abi as PriceOracle } from "../abis/PriceOracle.json";
import { abi as FuturesManager } from "../abis/FuturesManager.json";
import { contractAddressMap } from "../constants/contract-address";

import { symbolIdMap } from "../constants/symbol-marketId";
import { loadTargetMarketSymbols } from "../utils/env";
import { OrderInfo } from "../interfaces/order-interface";
import { MarketStatus } from "../interfaces/market-interface";

export class AarkService {
  private contractReader: ethers.Contract;
  private futuresManager: ethers.Contract;
  private symbolList: string[];
  private signer: ethers.Wallet;
  private provider: AlchemyProvider = new ethers.AlchemyProvider(
    "arbitrum",
    process.env.ALCHEMY_API_KEY!
  );

  constructor(symbolList: string[]) {
    this.symbolList = symbolList;
    this.signer = new ethers.Wallet(process.env.SIGNER_PK!, this.provider);
    this.contractReader = new ethers.Contract(
      contractAddressMap["contractReader"],
      ContractReader,
      this.signer
    );
    this.futuresManager = new ethers.Contract(
      contractAddressMap["futuresManager"],
      FuturesManager,
      this.signer
    );
  }

  async fetchAll(): Promise<
    [
      { [symbol: string]: number },
      { [symbol: string]: number },
      { [symbol: string]: MarketStatus }
    ]
  > {
    const [indexPrices, positions, marketStatuses] = await Promise.all([
      this.fetchIndexPrices(),
      this.fetchPositions(),
      this.fetchMarketStatuses(),
    ]);

    return [indexPrices, positions, marketStatuses];
  }

  async fetchPositions(): Promise<{ [symbol: string]: number }> {
    const positionMap: { [symbol: string]: number } = {};
    const response = await this.contractReader.getUserFuturesStatus(
      this.signer.address
    );

    const positions = response[0].map((position: any) =>
      new BigNumber(position[0].toString()).dividedBy(1e10).toFixed()
    );

    this.symbolList.forEach((symbol: string) => {
      positionMap[symbol] = parseFloat(positions[symbolIdMap[symbol]]);
    });

    return positionMap;
  }

  async fetchIndexPrices(): Promise<{ [symbol: string]: number }> {
    const priceMap: { [symbol: string]: number } = {};
    const response = await this.contractReader.getPriceFeeds(
      this.symbolList.map((symbol: string) => symbolIdMap[symbol])
    );
    const prices = response.map((price: any) =>
      new BigNumber(price.toString()).dividedBy(1e8).toFixed()
    );
    this.symbolList.forEach((symbol: any, idx: number) => {
      priceMap[symbol] = prices[idx];
    });
    return priceMap;
  }

  async fetchMarketStatuses(): Promise<{ [symbol: string]: MarketStatus }> {
    const statusMap: { [symbol: string]: MarketStatus } = {};
    const response = await this.contractReader.getMarkets();
    this.symbolList.forEach((symbol: any) => {
      const rawData = response[symbolIdMap[symbol]];
      statusMap[symbol] = {
        skewness: Number(
          new BigNumber(rawData[2].toString()).dividedBy(1e10).toFixed()
        ),
        depthFactor: Number(
          new BigNumber(rawData[4].toString()).dividedBy(1e10).toFixed()
        ),
        oiHardCap: Number(
          new BigNumber(rawData[5].toString()).dividedBy(1e10).toFixed()
        ),
        oiSoftCap: Number(
          new BigNumber(rawData[6].toString()).dividedBy(1e10).toFixed()
        ),
      };
    });
    return statusMap;
  }

  async createOrders(orderInfo: { [symbol: string]: OrderInfo }) {
    return;
  }
}
