export interface ITWilioParam {
  accountSid: string;
  authToken: string;
  twilioNumber: string;
  managerNumber: string;
  url: string;
  callInterval: number;
}

export interface ISlackParam {
  url: string;
  messageInterval: number;
  managerSlackId: string;
}

export interface ISlackMessage {
  topic: string;
  timestamp: number;
}
