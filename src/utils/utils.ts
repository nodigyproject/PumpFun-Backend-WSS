import { LAMPORTS_PER_SOL, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import logger from "../logs/logger";
import { SniperBotConfig } from "../service/setting/botConfigClass";
import { connection, wallet } from "../config";
import {
  SPL_ACCOUNT_LAYOUT,
  TOKEN_PROGRAM_ID,
  TokenAccount,
} from "@raydium-io/raydium-sdk";
import * as spl from "@solana/spl-token";
import {
  getPumpTokenPriceUSD,
  getTokenBalance,
} from "../service/pumpfun/pumpfun";
import { PUMP_FUN_PROGRAM, TOTAL_SUPPLY } from "./constants";
import {
  IDexScreenerResponse,
  ITxntmpData,
  SwapParam,
} from "./types";
import {
  saveTXonDB,
} from "../service/tx/TxService";
import { ITransaction, SniperTxns } from "../models/SniperTxns";
import { swap } from "../service/swap/swap";
import { getLatestBlockhash } from "../service/sniper/getBlock";
import { getTokenDataforAssets } from "../service/assets/assets";
import { jito_executeAndConfirm, jupiterSwap, pumpfun_program, sell } from "../service/sniper/sniperService_update";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";

const WSOL = "So11111111111111111111111111111111111111112";

export const formatTimestamp = (timestamp: number) => {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds());

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
};

export const calculateTotalPercentage = (holders: any[]) => {
  return holders.reduce((total, holder) => total + holder.percentage, 0);
};

export async function sleepTime(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function chunkArray<T>(array: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(array.length / size) }, (v, i) =>
    array.slice(i * size, i * size + size)
  );
}

export function bufferFromUInt64(value: number | string) {
  let buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
}

export function readBigUintLE(
  buf: Buffer,
  offset: number,
  length: number
): number {
  switch (length) {
    case 1:
      return buf.readUint8(offset);
    case 2:
      return buf.readUint16LE(offset);
    case 4:
      return buf.readUint32LE(offset);
    case 8:
      return Number(buf.readBigUint64LE(offset));
  }
  throw new Error(`unsupported data size (${length} bytes)`);
}

export const isWorkingTime = (): boolean => {
  const currentTime = new Date();
  const currentHour = currentTime.getUTCHours();
  const currentMinute = currentTime.getUTCMinutes();

  const workingHours = SniperBotConfig.getWorkingHours();
  if (workingHours.enabled === false) return true; // dont check working time

  const [startHour, startMinute] = workingHours.start.split(":").map(Number);
  const [endHour, endMinute] = workingHours.end.split(":").map(Number);

  const currentTimeInMinutes = currentHour * 60 + currentMinute;
  const startTimeInMinutes = startHour * 60 + startMinute;
  const endTimeInMinutes = endHour * 60 + endMinute;

  return (
    currentTimeInMinutes >= startTimeInMinutes &&
    currentTimeInMinutes <= endTimeInMinutes
  );
};

export const isRunning = (): boolean => {
  return SniperBotConfig.getIsRunning();
};

export const getTokenPriceFromJupiter = async (mint: string) => {
  try {
    const BaseURL = `https://api.jup.ag/price/v2?ids=${mint}`;

    const response = await fetch(BaseURL);
    const data = await response.json();
    const price = data.data[mint]?.price;
    return price;
  } catch (error) {
    logger.error("Error fetching token price from Jupiter: " + error);
    return 0;
  }
};

export const getSwapAmountByTxHash = async (txHash: string): Promise<{ tokenAmount: number, solAmount: number }> => {
  try {
    let txn;
    while (!txn) {
      txn = await connection.getParsedTransaction(txHash,
        {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed"
        },
      );
      sleepTime(2000);
    }
    if (
      txn &&
      txn.meta &&
      txn.meta.preTokenBalances &&
      txn.meta.postTokenBalances
    ) {
      const preData = txn.meta.preTokenBalances;
      const postData = txn.meta.postTokenBalances;
      let tokenAmount = 0;
      let solAmount = 0;
      const mints: { mint: string; amount: number }[] = [];
      for (const item1 of preData) {
        const _mint1 = item1.mint;
        const _owner1 = item1.owner;
        for (const item2 of postData) {
          const _mint2 = item2.mint;
          const _owner2 = item2.owner;
          if (_mint1 === _mint2 && _owner1 === _owner2) {
            const deltaAmount =
              Number(item1.uiTokenAmount.uiAmount) -
              Number(item2.uiTokenAmount.uiAmount);
            const mint = _mint1;
            if (deltaAmount === 0) continue;
            mints.push({ mint: mint, amount: deltaAmount });
          }
        }
      }
      // txn.meta.preBalances.forEach((item, index) => console.log(item - txn.meta.postBalances[index]));
      const mint_account = new PublicKey(mints[0].mint).toBuffer();
      const [bondingCurve] = PublicKey.findProgramAddressSync(
        [Buffer.from("bonding-curve"), mint_account],
        PUMP_FUN_PROGRAM
      );
      const id = txn.transaction.message.accountKeys.findIndex((key) => key.pubkey.equals(bondingCurve));
      // console.log(id);
      solAmount = Math.abs((txn.meta.preBalances[id] - txn.meta.postBalances[id]) / LAMPORTS_PER_SOL);
      tokenAmount = Math.abs(mints[0].amount);
      return {
        tokenAmount,
        solAmount
      };
    }
    else
      throw new Error("failed to fetch txn swap data");
  } catch (error: any) {
    console.log("Error while running getSwapAmountByTxHash", error.message);
    return {
      tokenAmount: 0,
      solAmount: 0
    };
  }
}

export const getSolPrice = async () => {
  const SOL_URL = `https://api.jup.ag/price/v2?ids=${WSOL}`;
  try {
    const BaseURL = SOL_URL;
    const response = await fetch(BaseURL);
    const data = await response.json();
    const price = data.data[WSOL]?.price;
    //logger.info(`[SOL PRICE] ${Date.now()} | ${price}`);
    return price;
  } catch (error) {
    // logger.error("Error fetching SOL price: " + error);
    return 0;
  }
};

export const isSniping = (): boolean => {
  if (!isRunning()) return false;
  if (!isWorkingTime()) return false;
  return true;
};

export async function simulateTxn(txn: VersionedTransaction) {
  const { value: simulatedTransactionResponse } =
    await connection.simulateTransaction(txn, {
      replaceRecentBlockhash: true,
      commitment: "processed",
    });
  const { err, logs } = simulatedTransactionResponse;
  console.log("\n🚀 Simulate ~", Date.now());
  if (err) {
    console.error("* Simulation Error:", err, logs);
    throw new Error(
      "Simulation txn. Please check your wallet balance and slippage." +
      err
    );
  }
}

export async function getWalletTokenAccount(): Promise<TokenAccount[]> {
  const walletTokenAccount = await connection.getTokenAccountsByOwner(
    wallet.publicKey,
    {
      programId: TOKEN_PROGRAM_ID,
    }
  );
  return walletTokenAccount.value.map((i) => ({
    pubkey: i.pubkey,
    programId: i.account.owner,
    accountInfo: SPL_ACCOUNT_LAYOUT.decode(i.account.data),
  }));
}
export async function getCurrentUSDMC(mint: string): Promise<number> {
  const { price } = await getPumpTokenPriceUSD(mint);
  return price * TOTAL_SUPPLY;
}

export async function getDexscreenerData(
  mint: string
): Promise<IDexScreenerResponse | null> {
  try {
    const url = `https://api.dexscreener.com/token-pairs/v1/solana/${mint}`;
    const response = await fetch(url);
    const data = await response.json();
    return data;
  } catch (error) {
    return null;
  }
}

export const sellTokenSwap = async (mint: string, amount: number, isAlert: boolean, isSellAll: boolean): Promise<string | null> => {
  try {
    if (!isSellAll && amount === 0) {
      console.log(`sellTokenSwap, mint: ${mint}, amount: `)
    }
    if (isSellAll && amount < 1000) {
      // close token account
      const splAta = spl.getAssociatedTokenAddressSync(
        new PublicKey(mint),
        wallet.publicKey,
        true
      );
      const closeAccountInst = spl.createCloseAccountInstruction(
        splAta,
        wallet.publicKey,
        wallet.publicKey
      );
      const latestBlockhash = getLatestBlockhash();
      if (!latestBlockhash) {
        logger.error(`[❌ CLOSE-ERROR] ${mint}} | Failed to get blockhash for account closure`);
        return null;
      }
      const closeMsg = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions: [closeAccountInst],
      }).compileToV0Message();
      const closeTx = new VersionedTransaction(closeMsg);
      closeTx.sign([wallet]);
      const result = await jito_executeAndConfirm(closeTx, wallet, latestBlockhash, 100000);
      let txHash = "";
      if (result.confirmed) {
        txHash = bs58.encode(closeTx.signatures[0]);
      }
      return txHash;
    }
    const botBuyConfig = SniperBotConfig.getBuyConfig();
    const jito_tip = isSellAll ? botBuyConfig.jitoTipAmount : botBuyConfig.jitoTipAmount * 2;
    // const associatedBondingCurve = await spl.getAssociatedTokenAddress(
    //   new PublicKey(mint),
    //   getBondingCurvePDA(new PublicKey(mint)),
    //   true
    // );
    // const associatedUser = await spl.getAssociatedTokenAddress(new PublicKey(mint), wallet.publicKey, false);
    // const signature = await sell(mint, BigInt(amount), associatedBondingCurve, associatedUser, jito_tip * LAMPORTS_PER_SOL);
    const signature = await jupiterSwap(mint, spl.NATIVE_MINT.toBase58(), amount, jito_tip * LAMPORTS_PER_SOL);
    return signature;
  } catch (error: any) {
    logger.error(`[❌ SELL-ERROR] ${mint} | Error during sellTokenSwap: ${error.message}`);
    if (error.stack) {
      logger.error(`[❌ STACK-TRACE] ${mint} | ${error.stack.split('\n')[0]}`);
    }
    return null;
  }
};

const getBondingCurvePDA = (mint: PublicKey) => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()],
    pumpfun_program.programId
  )[0];
}
