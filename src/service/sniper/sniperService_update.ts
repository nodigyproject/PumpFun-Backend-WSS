import "dotenv/config";
import { BN } from "bn.js";
import base58 from "bs58";
import axios from 'axios';
import Client, {
  CommitmentLevel,
  SubscribeRequestAccountsDataSlice,
  SubscribeRequestFilterAccounts,
  SubscribeRequestFilterBlocks,
  SubscribeRequestFilterBlocksMeta,
  SubscribeRequestFilterEntry,
  SubscribeRequestFilterSlots,
  SubscribeRequestFilterTransactions,
} from "@triton-one/yellowstone-grpc";
import { SubscribeRequestPing } from "@triton-one/yellowstone-grpc/dist/grpc/geyser";
import { LAMPORTS_PER_SOL, PublicKey, Keypair, Transaction, TransactionMessage, VersionedTransaction, BlockhashWithExpiryBlockHeight, SystemProgram, Connection } from "@solana/web3.js";
import { publicKey } from "@solana/buffer-layout-utils";
import dotenv from "dotenv";
import { getDexscreenerData, isRunning, isWorkingTime } from "../../utils/utils";
import logger from "../../logs/logger";
import { connection, metaplex, wallet } from "../../config";
import { DBTokenList, IToken } from "../../models/TokenList";
import { SniperBotConfig } from "../setting/botConfigClass";
import { getWalletBalanceFromCache } from "./getWalletBalance";
import { IAlertMsg, ITxntmpData } from "../../utils/types";
import { PUMPFUN_IMG } from "../../utils/constants";
import { createAlert } from "../alarm/alarm";
import { PumpFun, IDL } from "./IDL";
import { Program, Provider, AnchorProvider } from "@coral-xyz/anchor";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import { struct, bool, u64, Layout } from "@coral-xyz/borsh";
import * as spl from "@solana/spl-token";
import { SniperTxns } from "../../models/SniperTxns";

dotenv.config();

const pumpfun = 'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM';
const provider = new AnchorProvider(connection, new NodeWallet(new Keypair()), {
  commitment: "processed",
});
const pumpfun_program = new Program<PumpFun>(IDL as PumpFun, provider);

let processing = false;

interface SubscribeRequest {
  accounts: { [key: string]: SubscribeRequestFilterAccounts };
  slots: { [key: string]: SubscribeRequestFilterSlots };
  transactions: { [key: string]: SubscribeRequestFilterTransactions };
  transactionsStatus: { [key: string]: SubscribeRequestFilterTransactions };
  blocks: { [key: string]: SubscribeRequestFilterBlocks };
  blocksMeta: { [key: string]: SubscribeRequestFilterBlocksMeta };
  entry: { [key: string]: SubscribeRequestFilterEntry };
  commitment?: CommitmentLevel | undefined;
  accountsDataSlice: SubscribeRequestAccountsDataSlice[];
  ping?: SubscribeRequestPing | undefined;
}

function decodeTransact(data: any) {
  const output = base58.encode(Buffer.from(data, 'base64'))
  return output;
}

function tOutPut(data: any) {
  const dataTx = data.transaction.transaction
  const signature = decodeTransact(dataTx.signature);
  const message = dataTx.transaction?.message
  const header = message.header;
  const accountKeys = message.accountKeys.map((t: any) => {
    return decodeTransact(t)
  })
  const recentBlockhash = decodeTransact(message.recentBlockhash);
  const instructions = message.instructions
  const meta = dataTx?.meta
  return {
    signature,
    message: {
      header,
      accountKeys,
      recentBlockhash,
      instructions
    },
    meta
  }
}

async function handleStream(client: Client, args: SubscribeRequest) {
  // Subscribe for events
  const stream = await client.subscribe();
  console.log("Starting Stream....")

  // Create `error` / `end` handler
  const streamClosed = new Promise<void>((resolve, reject) => {
    stream.on("error", (error: any) => {
      console.log("ERROR", error);
      reject(error);
      stream.end();
    });
    stream.on("end", () => {
      resolve();
    });
    stream.on("close", () => {
      resolve();
    });
  });

  // Handle updates
  stream.on("data", async (data: any) => {
    try {

      // 1. check bot running status
      if (!isRunning()) {
        // console.log('Bot is not running now!');
        processing = false;
        return;
      }

      if (processing) {
        // console.log('token processing');
        return;
      }
      processing = true;

      // 2. check bot working time
      if (!isWorkingTime()) {
        console.log('Not working Time');
        processing = false;
        return;
      }

      // 3. check wallet balance
      const walletBalance = getWalletBalanceFromCache();
      if (walletBalance < 0.03) {
        logger.error(
          `wallet balance ${walletBalance.toFixed(4)} SOL is too low (min: 0.03 SOL)`
        );

        // Create alert for low balance
        const newAlert: IAlertMsg = {
          imageUrl: PUMPFUN_IMG,
          title: "Insufficient Wallet Balance",
          content: `🚨 Your wallet needs more SOL to continue trading! 
                  Current balance: ${walletBalance.toFixed(4)} SOL. 
                  Bot operations paused for safety. Please top up your wallet to resume.`,
          link: wallet.publicKey.toBase58(),
          time: Date.now(),
          isRead: false,
        };

        await createAlert(newAlert);

        // Turn off the bot
        const botMainconfig = SniperBotConfig.getMainConfig();
        await SniperBotConfig.setMainConfig({
          ...botMainconfig,
          isRunning: false,
        });

        console.log('Bot stopped due to low sol balanace');
        processing = false;
        return;
      }

      const result = tOutPut(data);

      const mint = result.meta.postTokenBalances[0].mint;
      console.log('New Token : ', mint);
      // const signature = result.signature;
      // console.log('signature = ', signature);
      const dev = result.message.accountKeys[0];
      console.log('Dev wallet : ', dev);
      const bondingCurve = result.message.accountKeys[2];
      // console.log('bondingCurve = ', bondingCurve);
      const associatedBondingCurve = result.message.accountKeys[3];
      // console.log('associatedBondingCurve = ', associatedBondingCurve);
      const devBuySol = (result.meta.preBalances[0] - result.meta.postBalances[0]) / LAMPORTS_PER_SOL;
      // console.log('dev buy sol = ', devBuySol);

      // 4. check devBuySol
      const devBuySetting = SniperBotConfig.getMaxDevBuyAmount();
      if (devBuySetting.enabled && devBuySol > devBuySetting.value) {
        console.log(`dev buy amount exceeds limit amount, so skip this token ${mint}`);
        processing = false;
        return;
      }

      // 5. check duplicate token
      let tokenName = '';
      let tokenSymbol = '';
      let tokenImage = '';
      try {
        const metaPlexData = await metaplex
          .nfts()
          .findByMint({ mintAddress: new PublicKey(mint) });
        tokenName = metaPlexData.name;
        tokenSymbol = metaPlexData.symbol;
        tokenImage = metaPlexData.json?.image || '';
      } catch (error) {
        console.log(`get token meta data failed ${mint}`);
      }

      if (SniperBotConfig.getBuyConfig().duplicates.enabled === true) {
        const duplicateToken = await DBTokenList.findOne({
          tokenSymbol: tokenSymbol,
        });
        if (duplicateToken) {
          console.log(`duplicated token symbol ${tokenSymbol}, so skip this token ${mint}`);
          processing = false;
          return;
        }
      }

      // save token to db
      const tokenData: Partial<IToken> = {
        mint,
        tokenName,
        tokenSymbol,
        tokenImage,
        saveTime: Date.now(),
      };
      const newToken = new DBTokenList(tokenData);
      newToken.save();

      // monitor token's status
      const create_time = Date.now();

      let monitor_cycle = SniperBotConfig.getBuyIntervalTime();

      const monitor = async () => {

        const botBuyConfig = SniperBotConfig.getBuyConfig();

        // 1. check token age
        let min_age = 0;
        let max_age = 30; // default 30 seconds

        if (botBuyConfig.age.enabled) {
          min_age = botBuyConfig.age.start;
          max_age = botBuyConfig.age.end;
        }

        let age = (Date.now() - create_time) / 1000;

        if (age < min_age) {
          setTimeout(monitor, monitor_cycle); // token is too young, so check again after monitor cycle
          console.log(`token ${mint} is too young, so check again after monitor cycle ${monitor_cycle} seconds`)
          return;
        }

        if (age > max_age) {
          console.log(`token ${mint} is too old, so skip this token`);
          processing = false;
          return;
        }

        // 3. check max dev holding amount
        if (botBuyConfig.maxDevHoldingAmount.enabled) {
          let ata = spl.getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(dev));
          const balance = await connection.getTokenAccountBalance(ata, "processed");
          const devHoldingPercent = Number(balance.value.uiAmount) / 10000000;
          console.log(`devHolding Rate = ${devHoldingPercent} %`);
          if (devHoldingPercent > botBuyConfig.maxDevHoldingAmount.value) {
            console.log(`dev toke holdings exceeds max limit, so check again after monitor cycle ${monitor_cycle}`);
            setTimeout(monitor, monitor_cycle);
            return;
          }
        }

        // 4. check txns and volumes
        if (botBuyConfig.lastHourVolume.enabled || botBuyConfig.lastMinuteTxns.enabled) {
          const data: any = await getDexscreenerData(mint);
          if (data && data[0]) {
            const volume = data[0].volume.h1;
            const txns = data[0].txns.h1.buys + data[0].txns.h1.sells;
            console.log('volume = ', volume);
            console.log('txns = ', txns);
            if (botBuyConfig.lastHourVolume.enabled && volume < botBuyConfig.lastHourVolume.value) {
              console.log(`last hour volume is so small, so check again after monitor cycle ${monitor_cycle}`);
              setTimeout(monitor, monitor_cycle);
              return;
            }
            if (botBuyConfig.lastMinuteTxns.enabled && txns < botBuyConfig.lastMinuteTxns.value) {
              console.log(`last hour txns is so small, so check again after monitor cycle ${monitor_cycle}`);
              setTimeout(monitor, monitor_cycle);
              return;
            }
          }
        }

        // 2. check market cap
        const tokenAccount = await connection.getAccountInfo(
          new PublicKey(bondingCurve),
          "processed"
        );
        console.log('tokenAccount = ', tokenAccount);

        const structure = struct([
          u64("discriminator"),
          u64("virtualTokenReserves"),
          u64("virtualSolReserves"),
          u64("realTokenReserves"),
          u64("realSolReserves"),
          u64("tokenTotalSupply"),
          bool("complete"),
        ]);

        let value = structure.decode(tokenAccount!.data);
        const virtualTokenReserves = BigInt(value.virtualTokenReserves);
        const virtualSolReserves = BigInt(value.virtualSolReserves); 4
        const realTokenReserves = BigInt(value.realTokenReserves);

        console.log('virtualTokenReserves = ', virtualTokenReserves);
        console.log('virtualSolReserves = ', virtualSolReserves);
        console.log('realTokenReserves = ', realTokenReserves);

        const marketCapSol = Number(virtualSolReserves) / (Number(virtualTokenReserves) / 1000000)

        if (botBuyConfig.marketCap.enabled && (marketCapSol < botBuyConfig.marketCap.min || marketCapSol > botBuyConfig.marketCap.max)) {
          console.log('marketCapSol = ', marketCapSol);
          console.log('bot config min marketCapSol = ', botBuyConfig.marketCap.min);
          console.log('bot config max marketCapSol = ', botBuyConfig.marketCap.max);

          console.log(`outside of marketcap range, so check again after monitor cycle`);
          setTimeout(monitor, monitor_cycle);
          return;
        }

        // buy
        const jito_tip = botBuyConfig.jitoTipAmount;
        console.log('jitoTipAmount = ', jito_tip);
        const slippage = botBuyConfig.slippage;
        console.log('slippage = ', slippage);
        const buySolAmount = botBuyConfig.investmentPerToken;
        console.log('buyAmount = ', buySolAmount);
        // calcuate buy token amount
        let n = virtualSolReserves * virtualTokenReserves;
        let i = virtualSolReserves + BigInt(buySolAmount * LAMPORTS_PER_SOL);
        let r = n / i + 1n;
        let s = virtualTokenReserves - r;
        const buyTokenAmount = s < realTokenReserves ? s : realTokenReserves;
        console.log('buyTokenAmount = ', buyTokenAmount);
        const buySolAmountWithSlippage = BigInt(buySolAmount * LAMPORTS_PER_SOL) * (100n + BigInt(slippage)) / 100n;
        console.log('buySolAmountWithSlippage = ', buySolAmountWithSlippage);

        // make transaction and send 
        const associatedUser = await spl.getAssociatedTokenAddress(new PublicKey(mint), wallet.publicKey, false);

        let transaction = new Transaction();

        transaction.add(
          spl.createAssociatedTokenAccountInstruction(
            wallet.publicKey,
            associatedUser,
            wallet.publicKey,
            new PublicKey(mint)
          )
        );

        transaction.add(
          await pumpfun_program.methods
            .buy(new BN(buyTokenAmount.toString()), new BN(buySolAmountWithSlippage.toString()))
            .accounts({
              feeRecipient: new PublicKey("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM"),
              mint: new PublicKey(mint),
              associatedBondingCurve: associatedBondingCurve,
              associatedUser: associatedUser,
              user: wallet.publicKey,
            })
            .transaction()
        );

        const blockHash = await connection.getLatestBlockhash();

        let messageV0 = new TransactionMessage({
          payerKey: wallet.publicKey,
          recentBlockhash: blockHash.blockhash,
          instructions: transaction.instructions,
        }).compileToV0Message();

        const versionedTx = new VersionedTransaction(messageV0);
        versionedTx.sign([wallet]);
        const result = await sendBundle(versionedTx, wallet, blockHash, jito_tip * LAMPORTS_PER_SOL);
        if (result) {
          const txSignature = base58.encode(versionedTx.signatures[0]);
          const investSolAmount = await getSwapSolAmount(connection, txSignature);
          console.log('buy sol amount = ', investSolAmount);
          const buyPrice = (investSolAmount / LAMPORTS_PER_SOL) / (Number(buyTokenAmount) / 1000000);

          const result = await SniperTxns.findOneAndUpdate(
            { txHash: txSignature }, // Query
            { // Update documents
              $setOnInsert: {
                txHash: txSignature,
                mint,
                txTime: Date.now(),
                tokenName,
                tokenSymbol,
                tokenImage,
                swap: "BUY",
                swapPrice_usd: buyPrice,
                swapAmount: Number(buyTokenAmount) / 1000000,
                swapFee_usd: jito_tip,
                swapMC_usd: marketCapSol,
                swapProfit_usd: 0,
                swapProfitPercent_usd: 0,
                buyMC_usd: marketCapSol,
                dex: "Pumpfun",
                date: Date.now()
              }
            },
            {
              upsert: true,
              new: true,
              runValidators: true
            }
          );

          console.log('save trnasactino data = ', result);

          // sell start
          const botSellConfig = SniperBotConfig.getSellConfig();
          const sell_rules = botSellConfig.saleRules.filter((item) => {
            return item.percent > 0
          });

          let revenues = [];
          let sell_amounts = [];

          for (let i = 0; i < sell_rules.length; i++) {
            revenues[i] = sell_rules[i].revenue;
            let sell_amount = 0;
            for (let j = 0; j <= i; j++) {
              sell_amount += sell_rules[j].percent
            }
            sell_amounts[i] = sell_amount;
          }

          console.log('revenues = ', revenues);
          console.log('sell_amounts = ', sell_amounts);

          let soldAmount = 0; // 0%
          let remain_amount = Number(buyTokenAmount);

          const marketcap_change = botSellConfig.mcChange.percentValue;
          const marketcap_duration = botSellConfig.mcChange.duration;

          console.log('marketcap_change = ', marketcap_change);
          console.log('marketcap_duration = ', marketcap_duration);

          let start_time = Date.now();
          while (true) {

            const tokenAccount = await connection.getAccountInfo(
              new PublicKey(bondingCurve),
              "processed"
            );

            const structure = struct([
              u64("discriminator"),
              u64("virtualTokenReserves"),
              u64("virtualSolReserves"),
              u64("realTokenReserves"),
              u64("realSolReserves"),
              u64("tokenTotalSupply"),
              bool("complete"),
            ]);

            let value = structure.decode(tokenAccount!.data);
            const virtualTokenReserves = BigInt(value.virtualTokenReserves);
            const virtualSolReserves = BigInt(value.virtualSolReserves);

            let n = (buyTokenAmount * virtualSolReserves) / (virtualTokenReserves + buyTokenAmount);
            let a = (n * 100n) / 10000n;
            const outSolAmount = Number(n - a) / LAMPORTS_PER_SOL;
            let revenue = outSolAmount / investSolAmount * 100 - 100;
            console.log(`==========> revenue = ${revenue} %`);

            if (revenue < -90) // invalid value
              continue;

            // check marketcap change 
            const marketCapSol_now = Number(virtualSolReserves) / (Number(virtualTokenReserves) / 1000000)
            if ((marketCapSol_now / marketCapSol * 100 - 100) < marketcap_change && ((Date.now() - start_time) / 1000) > marketcap_duration) {
              console.log(`>>>>>>>>>>> marketcap not change ${marketcap_change}% for ${marketcap_duration} seconds`);
              //sell all remain tokens
              const signature = await sell(mint, BigInt(remain_amount), associatedBondingCurve, associatedUser, jito_tip);

              // save trx to db
              if (signature) {
                const solAmount = await getSwapSolAmount(connection, signature);
                const sellPrice = (Number(solAmount) / LAMPORTS_PER_SOL) / (Number(remain_amount) / 1000000)
                const swapProfit = (sellPrice - buyPrice) * (Number(remain_amount) / 1000000);
                const swapProfitPercent = swapProfit / (investSolAmount / LAMPORTS_PER_SOL) * 100;
                console.log('swapProfit = ', swapProfit);
                console.log('swapProfitPercent = ', swapProfitPercent);
                const result = await SniperTxns.findOneAndUpdate(
                  { txHash: signature }, // Query
                  { // Update document
                    $setOnInsert: {
                      txHash: signature,
                      mint,
                      txTime: Date.now(),
                      tokenName,
                      tokenSymbol,
                      tokenImage,
                      swap: "SELL",
                      swapPrice_usd: sellPrice,
                      swapAmount: Number(remain_amount) / 1000000,
                      swapFee_usd: jito_tip,
                      swapMC_usd: marketCapSol_now,
                      swapProfit_usd: swapProfit,
                      swapProfitPercent_usd: swapProfitPercent,
                      buyMC_usd: marketCapSol,
                      dex: "Pumpfun",
                      date: Date.now()
                    }
                  },
                  {
                    upsert: true,
                    new: true,
                    runValidators: true
                  }
                );
                const alertData: IAlertMsg = {
                  imageUrl: tokenImage,
                  title: tokenName,
                  content: "You just sold out this token.",
                  link: mint,
                  time: Date.now(),
                  isRead: false,
                };
                await createAlert(alertData);
                break;
              }
            }

            // stop loss
            if (revenue < (-1) * botSellConfig.lossExitPercent) {
              // sell all remain tokens
              console.log('stop loss sell');
              const signature = await sell(mint, BigInt(remain_amount), associatedBondingCurve, associatedUser, jito_tip);
              // save trx to db
              if (signature) {
                const solAmount = await getSwapSolAmount(connection, signature);
                const sellPrice = (Number(solAmount) / LAMPORTS_PER_SOL) / (Number(remain_amount) / 1000000)
                const swapProfit = (sellPrice - buyPrice) * (Number(remain_amount) / 1000000);
                const swapProfitPercent = swapProfit / (investSolAmount / LAMPORTS_PER_SOL) * 100;
                console.log('swapProfit = ', swapProfit);
                console.log('swapProfitPercent = ', swapProfitPercent);
                const result = await SniperTxns.findOneAndUpdate(
                  { txHash: signature }, // Query
                  { // Update document
                    $setOnInsert: {
                      txHash: signature,
                      mint,
                      txTime: Date.now(),
                      tokenName,
                      tokenSymbol,
                      tokenImage,
                      swap: "SELL",
                      swapPrice_usd: sellPrice,
                      swapAmount: Number(remain_amount) / 1000000,
                      swapFee_usd: jito_tip,
                      swapMC_usd: marketCapSol_now,
                      swapProfit_usd: swapProfit,
                      swapProfitPercent_usd: swapProfitPercent,
                      buyMC_usd: marketCapSol,
                      dex: "Pumpfun",
                      date: Date.now()
                    }
                  },
                  {
                    upsert: true,
                    new: true,
                    runValidators: true
                  }
                );
                const alertData: IAlertMsg = {
                  imageUrl: tokenImage,
                  title: tokenName,
                  content: "You just sold out this token.",
                  link: mint,
                  time: Date.now(),
                  isRead: false,
                };
                await createAlert(alertData);
                break;
              }
            }

            // check revenue levels
            for (let i = revenues.length - 1; i >= 0; i--) {
              if (revenue > revenues[i] && sell_amounts[i] > soldAmount) {
                let amount = 0;
                if (sell_amounts[i] == 100) {
                  amount = Number(remain_amount);
                } else {
                  amount = Math.floor(Number(buyTokenAmount) * (sell_amounts[i] - soldAmount) / 100);
                }
                console.log('sell revenue = ', sell_amounts[i]);
                const signature = await sell(mint, BigInt(amount), associatedBondingCurve, associatedUser, jito_tip);
                if (signature) {
                  const solAmount = await getSwapSolAmount(connection, signature);
                  soldAmount = sell_amounts[i];
                  remain_amount = remain_amount - amount;
                  const sellPrice = (solAmount / LAMPORTS_PER_SOL) / (Number(amount) / 1000000);
                  const swapProfit = (sellPrice - buyPrice) * (Number(amount) / 1000000);
                  const swapProfitPercent = swapProfit / (investSolAmount / LAMPORTS_PER_SOL) * 100;
                  console.log('swapProfit = ', swapProfit);
                  console.log('swapProfitPercent = ', swapProfitPercent);

                  const result = await SniperTxns.findOneAndUpdate(
                    { txHash: signature }, // Query
                    { // Update document
                      $setOnInsert: {
                        txHash: signature,
                        mint,
                        txTime: Date.now(),
                        tokenName,
                        tokenSymbol,
                        tokenImage,
                        swap: "SELL",
                        swapPrice_usd: sellPrice,
                        swapAmount: Number(amount) / 1000000,
                        swapFee_usd: jito_tip,
                        swapMC_usd: marketCapSol_now,
                        swapProfit_usd: swapProfit,
                        swapProfitPercent_usd: swapProfitPercent,
                        buyMC_usd: marketCapSol,
                        dex: "Pumpfun",
                        date: Date.now()
                      }
                    },
                    {
                      upsert: true,
                      new: true,
                      runValidators: true
                    }
                  );
                  const alertData: IAlertMsg = {
                    imageUrl: tokenImage,
                    title: tokenName,
                    content: "You just sold out this token.",
                    link: mint,
                    time: Date.now(),
                    isRead: false,
                  };
                  await createAlert(alertData);
                  break;
                }
              }
            }

            if (soldAmount == 100) {
              console.log('all token sold');
              break;
            }
            await sleep(500);
          }
          processing = false;
        } else {
          processing = false;
          return;
        }
      }
      monitor();
    } catch (error) {
      if (error) {
      }
      processing = false;
    }
  });

  // Send subscribe request
  await new Promise<void>((resolve, reject) => {
    stream.write(args, (err: any) => {
      if (err === null || err === undefined) {
        resolve();
      } else {
        reject(err);
      }
    });
  }).catch((reason) => {
    console.error(reason);
    throw reason;
  });

  await streamClosed;
}

async function subscribeCommand(client: Client, args: SubscribeRequest) {
  while (true) {
    try {
      await handleStream(client, args);
    } catch (error) {
      console.error("Stream error, restarting in 1 second...", error);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

export const sniperService = () => {
  const client = new Client(
    process.env.GRPC_URL || '',
    process.env.X_TOKEN || '',
    undefined,
  );

  const req = {
    accounts: {},
    slots: {},
    transactions: {
      pumpfun: {
        vote: false,
        failed: false,
        signature: undefined,
        accountInclude: [pumpfun],
        accountExclude: [],
        accountRequired: [],
      },
    },
    transactionsStatus: {},
    entry: {},
    blocks: {},
    blocksMeta: {},
    accountsDataSlice: [],
    ping: undefined,
    commitment: CommitmentLevel.PROCESSED,
  };

  subscribeCommand(client, req);
}

const jito_Validators = [
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
];
async function getRandomValidator() {
  const res =
    jito_Validators[Math.floor(Math.random() * jito_Validators.length)];
  return new PublicKey(res);
}

export async function sendBundle(
  transaction: VersionedTransaction,
  payer: Keypair,
  lastestBlockhash: BlockhashWithExpiryBlockHeight,
  jitofee: number
) {
  try {
    const jito_validator_wallet = await getRandomValidator();
    const jitoFee_message = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: lastestBlockhash.blockhash,
      instructions: [
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: jito_validator_wallet,
          lamports: jitofee,
        }),
      ],
    }).compileToV0Message();

    const jitoFee_transaction = new VersionedTransaction(jitoFee_message);
    jitoFee_transaction.sign([payer]);

    const serializedJitoFeeTransaction = base58.encode(jitoFee_transaction.serialize());
    const serializedTransaction = base58.encode(transaction.serialize());

    const { data } = await axios.post('https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles', {
      jsonrpc: "2.0",
      id: 1,
      method: "sendBundle",
      params: [[
        serializedJitoFeeTransaction,
        serializedTransaction,
      ]],
    })
    let bundleIds: any = [];
    if (data) {
      bundleIds = [
        data.result
      ];
    }

    console.log("Checking bundle's status...", bundleIds);
    const sentTime = Date.now();
    let confirmed = false;
    while (Date.now() - sentTime < 10000) {

      try {
        const { data } = await axios.post(`https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles`,
          {
            jsonrpc: "2.0",
            id: 1,
            method: "getBundleStatuses",
            params: [
              bundleIds
            ],
          },
          {
            headers: {
              "Content-Type": "application/json",
            },
          }
        );

        if (data) {
          const bundleStatuses = data.result.value;
          console.log("Bundle Statuses:", bundleStatuses);
          let success = true;

          for (let i = 0; i < bundleIds.length; i++) {
            const matched = bundleStatuses.find((item: any) => item && item.bundle_id === bundleIds[i]);
            if (!matched || matched.confirmation_status !== "confirmed") { // finalized
              success = false;
              break;
            }
          }

          if (success) {
            confirmed = true;
            break;
          }
        }
      } catch (err) {
        // console.log("JITO ERROR");
        break;
      }
      await sleep(1000);
    }
    return confirmed;
  } catch (e) {
    if (e instanceof axios.AxiosError) {
      console.log("Failed to execute the jito transaction");
    } else {
      console.log("Error during jito transaction execution");
    }
    return false;
  }
}

export const sell = async (mint: string, sell_amount: bigint, associatedBondingCurve: PublicKey, associatedUser: PublicKey, jito_tip: number) => {
  let transaction = new Transaction();
  transaction.add(
    await pumpfun_program.methods
      .sell(new BN(sell_amount.toString()), new BN(0))
      .accounts({
        feeRecipient: new PublicKey("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM"),
        mint: new PublicKey(mint),
        associatedBondingCurve: associatedBondingCurve,
        associatedUser: associatedUser,
        user: wallet.publicKey,
      })
      .transaction()
  );

  const blockHash = await connection.getLatestBlockhash();

  let messageV0 = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockHash.blockhash,
    instructions: transaction.instructions,
  }).compileToV0Message();

  const versionedTx = new VersionedTransaction(messageV0);
  versionedTx.sign([wallet]);
  // const result = await connection.simulateTransaction(versionedTx);
  const result = await sendBundle(versionedTx, wallet, blockHash, jito_tip * LAMPORTS_PER_SOL);
  if (result) {
    console.log('sell sucess');
    const txSignature = base58.encode(versionedTx.signatures[0]);
    return txSignature;
  } else {
    console.log('sell failed');
    return null;
  }
}

export const getSwapSolAmount = async (connection: Connection, signature: string) => {
  try {
    let tx: any;
    let i = 0;
    let retry = 100;
    while (i < retry) {
      console.log(`[getSwapSolAmount] parse transaction : ${signature}`);
      tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
      if (tx != null && tx != undefined)
        break;
      await sleep(100);
      i++;
    }
    const deltaBalances = tx.meta.postBalances.map((item: number, index: number) => {
      return item - tx.meta.preBalances[index]
    })
    const filter = deltaBalances.filter((item: number) => {
      return item != 0
    })
    return Math.abs(filter[filter.length - 1]);
  } catch (error) {
    console.log('getSwapSolAmount Error: ', error);
    return 0;
  }
}
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));