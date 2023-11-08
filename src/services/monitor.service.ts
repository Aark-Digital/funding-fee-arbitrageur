import { Twilio } from "twilio";
import {
  ISlackMessage,
  ISlackParam,
  ITWilioParam,
} from "../interfaces/monitoring-interface";
import axios from "axios";

export class MonitorService {
  private twilioParam?: ITWilioParam;
  private twilioClient: Twilio;
  private slackParam?: ISlackParam;
  private lastSlackMessage: ISlackMessage;
  private lastCallTimestamp: number;

  constructor(twilioParam?: ITWilioParam, slackParam?: ISlackParam) {
    this.twilioParam = twilioParam;
    this.twilioClient = new Twilio(
      twilioParam?.accountSid,
      twilioParam?.authToken
    );
    this.slackParam = slackParam;
    this.lastSlackMessage = {
      topic: "",
      timestamp: 0,
    };
    this.lastCallTimestamp = 0;
  }

  async slackMessage(
    topic: string,
    desc: string,
    tagManager: boolean = false,
    call: boolean = false
  ) {
    if (this.slackParam === undefined) {
      console.log(`UNDEINFED SLACK PARAM`);
      return;
    }
    const timestamp = new Date().getTime();
    if (this._isSlackSentRecently(topic, timestamp)) {
      return;
    }
    const text =
      (tagManager ? `<@${this.slackParam.managerSlackId}> ` : "") +
      `*${new Date().toISOString()}*\n` +
      `[${topic}]\n${desc}`;
    if (call) {
      this._twilioCall();
    }
    await axios.post(this.slackParam.url, { text });
    this._setLastSlackMessage(topic, timestamp);
  }

  private _setLastSlackMessage(topic: string, timestamp: number) {
    this.lastSlackMessage = { topic, timestamp };
  }

  private _isSlackSentRecently(topic: string, timestamp: number): boolean {
    return (
      this.lastSlackMessage.topic === topic &&
      this.lastSlackMessage.timestamp >
        timestamp - this.slackParam!.messageInterval
    );
  }

  private _twilioCall() {
    if (this.twilioParam === undefined) {
      console.log(`UNDEFINED TWILIO PARAM`);
      return;
    } else if (this._isTwilioCallRecently()) {
      return;
    }
    console.log("hi");
    this.twilioClient.calls.create({
      url: this.twilioParam.url,
      to: this.twilioParam.managerNumber,
      from: this.twilioParam.twilioNumber,
    });
  }

  private _isTwilioCallRecently(): boolean {
    const timestamp = new Date().getTime();
    return this.lastCallTimestamp > timestamp - this.twilioParam!.callInterval
      ? true
      : false;
  }
}
