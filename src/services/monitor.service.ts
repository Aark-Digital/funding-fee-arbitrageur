import { Twilio } from "twilio";
import {
  ITWilioParam,
  IManagerParam,
} from "../interfaces/monitoring-interface";
import axios from "axios";

export class MonitorService {
  private static instance: MonitorService;
  private twilioParam: ITWilioParam;
  private twilioClient: Twilio;
  private slackUrl: string;
  private managerParam: IManagerParam[];
  private slackMessageTimestamp: { [topic: string]: number } = {};
  private lastCallTimestamp: number;

  static getInstance(): MonitorService {
    if (!MonitorService.instance) {
      MonitorService.instance = new MonitorService(
        process.env.SLACK_URL!,
        JSON.parse(process.env.TWILIO_PARAM!),
        JSON.parse(process.env.MANAGER_PARAM!)
      );
    }
    return MonitorService.instance;
  }

  constructor(
    slackUrl: string,
    twilioParam: ITWilioParam,
    managerParam: IManagerParam[]
  ) {
    this.twilioParam = twilioParam;
    this.twilioClient = new Twilio(
      twilioParam?.accountSid,
      twilioParam?.authToken
    );
    this.slackUrl = slackUrl;
    this.managerParam = managerParam;
    this.lastCallTimestamp = 0;
  }

  async slackMessage(
    topic: string,
    desc: string,
    interval: number = 60_000,
    tagManager: boolean = false,
    call: boolean = false
  ) {
    const managerTagStr = this.managerParam.reduce(
      (acc: string, info: IManagerParam) => `${acc}<@${info.slackId}> `,
      ""
    );
    const text =
      (tagManager ? `${managerTagStr}` : "") +
      `*${new Date().toISOString()}*\n` +
      `[${topic}]\n${desc}`;
    console.log(text);
    const timestamp = Date.now();
    if (
      this.slackUrl !== undefined ||
      !this._isSlackSentRecently(topic, timestamp, interval)
    ) {
      console.log("Message at ", new Date().toISOString());
      await axios.post(this.slackUrl, { text }, { timeout: 5000 });
      this._setLastSlackMessage(topic, timestamp);
    }
    if (call) {
      this._twilioCall(interval);
    }
  }

  private _setLastSlackMessage(topic: string, timestamp: number) {
    this.slackMessageTimestamp[topic] = timestamp;
  }

  private _isSlackSentRecently(
    topic: string,
    timestamp: number,
    interval: number
  ): boolean {
    return (
      this.slackMessageTimestamp[topic] !== undefined &&
      this.slackMessageTimestamp[topic] > timestamp - interval
    );
  }

  private _twilioCall(interval: number) {
    if (this.twilioParam === undefined) {
      console.log(`UNDEFINED TWILIO PARAM`);
      return;
    } else if (this._isTwilioCallRecently(interval)) {
      return;
    }

    for (const info of this.managerParam) {
      this.twilioClient.calls.create({
        url: this.twilioParam.url,
        to: info.phoneNumber,
        from: this.twilioParam.twilioNumber,
      });
    }
    this.lastCallTimestamp = Date.now();
  }

  private _isTwilioCallRecently(interval: number): boolean {
    const timestamp = Date.now();
    return this.lastCallTimestamp > timestamp - interval ? true : false;
  }
}
