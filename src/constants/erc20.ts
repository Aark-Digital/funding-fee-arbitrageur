interface IERC20Info {
  decimal: number;
  contractAddress: string;
}
export const ERC20_INFO: { [key: string]: IERC20Info } = {
  USDC: {
    contractAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    decimal: 6,
  },
  USDT: {
    contractAddress: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
    decimal: 6,
  },
  BTC: {
    contractAddress: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
    decimal: 8,
  },
};
