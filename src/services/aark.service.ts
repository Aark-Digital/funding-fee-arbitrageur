import { ethers } from "ethers";
import BigNumber from "bignumber.js";
import { abi as ContractReader } from "../abis/ContractReader.json";
import { abi as OctRouterABI } from "../abis/OctRouter.json";
import { abi as LpManager } from "../abis/LpManager.json";
import { abi as MasterRouter } from "../abis/MasterRouter.json";
import { contractAddressMap } from "../constants/contract-address";
import { IAarkMarket } from "../interfaces/market-interface";
import {
  ActionType,
  IActionParam,
  ICancelOrderParam,
  ILimitOrderParam,
  IMarketOrderParam,
  Side,
} from "../interfaces/order-interface";
import axios from "axios";
import { sleep } from "../utils/time";
import { Balance, Position } from "../interfaces/basic-interface";
import { parseEthersBignumber } from "../utils/number";

const symbolIdMap: { [symbol: string]: number } = {
  ETH: 1,
  BTC: 2,
  BNB: 3,
  XRP: 4,
  MATIC: 5,
  ARB: 6,
  SOL: 7,
  USDT: 8,
  DOGE: 9,
  LINK: 10,
  ADA: 12,
  ATOM: 13,
  LTC: 14,
  AVAX: 15,
  DOT: 16,
  ETC: 17,
  BCH: 18,
  FIL: 19,
  NEAR: 20,
  DYDX: 21,
  OP: 37,
  ORDI: 38,
  SUI: 39,
  TIA: 40,
  APT: 41,
  INJ: 42,
  SEI: 43,
  BLUR: 44,
  MANTA: 45,
  ID: 46,
};

const collateralAddressMap: { [symbol: string]: string } = {
  "0x17FC002b466eEc40DaE837Fc4bE5c67993ddBd6F": "FRAX",
  "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f": "BTC",
  "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1": "ETH",
  "0x5979D7b546E38E414F7E9822514be443A4800529": "WSTETH",
  "0x912CE59144191C1204E64559FE8253a0e49E6548": "ARB",
  "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9": "USDT",
  "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1": "DAI",
};

export class AarkService {
  private octService: OctService;
  private contractReader: ethers.Contract;
  private lpManager: ethers.Contract;
  private masterRouter: ethers.Contract;
  private symbolList: string[];
  private markets: { [symbol: string]: IAarkMarket } = {};
  private balances: undefined | Balance[];
  private lastTradePrices: { [symbol: string]: number } = {};
  private lpPoolValue: undefined | number;
  private signer: ethers.Wallet;
  private provider: ethers.providers.JsonRpcProvider =
    new ethers.providers.JsonRpcProvider({
      url: `https://arb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
      timeout: 5000,
    });
  private indexPriceUrl: string = process.env.AARK_INDEX_PRICE_URL!;

  constructor(signerPk: string, symbolList: string[]) {
    this.symbolList = symbolList;
    this.signer = new ethers.Wallet(signerPk, this.provider);
    this.contractReader = new ethers.Contract(
      contractAddressMap["contractReader"],
      ContractReader,
      this.signer
    );
    this.lpManager = new ethers.Contract(
      contractAddressMap["lpManager"],
      LpManager,
      this.signer
    );
    this.masterRouter = new ethers.Contract(
      contractAddressMap["router"],
      MasterRouter,
      this.signer
    );
    this.symbolList.forEach((symbol) => {
      this.markets[symbol] = {
        orderbook: undefined,
        position: undefined,
        openOrders: undefined,
        indexPrice: undefined,
        marketStatus: undefined,
        fundingRate: undefined,
        marketInfo: { contractSize: 1, pricePrecision: 8, qtyPrecision: 10 },
      };
    });
    this.balances = undefined;
    this.octService = new OctService(signerPk);
  }

  async init() {
    await this.octService.init();
  }

  getSigner() {
    return this.signer;
  }
  getArbitrageurAddress() {
    return this.signer.address;
  }

  getFormattedSymbol(symbol: string) {
    const [base, quote] = symbol.split("_");
    return `${base}`;
  }

  getMarketInfo() {
    return this.markets;
  }

  getBalance() {
    return this.balances;
  }

  getLpPoolValue() {
    return this.lpPoolValue;
  }

  getLastTradePrices() {
    return this.lastTradePrices;
  }

  async fetchOrderbooks() {
    throw new Error("Not Implemented");
  }

  async fetchOpenOrders() {
    throw new Error("Not Implemented");
  }

  async fetchIndexPrices() {
    try {
      const priceResponse = await axios.get(this.indexPriceUrl, {
        params: {
          symbols: this.symbolList
            .map((symbol: string) => this.getFormattedSymbol(symbol))
            .join(","),
        },
        timeout: 5000,
      });
      this.symbolList.forEach((symbol: string, idx: number) => {
        this.markets[symbol].indexPrice = priceResponse.data[idx].indexPrice;
      });
    } catch (e) {
      console.log(`[Aark Service] Failed to fetch index prices: ${e}`);
      this.symbolList.forEach((symbol: string) => {
        this.markets[symbol].indexPrice = undefined;
      });
    }
  }

  async fetchMarketStatuses() {
    try {
      const response = await this.contractReader.getMarkets();
      this.symbolList.forEach((symbol: string) => {
        const rawData = response[symbolIdMap[this.getFormattedSymbol(symbol)]];
        this.markets[symbol].marketStatus = {
          fundingRatePrice24h:
            parseEthersBignumber(rawData.fundingRate, 18) * 86400,
          skewness: parseEthersBignumber(rawData.skewness, 10),
          depthFactor: parseEthersBignumber(rawData.depthFactor, 10),
          oiHardCap: parseEthersBignumber(rawData.skewnessHardCap, 10),
          oiSoftCap: parseEthersBignumber(rawData.skewnessSoftCap, 10),
          targetLeverage: parseEthersBignumber(rawData.targetLeverage, 2),
          coefficient: parseEthersBignumber(rawData.fundingRateCoefficient, 2),
        };
      });
    } catch (e) {
      console.log(`[Aark Service] Failed to fetch market statuses: ${e}`);
      this.symbolList.forEach((symbol: string) => {
        this.markets[symbol].marketStatus = undefined;
      });
    }
  }

  async fetchLastTradePrices() {
    const response = await this.contractReader.getPriceFeeds(
      this.symbolList.map(
        (symbol) => symbolIdMap[this.getFormattedSymbol(symbol)]
      )
    );
    this.symbolList.forEach((symbol: string, idx: number) => {
      this.lastTradePrices[symbol] = parseEthersBignumber(response[idx], 8);
    });
  }

  async _fetchAddressStatus(
    address: string
  ): Promise<[undefined | Balance[], undefined | Position[]]> {
    const timestamp = Date.now();
    try {
      const response = await this.contractReader.getUserFuturesStatus(address);

      const balances: Balance[] = response.collaterals
        .filter(
          (col: any) =>
            col.tokenAddress != "0x0000000000000000000000000000000000000000"
        )
        .map((col: any) => ({
          currency: collateralAddressMap[col.tokenAddress],
          total: parseEthersBignumber(col.qty, 18),
          available: parseEthersBignumber(col.withdrawable, 18),
          weight: parseEthersBignumber(col.totalWeight, 4),
        }))
        .concat([
          {
            currency: "USDC",
            total: parseEthersBignumber(response.usdBalance, 18),
            available: parseEthersBignumber(response.withdrawableUsd, 18),
            weight: 1,
          },
        ]);

      const positions: Position[] = [];

      this.symbolList.forEach((symbol) => {
        const position =
          response.positions[symbolIdMap[this.getFormattedSymbol(symbol)]];
        positions.push({
          timestamp,
          symbol,
          price: parseEthersBignumber(position.entryPrice, 8),
          size: parseEthersBignumber(position.qty, 10),
        });
      });
      return [balances, positions];
    } catch (e) {
      console.log(`[Aark Service] Failed to fetch address status: ${e}`);
      // this.symbolList.forEach((symbol: string) => {
      //   this.markets[symbol].position = undefined;
      // });
      // this.balances = undefined;
      return [undefined, undefined];
    }
  }

  async fetchSignerStatus() {
    const [balances, positions] = await this._fetchAddressStatus(
      this.signer.address
    );

    this.balances = balances;
    Object.keys(this.markets).forEach((symbol: string) => {
      if (positions !== undefined) {
        const position = positions.find((pos) => pos.symbol === symbol)!;
        this.markets[symbol].position = position;
      } else {
        this.markets[symbol].position = undefined;
      }
    });
  }

  async fetchLpPoolValue() {
    const lpPoolValue = await this.lpManager.getLpPoolValue();
    this.lpPoolValue = parseEthersBignumber(lpPoolValue, 18);
  }

  async withdrawUSDC(amount: number): Promise<boolean> {
    const tokenAmount = Math.floor(amount * 1e6);
    const usdcAddress = contractAddressMap["USDC"];
    const tx = await this.masterRouter.removeCollateral(
      this.signer.address,
      usdcAddress,
      tokenAmount,
      false
    );
    await tx.wait();
    return true;
  }

  async depositUSDC(amount: number): Promise<boolean> {
    const tokenAmount = Math.floor(amount * 1e6);
    const usdcAddress = contractAddressMap["USDC"];
    const tx = await this.masterRouter.addCollateral(
      this.signer.address,
      usdcAddress,
      tokenAmount,
      false
    );
    await tx.wait();
    return true;
  }

  async executeOrders(actionParams: IActionParam[]) {
    const cancelParams = actionParams
      .filter((param: IActionParam) => param.type === ActionType.Cancel)
      .map((param: IActionParam) => param.order) as ICancelOrderParam[];
    const marketOrderParams = actionParams
      .filter((param: IActionParam) => param.type === ActionType.CreateMarket)
      .map((param: IActionParam) => param.order) as IMarketOrderParam[];
    const limitOrderParams = actionParams
      .filter((param: IActionParam) => param.type === ActionType.CreateLimit)
      .map((param: IActionParam) => param.order) as ILimitOrderParam[];

    // ONLY MARKET ORDER IS AVAILABLE
    if (cancelParams.length * limitOrderParams.length !== 0) {
      throw new Error(
        "LimtOrder & CancelOrder are not implemented in AarkService"
      );
    }

    for (const param of marketOrderParams) {
      await this.octService.octOrder(
        Math.abs(param.size),
        symbolIdMap[this.getFormattedSymbol(param.symbol)],
        param.size > 0 ? true : false,
        false
      );
      await sleep(100);
    }
  }
}

export class OctService {
  private readonly PRICE_DECIMALS = 8;
  private readonly QTY_DECIMALS = 10;
  private _wallet: ethers.Wallet;

  constructor(signer_pk: string) {
    this._wallet = new ethers.Wallet(
      signer_pk,
      new ethers.providers.AlchemyProvider(
        "arbitrum",
        process.env.ALCHEMY_API_KEY!
      )
    );
  }

  async init() {
    const provider = new ethers.providers.AlchemyProvider(
      "arbitrum",
      process.env.ALCHEMY_API_KEY!
    );
    const octRouter = new ethers.Contract(
      contractAddressMap["octRouter"],
      OctRouterABI,
      this._wallet
    );
  }

  async octOrder(
    qty: number,
    marketId: number,
    isLong: boolean,
    isLimit: boolean,
    price: number = 0,
    slippageTolerance: number = 0,
    isReduceOnly_: boolean = false
  ) {
    const nonce = Date.now();

    const orderObject = this._getFuturesOrderObject(
      new BigNumber(qty)
        .multipliedBy(new BigNumber(10).pow(this.QTY_DECIMALS))
        .toFixed(0, BigNumber.ROUND_DOWN),
      new BigNumber(price)
        .multipliedBy(new BigNumber(10).pow(this.PRICE_DECIMALS))
        .toFixed(0, BigNumber.ROUND_DOWN),
      new BigNumber(slippageTolerance)
        .multipliedBy(new BigNumber(10).pow(this.PRICE_DECIMALS))
        .toFixed(0, BigNumber.ROUND_DOWN),
      marketId.toString(),
      isLong,
      isLimit,
      Math.floor(nonce / 1000).toString(),
      isReduceOnly_
    );

    const hashMsg = ethers.utils.keccak256(
      new ethers.utils.AbiCoder().encode(
        ["address", "uint256", "uint256"],
        [this._wallet.address, orderObject, nonce]
      )
    );
    const msgHashBinary = ethers.utils.arrayify(hashMsg);

    const signature = await this._wallet.signMessage(msgHashBinary);

    const res = await axios.post(
      `${process.env.OCT_BACKEND_URL}/oct/order`,
      {
        delegator: this._wallet.address,
        delegatee: this._wallet.address,
        order: orderObject,
        nonce: nonce,
      },
      {
        headers: {
          signature: signature,
        },
        timeout: 5000,
      }
    );
  }

  private _getFuturesOrderObject(
    qty_: string,
    price_: string,
    slippageTolerance_: string,
    marketId_: string,
    isLong_: boolean,
    isLimit_: boolean,
    timestamp_: string,
    isReduceOnly_: boolean
  ) {
    const qty = new BigNumber(qty_).toString(2).padStart(57, "0");
    const price = new BigNumber(price_).toString(2).padStart(54, "0");
    const slippageTolerance = new BigNumber(slippageTolerance_)
      .toString(2)
      .padStart(54, "0");
    const marketId = new BigNumber(marketId_).toString(2).padStart(8, "0");
    const isLong = isLong_ ? "1" : "0";
    const isLimit = isLimit_ ? "1" : "0";
    const timestamp = new BigNumber(timestamp_).toString(2).padStart(32, "0");
    const data =
      (isReduceOnly_ ? "1" : "0") +
      timestamp +
      isLimit +
      isLong +
      marketId +
      slippageTolerance +
      price +
      qty;
    return `0x${new BigNumber(data.padStart(256, "0"), 2).toString(16)}`;
  }
}
