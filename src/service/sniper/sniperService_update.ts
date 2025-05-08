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
import { getLatestBlockhash } from "./getBlock";

dotenv.config();

const pumpfun = 'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM';
const provider = new AnchorProvider(connection, new NodeWallet(new Keypair()), {
  commitment: "processed",
});

export const pumpfun_program = new Program<PumpFun>(IDL as PumpFun, provider);

let lastProcessTime = 0;
const MIN_TOKEN_PROCESS_INTERVAL = 1000;

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

      const now = Date.now();
      if (now - lastProcessTime < MIN_TOKEN_PROCESS_INTERVAL) {
        return;
      }
      lastProcessTime = now;

      // 1. check bot running status
      if (!isRunning()) {
        console.log('Bot is not running.');
        return;
      }

      // 2. check bot working time
      if (!isWorkingTime()) {
        console.log('Bot is not in working time.');
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
        return;
      }

      const result = tOutPut(data);
      const mint = result.meta.postTokenBalances[0].mint;
      // console.log(`New Token : `, mint);
      // const signature = result.signature;
      // console.log('signature = ', signature);
      const dev = result.message.accountKeys[0];
      // console.log('Dev wallet : ', dev);
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

        try {
          const botBuyConfig = SniperBotConfig.getBuyConfig();

          // 1. check token age
          let min_age = 0;
          let max_age = 60; // default 30 seconds

          if (botBuyConfig.age.enabled) {
            min_age = botBuyConfig.age.start;
            max_age = botBuyConfig.age.end;
          }

          let age = (Date.now() - create_time) / 1000;

          if (age < min_age) {
            setTimeout(monitor, monitor_cycle); // token is too young, so check again after monitor cycle
            console.log(`[${mint}] is too young, Min Age: ${min_age}`);
            return;
          }

          if (age > max_age) {
            console.log(`[${mint}] is too old, Max Age: ${max_age}`);
            return;
          }

          // 3. check max dev holding amount
          if (botBuyConfig.maxDevHoldingAmount.enabled) {
            let ata = spl.getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(dev));
            const balance = await connection.getTokenAccountBalance(ata, "processed");
            const devHoldingPercent = Number(balance.value.uiAmount) / 10000000;
            if (devHoldingPercent > botBuyConfig.maxDevHoldingAmount.value) {
              console.log(`[${mint}] Dev Holding Amount: ${devHoldingPercent} %. Max Setting: ${botBuyConfig.maxDevHoldingAmount.value}%`);
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
              // console.log('volume = ', volume);
              // console.log('txns = ', txns);

              if (botBuyConfig.lastHourVolume.enabled && volume < botBuyConfig.lastHourVolume.value) {
                console.log(`[${mint}] 1 hour Volumes: ${volume}. Min Setting Volumes: ${botBuyConfig.lastHourVolume.value}`);
                setTimeout(monitor, monitor_cycle);
                return;
              }

              if (botBuyConfig.lastMinuteTxns.enabled && txns < botBuyConfig.lastMinuteTxns.value) {
                console.log(`[${mint}] 1 hour Txns: ${txns}, Min Setting Transactions: ${botBuyConfig.lastMinuteTxns.value}`);
                setTimeout(monitor, monitor_cycle);
                return;
              }

            }
          }

          // 2. check market cap
          const bondingCurveStatus = await getBondingCurveStatus(connection, new PublicKey(bondingCurve));
          if (!bondingCurveStatus) {
            console.log(`[${mint}] getBondingCurveStatus Failed. Skip!`);
            return;
          }

          const marketCapSol = Number(bondingCurveStatus.virtualSolReserves) / (Number(bondingCurveStatus.virtualTokenReserves) / 1000000)

          if (botBuyConfig.marketCap.enabled && (marketCapSol < botBuyConfig.marketCap.min || marketCapSol > botBuyConfig.marketCap.max)) {
            console.log(`[${mint}] Outside of allowed MarketCap Range. Current MC: ${marketCapSol} SOL, Min MC: ${botBuyConfig.marketCap.min} SOL, Max MC: ${botBuyConfig.marketCap.max}`);
            setTimeout(monitor, monitor_cycle);
            return;
          }

          // buy
          const jito_tip = botBuyConfig.jitoTipAmount;
          // console.log('jitoTipAmount = ', jito_tip);
          const slippage = botBuyConfig.slippage;
          // console.log('slippage = ', slippage);
          const buySolAmount = botBuyConfig.investmentPerToken;
          // console.log('buyAmount = ', buySolAmount);

          // Calcuate buy token amount
          let n = bondingCurveStatus.virtualSolReserves * bondingCurveStatus.virtualTokenReserves;
          let i = bondingCurveStatus.virtualSolReserves + BigInt(buySolAmount * LAMPORTS_PER_SOL);
          let r = n / i + 1n;
          let s = bondingCurveStatus.virtualTokenReserves - r;
          const buyTokenAmount = s < bondingCurveStatus.realTokenReserves ? s : bondingCurveStatus.realTokenReserves;
          // console.log('buyTokenAmount = ', buyTokenAmount);

          const buySolAmountWithSlippage = BigInt(buySolAmount * LAMPORTS_PER_SOL) * (100n + BigInt(slippage)) / 100n;
          // console.log('buySolAmountWithSlippage = ', buySolAmountWithSlippage);

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

          // const blockHash = await connection.getLatestBlockhash();
          const blockHash = getLatestBlockhash();

          let messageV0 = new TransactionMessage({
            payerKey: wallet.publicKey,
            recentBlockhash: blockHash.blockhash,
            instructions: transaction.instructions,
          }).compileToV0Message();

          const versionedTx = new VersionedTransaction(messageV0);
          versionedTx.sign([wallet]);

          // const result = await sendBundle(versionedTx, wallet, blockHash, jito_tip * LAMPORTS_PER_SOL);

          const { confirmed, signature } = await jito_executeAndConfirm(versionedTx, wallet, blockHash, jito_tip * LAMPORTS_PER_SOL);

          if (confirmed) {
            const txSignature = base58.encode(versionedTx.signatures[0]);
            const investSolAmount = await getSwapSolAmount(connection, txSignature);
            if (investSolAmount == 0) {
              console.log(`[${mint}] Buy Failed`);
              return;
            }
            console.log(`[${mint}] Buy Amount: ${investSolAmount / LAMPORTS_PER_SOL} SOL`);
            const buyPrice = (investSolAmount / LAMPORTS_PER_SOL) / (Number(buyTokenAmount) / 1000000);

            const result = await SniperTxns.findOneAndUpdate(
              { txHash: signature }, // Query
              { // Update documents
                $setOnInsert: {
                  txHash: signature,
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
                  date: Date.now(),
                  sellReason: ""
                }
              },
              {
                upsert: true,
                new: true,
                runValidators: true
              }
            );

            console.log(`[${mint}] Save Buy Transaction: ${result}`);

            // Sell start
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

            // console.log('revenues = ', revenues);
            // console.log('sell_amounts = ', sell_amounts);

            let soldAmount = 0; // 0%
            let remain_amount = Number(buyTokenAmount);

            const marketcap_change = botSellConfig.mcChange.percentValue;
            const marketcap_duration = botSellConfig.mcChange.duration;

            // console.log('marketcap_change = ', marketcap_change);
            // console.log('marketcap_duration = ', marketcap_duration);

            /////////// check profit of bought token //////////////

            let start_time = Date.now();

            while (true) {
              try {

                const currentStatus = await getBondingCurveStatus(connection, new PublicKey(bondingCurve));

                console.log(`[${mint}] currentStatus: `, currentStatus);

                if (!currentStatus) {
                  console.log(`[${mint}] Sell Monitoring getBondingCurveStatus Error, Retry`);
                  await sleep(500);
                  continue;
                }

                ///////////// Not migrated. So that Check Revenue on Pumpfun ///////////////
                if (!currentStatus.completed) {

                  let n = (buyTokenAmount * currentStatus.virtualSolReserves) / (currentStatus.virtualTokenReserves + buyTokenAmount);
                  let a = (n * 100n) / 10000n;
                  const outSolAmount = Number(n - a);

                  let revenue = outSolAmount / investSolAmount * 100 - 100;
                  console.log(`[${mint}] Revenue: ${revenue} %`);

                  // check marketcap change 
                  const marketCapSol_now = Number(currentStatus.virtualSolReserves) / (Number(currentStatus.virtualTokenReserves) / 1000000)

                  if ((marketCapSol_now / marketCapSol * 100 - 100) < marketcap_change && ((Date.now() - start_time) / 1000) > marketcap_duration) {

                    console.log(`[${mint}] MarketCap Not Change ${marketcap_change}% for ${marketcap_duration} seconds, So Selling ...`);

                    //sell all remain tokens
                    const signature = await sell(mint, BigInt(remain_amount), associatedBondingCurve, associatedUser, jito_tip * LAMPORTS_PER_SOL);

                    // save trx to db
                    if (signature) {
                      const solAmount = await getSwapSolAmount(connection, signature);
                      if (solAmount == 0) {
                        console.log(`[${mint}] MC Not Change Selling Failed.`);
                      } else {
                        console.log(`[${mint}] MC Not Change Selling Success.`)
                        const sellPrice = (Number(solAmount) / LAMPORTS_PER_SOL) / (Number(remain_amount) / 1000000)
                        const swapProfit = (sellPrice - buyPrice) * (Number(remain_amount) / 1000000);
                        const swapProfitPercent = swapProfit / (investSolAmount / LAMPORTS_PER_SOL) * 100;
                        // console.log('swapProfit = ', swapProfit);
                        // console.log('swapProfitPercent = ', swapProfitPercent);

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
                              date: Date.now(),
                              sellReason: "duration"
                            }
                          },
                          {
                            upsert: true,
                            new: true,
                            runValidators: true
                          }
                        );

                        console.log(`[${mint}] Save Sell Transaction: ${result}`);

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
                    } else {
                      console.log(`[${mint}] MC Not Change Selling Failed.`);
                    }
                  }

                  // Check Stop Loss
                  if (revenue < (-1) * botSellConfig.lossExitPercent) {
                    // sell all remain tokens
                    console.log(`[${mint}] Stop Loss Selling ... Current Revenue: ${revenue}%, StopLoss Setting: ${botSellConfig.lossExitPercent}%`);

                    const signature = await sell(mint, BigInt(remain_amount), associatedBondingCurve, associatedUser, jito_tip * LAMPORTS_PER_SOL);

                    if (signature) {

                      const solAmount = await getSwapSolAmount(connection, signature);

                      if (solAmount == 0) {
                        console.log(`[${mint}] Stop Loss Selling Failed.`);
                      } else {
                        console.log(`[${mint}] Stop Loss Selling Success.`);
                        const sellPrice = (Number(solAmount) / LAMPORTS_PER_SOL) / (Number(remain_amount) / 1000000)
                        const swapProfit = (sellPrice - buyPrice) * (Number(remain_amount) / 1000000);
                        const swapProfitPercent = swapProfit / (investSolAmount / LAMPORTS_PER_SOL) * 100;
                        // console.log('swapProfit = ', swapProfit);
                        // console.log('swapProfitPercent = ', swapProfitPercent);
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
                              date: Date.now(),
                              sellReason: "loss"
                            }
                          },
                          {
                            upsert: true,
                            new: true,
                            runValidators: true
                          }
                        );
                        console.log(`[${mint}] Save Stop Loss Selling Transaction: ${result}`);

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
                    } else {
                      console.log(`[${mint}] Stop Loss Selling Failed.`);
                    }
                  }

                  // check revenue levels
                  for (let i = revenues.length - 1; i >= 0; i--) {
                    if (revenue > revenues[i] && sell_amounts[i] > soldAmount) {
                      console.log(`[${mint}] Reached Revenue Step ${i + 1}. Selling ${sell_amounts[i] - soldAmount}% ...`);
                      let amount = 0;
                      if (sell_amounts[i] == 100) {
                        amount = Number(remain_amount);
                      } else {
                        amount = Math.floor(Number(buyTokenAmount) * (sell_amounts[i] - soldAmount) / 100);
                      }
                      // console.log('sell revenue = ', sell_amounts[i]);

                      const signature = await sell(mint, BigInt(amount), associatedBondingCurve, associatedUser, jito_tip * LAMPORTS_PER_SOL);

                      if (signature) {

                        const solAmount = await getSwapSolAmount(connection, signature);

                        if (solAmount == 0) {
                          console.log(`[${mint}] Revenue Selling Failed.`);
                        } else {
                          console.log(`[${mint}] Revenue Selling Success.`);

                          soldAmount = sell_amounts[i];
                          remain_amount = remain_amount - amount;
                          const sellPrice = (solAmount / LAMPORTS_PER_SOL) / (Number(amount) / 1000000);
                          const swapProfit = (sellPrice - buyPrice) * (Number(amount) / 1000000);
                          const swapProfitPercent = swapProfit / (investSolAmount / LAMPORTS_PER_SOL) * 100;
                          // console.log('swapProfit = ', swapProfit);
                          // console.log('swapProfitPercent = ', swapProfitPercent);

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
                                date: Date.now(),
                                sellReason: `step ${i + 1}`
                              }
                            },
                            {
                              upsert: true,
                              new: true,
                              runValidators: true
                            }
                          );

                          console.log(`[${mint}] Save Revenue Selling Transaction: ${result}`);

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
                      } else {
                        console.log(`[${mint}] Revenue Selling Failed.`);
                      }
                    }
                  }

                  if (soldAmount == 100) {
                    console.log(`[${mint}] All Position Sold.`);
                    break;
                  }

                  await sleep(500);
                }
                ///////////// Migrated to Pumpswap. So that Check Revenue on Pumpswap /////////////
                else {
                  //////// Calculate Revenue using Jupiter API //////////////
                  const quoteResponse = await (
                    await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=${mint}&outputMint=So11111111111111111111111111111111111111112&amount=${buyTokenAmount}`
                    )
                  ).json();
                  console.log(`[${mint}] pumpSwap quoteResponse: `, quoteResponse);

                  if (!quoteResponse) {
                    await sleep(1000);
                    continue;
                  }
                  const outSolAmount = Number(quoteResponse.outAmount);
                  let revenue = outSolAmount / investSolAmount * 100 - 100;
                  console.log(`[${mint}] Revenue: ${revenue} %`);

                  ///////////// Calulate MarketCap in SOL ///////////////////
                  const response = await (
                    await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=${mint}&outputMint=So11111111111111111111111111111111111111112&amount=1000000`
                    )
                  ).json();
                  const marketCapSol_now = Number(response.outAmount);
                  console.log(`[${mint}] MarketCap in SOL : ${marketCapSol_now}`);

                  // Check Stop Loss
                  if (revenue < (-1) * botSellConfig.lossExitPercent) {
                    // sell all remain tokens
                    console.log(`[${mint}] Stop Loss Selling ... Current Revenue: ${revenue}%, StopLoss Setting: ${botSellConfig.lossExitPercent}%`);
                    /////////////// Sell By Jupiter //////////////
                    const signature = await jupiterSwap(mint, spl.NATIVE_MINT.toBase58(), remain_amount, jito_tip * LAMPORTS_PER_SOL);
                    if (signature) {
                      const solAmount = await getSwapSolAmount(connection, signature);
                      if (solAmount == 0) {
                        console.log(`[${mint}] Stop Loss Selling Failed.`);
                      } else {
                        console.log(`[${mint}] Stop Loss Selling Success.`);
                        const sellPrice = (Number(solAmount) / LAMPORTS_PER_SOL) / (Number(remain_amount) / 1000000)
                        const swapProfit = (sellPrice - buyPrice) * (Number(remain_amount) / 1000000);
                        const swapProfitPercent = swapProfit / (investSolAmount / LAMPORTS_PER_SOL) * 100;
                        // console.log('swapProfit = ', swapProfit);
                        // console.log('swapProfitPercent = ', swapProfitPercent);
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
                              dex: "Pumpfun Amm",
                              date: Date.now(),
                              sellReason: "loss"
                            }
                          },
                          {
                            upsert: true,
                            new: true,
                            runValidators: true
                          }
                        );
                        console.log(`[${mint}] Save Stop Loss Selling Transaction: ${result}`);

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
                    } else {
                      console.log(`[${mint}] Stop Loss Selling Failed.`);
                    }
                  }

                  // check revenue levels
                  for (let i = revenues.length - 1; i >= 0; i--) {
                    if (revenue > revenues[i] && sell_amounts[i] > soldAmount) {
                      console.log(`[${mint}] Reached Revenue Step ${i + 1}. Selling ${sell_amounts[i] - soldAmount}% ...`);
                      let amount = 0;
                      if (sell_amounts[i] == 100) {
                        amount = Number(remain_amount);
                      } else {
                        amount = Math.floor(Number(buyTokenAmount) * (sell_amounts[i] - soldAmount) / 100);
                      }
                      // console.log('sell revenue = ', sell_amounts[i]);
                      /////////////// sell by jupiter ////////////////
                      const signature = await jupiterSwap(mint, spl.NATIVE_MINT.toBase58(), amount, jito_tip * LAMPORTS_PER_SOL);
                      if (signature) {
                        const solAmount = await getSwapSolAmount(connection, signature);
                        if (solAmount == 0) {
                          console.log(`[${mint}] Revenue Selling Failed.`);
                        } else {
                          console.log(`[${mint}] Revenue Selling Success. Out SOL Amount: ${solAmount}`);
                          soldAmount = sell_amounts[i];
                          remain_amount = remain_amount - amount;
                          const sellPrice = (solAmount / LAMPORTS_PER_SOL) / (Number(amount) / 1000000);
                          const swapProfit = (sellPrice - buyPrice) * (Number(amount) / 1000000);
                          const swapProfitPercent = swapProfit / (investSolAmount / LAMPORTS_PER_SOL) * 100;
                          // console.log('swapProfit = ', swapProfit);
                          // console.log('swapProfitPercent = ', swapProfitPercent);

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
                                dex: "Pumpfun Amm",
                                date: Date.now(),
                                sellReason: `step ${i + 1}`
                              }
                            },
                            {
                              upsert: true,
                              new: true,
                              runValidators: true
                            }
                          );

                          console.log(`[${mint}] Save Revenue Selling Transaction: ${result}`);

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
                      } else {
                        console.log(`[${mint}] Revenue Selling Failed.`);
                      }
                    }
                  }

                  if (soldAmount == 100) {
                    console.log(`[${mint}] All Position Sold.`);
                    break;
                  }

                  await sleep(500);
                }
              } catch (error) {
                console.log(`[${mint}] Token Monitor Module Error: ${error}`);
                break;
              }
            } ///////// while end
          } else {
            console.log(`[${mint}] Buy Failed`);
            return;
          }
        } catch (error) {
          console.log('[monitor] error: ', error);
          return;
        }
      }

      monitor();

    } catch (error) {
      if (error) {
      }
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

const getBondingCurveStatus = async (connection: Connection, bondingCurve: PublicKey) => {
  try {
    const tokenAccount = await connection.getAccountInfo(
      bondingCurve,
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
    const realSolReserves = BigInt(value.realSolReserves);
    const realTokenReserves = BigInt(value.realTokenReserves);
    const completed = BigInt(value.complete);

    return { completed, realSolReserves, realTokenReserves, virtualSolReserves, virtualTokenReserves };

  } catch (error) {
    console.log(`getBondingCurveStatus Error: ${error}`);
    return null;
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

const endpoints = [
  "https://mainnet.block-engine.jito.wtf/api/v1/bundles",
  "https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles",
  "https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles",
  "https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles",
  "https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles",
];

async function getRandomValidator() {
  const res =
    jito_Validators[Math.floor(Math.random() * jito_Validators.length)];
  return new PublicKey(res);
}

export async function jito_executeAndConfirm(
  transaction: VersionedTransaction,
  payer: Keypair,
  lastestBlockhash: BlockhashWithExpiryBlockHeight,
  jitofee: number
) {
  console.log("Executing transaction (jito)...");
  const jito_validator_wallet = await getRandomValidator();
  console.log("Selected Jito Validator: ", jito_validator_wallet.toBase58());
  try {
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
    const jitoTxSignature = base58.encode(jitoFee_transaction.signatures[0]);
    const serializedJitoFeeTransaction = base58.encode(
      jitoFee_transaction.serialize()
    );
    const serializedTransaction = base58.encode(transaction.serialize());
    const final_transaction = [
      serializedJitoFeeTransaction,
      serializedTransaction,
    ];
    const requests = endpoints.map((url) =>
      axios.post(url, {
        jsonrpc: "2.0",
        id: 1,
        method: "sendBundle",
        params: [final_transaction],
      })
    );
    console.log("Sending tx to Jito validators...");
    const res = await Promise.all(requests.map((p) => p.catch((e: any) => e)));
    const success_res = res.filter((r: any) => !(r instanceof Error));
    if (success_res.length > 0) {
      console.log("Jito validator accepted the tx");
      return await jito_confirm(jitoTxSignature, lastestBlockhash);
    } else {
      console.log("No Jito validators accepted the tx");
      return { confirmed: false, signature: jitoTxSignature };
    }
  } catch (e) {
    if (e instanceof axios.AxiosError) {
      console.log("Failed to execute the jito transaction");
    } else {
      console.log("Error during jito transaction execution: ", e);
    }
    return { confirmed: false, signature: null };
  }
}

async function jito_confirm(signature: string, latestBlockhash: BlockhashWithExpiryBlockHeight) {
  console.log("Confirming the jito transaction...");
  const confirmation = await connection.confirmTransaction(
    {
      signature,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      blockhash: latestBlockhash.blockhash,
    },
    "confirmed"
  );
  return { confirmed: !confirmation.value.err, signature };
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

  // const blockHash = await connection.getLatestBlockhash();
  const latestBlockhash = getLatestBlockhash();

  let messageV0 = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: latestBlockhash.blockhash,
    instructions: transaction.instructions,
  }).compileToV0Message();

  const versionedTx = new VersionedTransaction(messageV0);
  versionedTx.sign([wallet]);

  const simulation = await connection.simulateTransaction(versionedTx);

  if (simulation.value.err) {
    console.log(`[${mint}] Sell Simulation failed: `, simulation);
    return null;
  }

  const result = await jito_executeAndConfirm(versionedTx, wallet, latestBlockhash, jito_tip);

  if (result.confirmed) {
    const signature = base58.encode(versionedTx.signatures[0]);
    return signature;
  } else {
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

export const jupiterSwap = async (inputMint: string, outMint: string, inputAmount: number, jitoTip: number) => {
  const quoteResponse = await (
    await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outMint}&amount=${inputAmount}`
    )
  ).json();
  if (!quoteResponse)
    return null;
  const { swapTransaction } = await (
    await fetch('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey: wallet.publicKey.toString(),
        wrapAndUnwrapSol: true,
        // prioritizationFeeLamports: 10000000
      })
    })
  ).json();

  // deserialize the transaction
  const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
  var trx = VersionedTransaction.deserialize(swapTransactionBuf);
  // sign the transaction
  trx.sign([wallet]);
  const txSignature = base58.encode(trx.signatures[0]);
  const latestBlockHash = getLatestBlockhash();
  const result = await jito_executeAndConfirm(trx, wallet, latestBlockHash, jitoTip);
  if (result.confirmed) {
    return txSignature;
  } else {
    return null;
  }
}