import { IMessage } from "../interfaces/message-interface";
import axios from "axios";

class slackMonitoringService {
  private slackUrl: string;
  private lastMessage: IMessage;
  private messageInterval: number;

  constructor(slackUrl: string, messageInterval: number = 60_000) {
    this.slackUrl = slackUrl;
    this.lastMessage = {
      topic: "",
      timestamp: 0,
    };
    this.messageInterval = messageInterval;
  }

  _setLastMessage(topic: string, timestamp: number) {
    this.lastMessage = { topic, timestamp };
  }

  _isSentRecently(topic: string, timestamp: number): boolean {
    return (
      this.lastMessage.topic === topic &&
      this.lastMessage.timestamp < timestamp - this.messageInterval
    );
  }

  async send(topic: string, desc: string) {
    const timestamp = new Date().getTime();
    if (this._isSentRecently(topic, timestamp)) {
      return;
    }
    await axios.post(this.slackUrl, {
      text: `*${new Date().toISOString()}*\n` + `[${topic}] : ${desc}`,
    });
    this._setLastMessage(topic, timestamp);
  }
}
