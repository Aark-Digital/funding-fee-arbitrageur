import { ethers } from "ethers";
import BigNumber from "bignumber.js";
import { abi as ContractReader } from "../abis/ContractReader.json";
import { abi as OctRouterABI } from "../abis/OctRouter.json";
import { abi as FuturesManager } from "../abis/FuturesManager.json";
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
import Prando from "prando";
import axios from "axios";
import { sleep } from "../utils/time";
import { MonitorService } from "./monitor.service";
import { Balance } from "../interfaces/basic-interface";
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
};

const collateralAddressMap: { [symbol: string]: string } = {
  "0x17FC002b466eEc40DaE837Fc4bE5c67993ddBd6F": "FRAX",
  "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f": "BTC",
  "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1": "ETH",
};

export class AarkService {
  private octService: OctService;
  private contractReader: ethers.Contract;
  private symbolList: string[];
  private markets: { [symbol: string]: IAarkMarket } = {};
  private balances: undefined | Balance[];
  private signer: ethers.Wallet;
  private provider: ethers.providers.AlchemyProvider =
    new ethers.providers.AlchemyProvider(
      "arbitrum",
      process.env.ALCHEMY_API_KEY!
    );
  private indexPriceUrl: string = process.env.AARK_INDEX_PRICE_URL!;

  constructor(signerPk: string, symbolList: string[]) {
    this.symbolList = symbolList;
    this.signer = new ethers.Wallet(signerPk, this.provider);
    this.contractReader = new ethers.Contract(
      contractAddressMap["contractReader"],
      ContractReader,
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

  getFormattedSymbol(symbol: string) {
    const [base, quote] = symbol.split("_");
    return `${base}`;
  }

  getMarketInfo() {
    return this.markets;
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
        };
      });
    } catch (e) {
      console.log(`[Aark Service] Failed to fetch market statuses: ${e}`);
      this.symbolList.forEach((symbol: string) => {
        this.markets[symbol].marketStatus = undefined;
      });
    }
  }

  async fetchUserStatus() {
    const timestamp = Date.now();
    try {
      const response = await this.contractReader.getUserFuturesStatus(
        this.signer.address
      );

      this.balances = response.collaterals
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

      this.symbolList.forEach((symbol, idx) => {
        const position =
          response.positions[symbolIdMap[this.getFormattedSymbol(symbol)]];
        this.markets[symbol].position = {
          timestamp,
          symbol,
          price: parseEthersBignumber(position.entryPrice, 8),
          size: parseEthersBignumber(position.qty, 10),
        };
      });
    } catch (e) {
      console.log(`[Aark Service] Failed to fetch user status: ${e}`);
      this.symbolList.forEach((symbol: string) => {
        this.markets[symbol].position = undefined;
      });
      this.balances = undefined;
    }
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
  private monitorService: MonitorService;
  private delegateePkInfo: {
    epoch: number;
    pk: string;
  } = {
    epoch: -1,
    pk: "",
  };

  constructor(signer_pk: string) {
    this._wallet = new ethers.Wallet(
      signer_pk,
      new ethers.providers.AlchemyProvider(
        "arbitrum",
        process.env.ALCHEMY_API_KEY!
      )
    );
    this.monitorService = MonitorService.getInstance();
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

    const seedInfo = this._getSeed(this._getEpoch());

    const registeredDelegatee = await octRouter.delegatees(
      seedInfo.epoch,
      this._wallet.address
    );
    const signature = await this._wallet.signMessage(seedInfo.seed);
    const delegateePk = `${ethers.utils.keccak256(signature)}`;
    const delegateeWallet = new ethers.Wallet(delegateePk, provider);

    if (registeredDelegatee !== delegateeWallet.address) {
      await this.tryDelegate();
    } else {
      this.delegateePkInfo.epoch = seedInfo.epoch;
      this.delegateePkInfo.pk = delegateePk;
    }
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
    await this.tryDelegate();
    const delegateeWallet = new ethers.Wallet(this.delegateePkInfo.pk);
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

    const signature = await delegateeWallet.signMessage(msgHashBinary);

    const res = await axios.post(
      `${process.env.OCT_BACKEND_URL}/oct/order`,
      {
        delegator: this._wallet.address,
        delegatee: delegateeWallet.address,
        order: orderObject,
        nonce: nonce,
      },
      {
        headers: {
          signature: signature,
        },
      }
    );
  }

  async tryDelegate() {
    const epoch = this._getEpoch();
    if (this.delegateePkInfo.epoch === epoch) {
      return;
    }
    const seedInfo = this._getSeed(epoch);
    const signaturePK = await this._wallet.signMessage(seedInfo.seed);
    this.delegateePkInfo.epoch = seedInfo.epoch;
    this.delegateePkInfo.pk = `${ethers.utils.keccak256(signaturePK)}`;

    const delegateeWallet = new ethers.Wallet(this.delegateePkInfo.pk);
    const nonce = Date.now();

    const hashMsg = ethers.utils.keccak256(
      new ethers.utils.AbiCoder().encode(
        ["address", "address", "uint256"],
        [this._wallet.address, delegateeWallet.address, nonce]
      )
    );
    const msgHashBinary = ethers.utils.arrayify(hashMsg);

    const signature = await this._wallet.signMessage(msgHashBinary);
    console.log(`--- Deleagation Ocurred---`);
    await this.monitorService.slackMessage(
      "Delegation Occurred",
      "",
      true,
      true
    );
    await axios.post(
      `${process.env.OCT_BACKEND_URL}/oct/delegate`,
      {
        delegator: this._wallet.address,
        delegatee: delegateeWallet.address,
        nonce: nonce,
      },
      {
        headers: {
          signature: signature,
        },
      }
    );
  }

  private _getEpoch() {
    return Math.floor(Number((Date.now() / 1000).toFixed()) / (3 * 24 * 3600));
  }

  private _getSeed(epoch: number) {
    const random = new Prando(epoch);
    return {
      epoch: epoch,
      seed: random.nextString(8, "abcdef0123456789"),
    };
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
