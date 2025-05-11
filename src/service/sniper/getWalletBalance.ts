import { wallet } from "../../config";
import logger from "../../logs/logger";
import { getSolBananceFromWallet } from "../assets/assets";

let balanceCache = 0;
export async function startBalanceMonitor() {
  // logger.info("Start monitoring wallet balance...");
  const balance = await getSolBananceFromWallet(wallet);
  if (balance) {
    balanceCache = balance;
  }
  console.log('Wallet balance interval check : ', balance);
  setInterval(async () => {
    const balance = await getSolBananceFromWallet(wallet);
    if (balance)
      balanceCache = balance;
  }, 1 * 60 * 1000); // Check every minute
}

export function getWalletBalanceFromCache(): number {
  return balanceCache;
}

