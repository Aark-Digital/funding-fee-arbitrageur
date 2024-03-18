import { ethers } from "ethers";
import { abi as ERC20 } from "../abis/ERC20.json";
import { ERC20_INFO } from "../constants/erc20";
import { parseEthersBignumber } from "./number";

export function getERC20Info(symbol: string) {
  return ERC20_INFO[symbol];
}

export async function getERC20Balance(
  signer: ethers.Wallet,
  symbol: string,
  address: string
): Promise<number> {
  const tokenInfo = getERC20Info(symbol);
  if (tokenInfo === undefined) {
    throw Error("Unregistered Token");
  }
  const tokenContract = new ethers.Contract(
    tokenInfo.contractAddress,
    ERC20,
    signer
  );

  const balance = await tokenContract.balanceOf(address);
  return parseEthersBignumber(balance, tokenInfo.decimal);
}

export async function approveERC20(
  signer: ethers.Wallet,
  toAddress: string,
  symbol: string,
  amount: number
) {
  const tokenInfo = getERC20Info(symbol);
  if (tokenInfo === undefined) {
    throw Error("Unregistered Token");
  }
  const tokenContract = new ethers.Contract(
    tokenInfo.contractAddress,
    ERC20,
    signer
  );
  const tokenAmount = Math.floor(amount * 10 ** tokenInfo.decimal);
  const tx = await tokenContract.approve(toAddress, tokenAmount);
  await tx.wait();
}
export async function transferERC20(
  signer: ethers.Wallet,
  toAddress: string,
  symbol: string,
  amount: number
): Promise<boolean> {
  const tokenInfo = getERC20Info(symbol);
  if (tokenInfo === undefined) {
    throw Error("Unregistered Token");
  }
  const tokenContract = new ethers.Contract(
    tokenInfo.contractAddress,
    ERC20,
    signer
  );
  const tokenAmount = Math.floor(amount * 10 ** tokenInfo.decimal);

  const tx = await tokenContract.transfer(toAddress, tokenAmount);
  await tx.wait();
  return true;
}
