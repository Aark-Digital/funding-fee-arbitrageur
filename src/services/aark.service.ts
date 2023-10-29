import { AlchemyProvider, ethers } from "ethers";
import BigNumber from "bignumber.js";
import { abi as ContractReader } from "../abis/ContractReader.json";
import { abi as PriceOracle } from "../abis/PriceOracle.json";
import { abi as FuturesManager } from "../abis/FuturesManager.json";
import { contractAddressMap } from "../constants/contract-address";
import { loadTargetMarketSymbols } from "../utils/env";
import { IAarkMarketInfo } from "../interfaces/market-interface";
import { IActionParam, Side } from "../interfaces/order-interface";

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

export class AarkService {
  private contractReader: ethers.Contract;
  private futuresManager: ethers.Contract;
  private symbolList: string[];
  private marketInfo: { [symbol: string]: IAarkMarketInfo } = {};
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
    this.symbolList.forEach((symbol) => {
      this.marketInfo[symbol] = {
        orderbook: undefined,
        position: undefined,
        openOrders: undefined,
        balance: undefined,
        indexPrice: undefined,
        marketStatus: undefined,
      };
    });
  }

  getFormattedSymbol(symbol: string) {
    const [base, quote] = symbol.split("_");
    return `${base}`;
  }

  getMarketInfo() {
    return this.marketInfo;
  }

  async fetchOrderbooks() {
    throw new Error("Not Implemented");
  }

  async fetchOpenOrders() {
    throw new Error("Not Implemented");
  }

  async fetchPositions() {
    try {
      const timestamp = new Date().getTime();
      const response = await this.contractReader.getUserFuturesStatus(
        this.signer.address
      );

      const positions = response[0].map((position: any) =>
        new BigNumber(position[0].toString()).dividedBy(1e10).toFixed()
      );

      this.symbolList.forEach((symbol: string) => {
        const size = Number(
          positions[symbolIdMap[this.getFormattedSymbol(symbol)]]
        );
        this.marketInfo[symbol].position = {
          symbol,
          timestamp,
          size,
        };
      });
    } catch {
      console.log(`[Aark Service] Failed to fetch Positions`);
      this.symbolList.forEach((symbol: string) => {
        this.marketInfo[symbol].position = undefined;
      });
    }
  }

  async fetchIndexPrices() {
    try {
      const response = await this.contractReader.getPriceFeeds(
        this.symbolList.map(
          (symbol: string) => symbolIdMap[this.getFormattedSymbol(symbol)]
        )
      );
      const prices = response.map((price: any) =>
        Number(new BigNumber(price.toString()).dividedBy(1e8).toFixed())
      );

      this.symbolList.forEach((symbol: any, idx: number) => {
        this.marketInfo[symbol].indexPrice = prices[idx];
      });
    } catch (e) {
      console.log(`[Aark Service] Failed to fetch index prices: ${e}`);
      this.symbolList.forEach((symbol: string) => {
        this.marketInfo[symbol].indexPrice = undefined;
      });
    }
  }

  async fetchMarketStatuses() {
    try {
      const response = await this.contractReader.getMarkets();
      this.symbolList.forEach((symbol: string) => {
        const rawData = response[symbolIdMap[this.getFormattedSymbol(symbol)]];
        this.marketInfo[symbol].marketStatus = {
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
    } catch (e) {
      console.log(`[Aark Service] Failed to fetch market statuses: ${e}`);
      this.symbolList.forEach((symbol: string) => {
        this.marketInfo[symbol].marketStatus = undefined;
      });
    }
  }

  async executeOrders(actionParams: IActionParam[]) {
    return;
  }
}
