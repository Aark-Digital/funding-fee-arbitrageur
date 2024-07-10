export interface ITWilioParam {
  accountSid: string;
  authToken: string;
  twilioNumber: string;
  url: string;
}

export interface ISlackMessage {
  topic: string;
  timestamp: number;
}

export interface IManagerParam {
  slackId: string;
  phoneNumber: string;
}
