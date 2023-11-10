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
  private octService: OctService;
  private contractReader: ethers.Contract;
  private symbolList: string[];
  private markets: { [symbol: string]: IAarkMarket } = {};
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
        balance: undefined,
        indexPrice: undefined,
        marketStatus: undefined,
        marketInfo: { contractSize: 1, pricePrecision: 10, qtyPrecision: 8 },
      };
    });

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
        this.markets[symbol].position = {
          symbol,
          timestamp,
          size,
        };
      });
    } catch {
      console.log(`[Aark Service] Failed to fetch Positions`);
      this.symbolList.forEach((symbol: string) => {
        this.markets[symbol].position = undefined;
      });
    }
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
          fundingRatePrice24h: Number(
            new BigNumber(rawData[1].toString())
              .dividedBy(1e18)
              .multipliedBy(86400)
              .toFixed()
          ),
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
        this.markets[symbol].marketStatus = undefined;
      });
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
        Number(symbolIdMap[this.getFormattedSymbol(param.symbol)]),
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
    const seedInfo = this._getSeed();

    const registeredDelegatee = await octRouter.delegatees(
      seedInfo.epoch,
      this._wallet.address
    );
    const signature = await this._wallet.signMessage(seedInfo.seed);
    const delegateePk = `${ethers.utils.keccak256(signature)}`;
    const delegateeWallet = new ethers.Wallet(delegateePk, provider);

    if (registeredDelegatee !== delegateeWallet.address) {
      await this.delegate();
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
    const delegateeWallet = new ethers.Wallet(await this._getDelegateePK());
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

  async delegate() {
    const delegateeWallet = new ethers.Wallet(await this._getDelegateePK());
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

  private async _getDelegateePK() {
    const seedInfo = this._getSeed();
    if (this.delegateePkInfo.epoch != seedInfo.epoch) {
      const signature = await this._wallet.signMessage(seedInfo.seed);
      this.delegateePkInfo.epoch = seedInfo.epoch;
      this.delegateePkInfo.pk = `${ethers.utils.keccak256(signature)}`;
    }
    const signature = await this._wallet.signMessage(seedInfo.seed);
    return `${ethers.utils.keccak256(signature)}`;
  }

  private _getSeed() {
    const epoch = Math.floor(
      Number((Date.now() / 1000).toFixed()) / (3 * 24 * 3600)
    );
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
