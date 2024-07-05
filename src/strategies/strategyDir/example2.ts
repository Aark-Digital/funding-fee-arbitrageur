import { hello } from "./hello";

export class Strategy {
  private params: any = {};
  private readonly localState = {
    epoch: 0,
  };
  constructor() {
    console.log("Constructro!");
  }

  _readEnvParams() {
    const [NUMBER_PARAM_1, NUMBER_PARAM_2] = [
      process.env.NUMBER_PARAM_1!,
      process.env.NUMBER_PARAM_2!,
    ].map((param: string) => parseFloat(param));

    const STRING_PARAM_1 = process.env.STRING_PARAM_1!;
    const STRING_PARAM_2 = process.env.STRING_PARAM_2!;

    this.params = {
      NUMBER_PARAM_1,
      NUMBER_PARAM_2,
      STRING_PARAM_1,
      STRING_PARAM_2,
    };
  }

  async init() {
    console.log("initialize"!);
    this._readEnvParams();
  }

  async run() {
    console.log(`Current Epoch : ${this.localState.epoch}`);
    this.localState.epoch += 1;
    hello();
    console.log("--- this.params ---");
    console.log(JSON.stringify(this.params, null, 2));
  }
}
