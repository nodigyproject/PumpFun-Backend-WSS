import WebSocket from "ws";
import { connection, wallet, WSS_URL } from "../../config";
import { LAMPORTS_PER_SOL, PublicKey, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import axios from "axios";
import { getDexscreenerData, isRunning, isWorkingTime } from "../../utils/utils";
import { getWalletBalanceFromCache } from "./getWalletBalance";
import logger from "../../logs/logger";
import { IAlertMsg } from "../../utils/types";
import { EVENT_AUTHORITY, PUMP_FUN_PROGRAM, PUMPFUN_IMG } from "../../utils/constants";
import { createAlert } from "../alarm/alarm";
import { SniperBotConfig } from "../setting/botConfigClass";
import { DBTokenList, IToken } from "../../models/TokenList";
import { bufferFromUInt64, getBondingCurveStatus, getSwapSolAmount, jito_executeAndConfirm, jupiterSwap, sell, sleep } from "./sniperService_grpc";
import * as spl from "@solana/spl-token";
import { SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@raydium-io/raydium-sdk";
import base58 from "bs58";
import { SniperTxns } from "../../models/SniperTxns";

let lastProcessTime = 0;
const MIN_TOKEN_PROCESS_INTERVAL = 5000;

export const sniperService = () => {

    console.log(`${Date.now()}----------------> sniperService --------------->`);

    const ws = new WebSocket(WSS_URL);

    ws.on('open', async function open() {
        console.log('----------------------> WebSocket is open');

        const request = {
            jsonrpc: "2.0",
            id: 'pumpfun_detect',
            method: "transactionSubscribe",
            params: [
                {
                    failed: false,
                    accountInclude: ["TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM"]
                },
                {
                    commitment: "processed",
                    encoding: "jsonParsed",
                    transactionDetails: "full",
                    maxSupportedTransactionVersion: 0
                }
            ]
        };

        ws.send(JSON.stringify(request));
        startPing(ws);

    });

    ws.on('message', async function incoming(data) {

        const messageStr = data.toString('utf8');

        const now = Date.now();
        if (now - lastProcessTime < MIN_TOKEN_PROCESS_INTERVAL) {
            return;
        }
        lastProcessTime = now;

        /////////////// check if bot running is enabled
        if (!isRunning()) {
            // console.log('Bot is not running.');
            return;
        }

        /////////////// check if bot is in working time
        if (!isWorkingTime()) {
            // console.log('Bot is not in working time.');
            return;
        }

        try {

            /////////////// check if wallet has enough balance
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

            const messageObj = JSON.parse(messageStr);

            if (messageObj.method == "transactionNotification") {

                if (messageObj.params.error) {
                    console.error('---------------> WebSocket transactionSubscribe error. so recreate websocket');
                    sniperService();
                    return;
                }

                // console.log('-------------> transaction: ', messageObj.params.result.transaction);

                const signature = messageObj.params.result.signature;

                console.log(`New detect, signature: ${signature}`);

                const devBuySol = (messageObj.params.result.transaction.meta.preBalances[0] - messageObj.params.result.transaction.meta.postBalances[0]) / LAMPORTS_PER_SOL;

                console.log('-------------> Dev Buy Sol Amount= ', devBuySol);

                /////////////////////// check  if sol amount of dev buy is smaller than setting value
                const devBuySetting = SniperBotConfig.getMaxDevBuyAmount();

                if (devBuySetting.enabled && devBuySol > devBuySetting.value) {
                    return;
                }

                const instructions = messageObj.params.result.transaction.transaction.message.instructions;

                // console.log(`-------------> instructions: `, instructions);

                const pumpfunInstructions = instructions.filter((instruction: any) => {
                    if (instruction.programId === '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P')
                        return true;
                    else
                        return false;
                })

                // const accountKeys = messageObj.params.result.transaction.transaction.message.accountKeys;

                // console.log(`-------------> accountKeys: `, accountKeys);

                const createPoolInstruction = pumpfunInstructions[0];

                // console.log('-------------> Create Pool Instructions = ', createPoolInstruction);

                /////////////////////// check if token symbol is already existed.
                const { tokenName, tokenSymbol, tokenImage } = await getMetaData(createPoolInstruction.data);

                if (SniperBotConfig.getBuyConfig().duplicates.enabled === true) {
                    const duplicateToken = await DBTokenList.findOne({
                        tokenSymbol: tokenSymbol,
                    });
                    if (duplicateToken) {
                        console.log(`duplicated token symbol ${tokenSymbol}`);
                        return;
                    }
                }

                const buyInstruction = pumpfunInstructions[pumpfunInstructions.length - 1];

                // console.log('-------------> Buy Instructions = ', buyInstruction);

                const poolAccountKeys = buyInstruction.accounts;

                // console.log('-------------> poolAccountKeys = ', poolAccountKeys);

                const global = poolAccountKeys[0];

                console.log('-------------> global: ', global);

                const feeRecipient = poolAccountKeys[1];

                console.log('-------------> feeRecipient: ', feeRecipient);

                const mint = poolAccountKeys[2];

                console.log('-------------> mint: ', mint);

                const bondingCurve = poolAccountKeys[3];

                console.log('-------------> bondingCurve: ', bondingCurve);

                const associatedBondingCurve = poolAccountKeys[4];

                console.log('-------------> associatedBondingCurve: ', associatedBondingCurve);

                const dev = poolAccountKeys[6];

                console.log('-------------> dev: ', dev);

                const creatorVault = poolAccountKeys[9];

                console.log('-------------> createValult: ', creatorVault);

                const event = poolAccountKeys[10];

                console.log('-------------> Event: ', event);

                // save token to db
                if (tokenName && tokenSymbol && tokenImage) {
                    try {
                        const tokenData: Partial<IToken> = {
                            mint,
                            tokenName,
                            tokenSymbol,
                            tokenImage,
                            saveTime: Date.now(),
                        };
                        const newToken = new DBTokenList(tokenData);
                        newToken.save();
                    } catch (error) {
                        console.error(`[${mint}] save token data failed. error:  ${error}`);
                    }
                }

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

                        /////////////////////////// check if max dev holding amount is smaller than setting
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

                        ///////////////////////// check txns and volumes
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

                        //////////////////////// check market cap
                        let retry = 3;
                        let bondingCurveStatus: any;

                        while (retry > 0) {
                            console.log(`bondingCurve: ${bondingCurve}, getBondingCureStatus: retry count: ${retry}`);
                            bondingCurveStatus = await getBondingCurveStatus(connection, new PublicKey(bondingCurve));
                            console.log(`bondingCurve: ${bondingCurve}, bondingCurveStatus: `, bondingCurveStatus);
                            if (bondingCurveStatus) {
                                break;
                            }
                            await sleep(500);
                            retry--;
                        }

                        if (bondingCurveStatus == null) {
                            console.log(`bondingCurve: ${bondingCurve}, getBondingCurveStatus failed.`)
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
                        console.log('jitoTipAmount = ', jito_tip);
                        const slippage = botBuyConfig.slippage;
                        console.log('slippage = ', slippage);
                        const buySolAmount = botBuyConfig.investmentPerToken;
                        console.log('buyAmount = ', buySolAmount);

                        // Calcuate buy token amount
                        let n = bondingCurveStatus.virtualSolReserves * bondingCurveStatus.virtualTokenReserves;
                        let i = bondingCurveStatus.virtualSolReserves + BigInt(buySolAmount * LAMPORTS_PER_SOL);
                        let r = n / i;
                        let s = bondingCurveStatus.virtualTokenReserves - r;
                        const buyTokenAmount = s < bondingCurveStatus.realTokenReserves ? s : bondingCurveStatus.realTokenReserves;
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

                        const keys = [
                            { pubkey: new PublicKey(global), isSigner: false, isWritable: false },
                            { pubkey: new PublicKey(feeRecipient), isSigner: false, isWritable: true },
                            { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
                            { pubkey: new PublicKey(bondingCurve), isSigner: false, isWritable: true },
                            { pubkey: new PublicKey(associatedBondingCurve), isSigner: false, isWritable: true },
                            { pubkey: associatedUser, isSigner: false, isWritable: true },
                            { pubkey: wallet.publicKey, isSigner: false, isWritable: true },
                            { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
                            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                            { pubkey: new PublicKey(creatorVault), isSigner: false, isWritable: true },
                            { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
                            { pubkey: PUMP_FUN_PROGRAM, isSigner: false, isWritable: false }
                        ];

                        const data = Buffer.concat([bufferFromUInt64('16927863322537952870'), bufferFromUInt64(Number(buyTokenAmount)), bufferFromUInt64(Number(buySolAmountWithSlippage))]);
                        const instruction = new TransactionInstruction({
                            keys: keys,
                            programId: PUMP_FUN_PROGRAM,
                            data: data
                        });
                        transaction.add(instruction);

                        const blockHash = await connection.getLatestBlockhash();
                        // const blockHash = getLatestBlockhash();

                        let messageV0 = new TransactionMessage({
                            payerKey: wallet.publicKey,
                            recentBlockhash: blockHash.blockhash,
                            instructions: transaction.instructions,
                        }).compileToV0Message();

                        const versionedTx = new VersionedTransaction(messageV0);
                        versionedTx.sign([wallet]);

                        const simulation = await connection.simulateTransaction(versionedTx);

                        if (simulation.value.err) {
                            console.log(`[${mint}] buy simulation error, result: `, simulation);
                            return;
                        }

                        const { confirmed, signature } = await jito_executeAndConfirm(versionedTx, wallet, blockHash, jito_tip * LAMPORTS_PER_SOL);

                        console.log('buy success');

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
                                            // const signature = await sell(mint, BigInt(remain_amount), associatedBondingCurve, associatedUser, jito_tip * LAMPORTS_PER_SOL);
                                            let transaction = new Transaction();

                                            const keys = [
                                                { pubkey: new PublicKey(global), isSigner: false, isWritable: false },
                                                { pubkey: new PublicKey(feeRecipient), isSigner: false, isWritable: true },
                                                { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
                                                { pubkey: new PublicKey(bondingCurve), isSigner: false, isWritable: true },
                                                { pubkey: new PublicKey(associatedBondingCurve), isSigner: false, isWritable: true },
                                                { pubkey: associatedUser, isSigner: false, isWritable: true },
                                                { pubkey: wallet.publicKey, isSigner: false, isWritable: true },
                                                { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
                                                { pubkey: new PublicKey(creatorVault), isSigner: false, isWritable: true },
                                                { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                                                { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
                                                { pubkey: PUMP_FUN_PROGRAM, isSigner: false, isWritable: false }
                                            ];

                                            const data = Buffer.concat([bufferFromUInt64('12502976635542562355'), bufferFromUInt64(remain_amount), bufferFromUInt64(0)]);
                                            const instruction = new TransactionInstruction({
                                                keys: keys,
                                                programId: PUMP_FUN_PROGRAM,
                                                data: data
                                            });

                                            transaction.add(instruction);

                                            const closeIns = spl.createCloseAccountInstruction(associatedUser, wallet.publicKey, wallet.publicKey);

                                            transaction.add(closeIns);

                                            const blockHash = await connection.getLatestBlockhash();
                                            // const blockHash = getLatestBlockhash();

                                            let messageV0 = new TransactionMessage({
                                                payerKey: wallet.publicKey,
                                                recentBlockhash: blockHash.blockhash,
                                                instructions: transaction.instructions,
                                            }).compileToV0Message();

                                            const versionedTx = new VersionedTransaction(messageV0);
                                            versionedTx.sign([wallet]);

                                            const simulation = await connection.simulateTransaction(versionedTx);

                                            if (simulation.value.err) {
                                                console.log(`[${mint}] sell simulation error, result: `, simulation);
                                                // continue;
                                                break;
                                            }

                                            const { confirmed, signature } = await jito_executeAndConfirm(versionedTx, wallet, blockHash, jito_tip * LAMPORTS_PER_SOL);
                                            // save trx to db
                                            if (confirmed && signature) {
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

                                            // const signature = await sell(mint, BigInt(remain_amount), associatedBondingCurve, associatedUser, jito_tip * LAMPORTS_PER_SOL);
                                            let transaction = new Transaction();

                                            const keys = [
                                                { pubkey: new PublicKey(global), isSigner: false, isWritable: false },
                                                { pubkey: new PublicKey(feeRecipient), isSigner: false, isWritable: true },
                                                { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
                                                { pubkey: new PublicKey(bondingCurve), isSigner: false, isWritable: true },
                                                { pubkey: new PublicKey(associatedBondingCurve), isSigner: false, isWritable: true },
                                                { pubkey: associatedUser, isSigner: false, isWritable: true },
                                                { pubkey: wallet.publicKey, isSigner: false, isWritable: true },
                                                { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
                                                { pubkey: new PublicKey(creatorVault), isSigner: false, isWritable: true },
                                                { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                                                { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
                                                { pubkey: PUMP_FUN_PROGRAM, isSigner: false, isWritable: false }
                                            ];

                                            const data = Buffer.concat([bufferFromUInt64('12502976635542562355'), bufferFromUInt64(remain_amount), bufferFromUInt64(0)]);
                                            const instruction = new TransactionInstruction({
                                                keys: keys,
                                                programId: PUMP_FUN_PROGRAM,
                                                data: data
                                            });

                                            transaction.add(instruction);

                                            const closeIns = spl.createCloseAccountInstruction(associatedUser, wallet.publicKey, wallet.publicKey);

                                            transaction.add(closeIns);

                                            const blockHash = await connection.getLatestBlockhash();
                                            // const blockHash = getLatestBlockhash();

                                            let messageV0 = new TransactionMessage({
                                                payerKey: wallet.publicKey,
                                                recentBlockhash: blockHash.blockhash,
                                                instructions: transaction.instructions,
                                            }).compileToV0Message();

                                            const versionedTx = new VersionedTransaction(messageV0);
                                            versionedTx.sign([wallet]);

                                            const simulation = await connection.simulateTransaction(versionedTx);

                                            if (simulation.value.err) {
                                                console.log(`[${mint}] sell simulation error, result: `, simulation);
                                                break;
                                                // continue;
                                            }

                                            const { confirmed, signature } = await jito_executeAndConfirm(versionedTx, wallet, blockHash, jito_tip * LAMPORTS_PER_SOL);

                                            if (confirmed && signature) {

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
                                                let closeATA = false;
                                                if (sell_amounts[i] == 100) {
                                                    amount = Number(remain_amount);
                                                } else {
                                                    amount = Math.floor(Number(buyTokenAmount) * (sell_amounts[i] - soldAmount) / 100);
                                                }
                                                if (amount == Number(remain_amount))
                                                    closeATA = true;
                                                // console.log('sell revenue = ', sell_amounts[i]);

                                                // const signature = await sell(mint, BigInt(amount), associatedBondingCurve, associatedUser, jito_tip * LAMPORTS_PER_SOL);
                                                let transaction = new Transaction();

                                                const keys = [
                                                    { pubkey: new PublicKey(global), isSigner: false, isWritable: false },
                                                    { pubkey: new PublicKey(feeRecipient), isSigner: false, isWritable: true },
                                                    { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
                                                    { pubkey: new PublicKey(bondingCurve), isSigner: false, isWritable: true },
                                                    { pubkey: new PublicKey(associatedBondingCurve), isSigner: false, isWritable: true },
                                                    { pubkey: associatedUser, isSigner: false, isWritable: true },
                                                    { pubkey: wallet.publicKey, isSigner: false, isWritable: true },
                                                    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
                                                    { pubkey: new PublicKey(creatorVault), isSigner: false, isWritable: true },
                                                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                                                    { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
                                                    { pubkey: PUMP_FUN_PROGRAM, isSigner: false, isWritable: false }
                                                ];

                                                const data = Buffer.concat([bufferFromUInt64('12502976635542562355'), bufferFromUInt64(remain_amount), bufferFromUInt64(0)]);
                                                const instruction = new TransactionInstruction({
                                                    keys: keys,
                                                    programId: PUMP_FUN_PROGRAM,
                                                    data: data
                                                });

                                                transaction.add(instruction);

                                                if (closeATA) {
                                                    const closeIns = spl.createCloseAccountInstruction(associatedUser, wallet.publicKey, wallet.publicKey);

                                                    transaction.add(closeIns);
                                                }

                                                const blockHash = await connection.getLatestBlockhash();
                                                // const blockHash = getLatestBlockhash();

                                                let messageV0 = new TransactionMessage({
                                                    payerKey: wallet.publicKey,
                                                    recentBlockhash: blockHash.blockhash,
                                                    instructions: transaction.instructions,
                                                }).compileToV0Message();

                                                const versionedTx = new VersionedTransaction(messageV0);
                                                versionedTx.sign([wallet]);

                                                const simulation = await connection.simulateTransaction(versionedTx);

                                                if (simulation.value.err) {
                                                    console.log(`[${mint}] sell simulation error, result: `, simulation);
                                                    break;
                                                }

                                                const { confirmed, signature } = await jito_executeAndConfirm(versionedTx, wallet, blockHash, jito_tip * LAMPORTS_PER_SOL);

                                                if (confirmed && signature) {

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

            }
        } catch (e) {
            console.error('------------------> WebSocket message handle error :', e);
        }
    });

    ws.on('error', function error(err) {

    });

    ws.on('close', function close() {
        console.log('-------------------> WebSocket is closed');
        sniperService();
    });

}

function startPing(ws: WebSocket) {
    setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.ping();
        }
    }, 30000);
}

const getMetaData = async (data: any) => {
    let tokenName = '';
    let tokenSymbol = '';
    let tokenImage = '';
    let metaDataLink = '';

    const bytedata = bs58.decode(data);
    let byteArray = bytedata.slice(8, 12);
    let tokenNameLength = 0;

    for (let i = 0; i < byteArray.length; i++) {
        tokenNameLength += byteArray[i] * (256 ** i)
    }

    // console.log('tokenName length: ', tokenNameLength);

    byteArray = bytedata.slice(12, 12 + tokenNameLength);

    for (let i = 0; i < byteArray.length; i++) {
        tokenName += String.fromCharCode(byteArray[i]);
    }

    console.log('-------------> tokenName: ', tokenName);

    ///////////////

    let tokenSymbolLength = 0;

    byteArray = bytedata.slice(12 + tokenNameLength, 16 + tokenNameLength);

    for (let i = 0; i < byteArray.length; i++) {
        tokenSymbolLength += byteArray[i] * (256 ** i)
    }
    // console.log('tokenSymbol length: ', tokenNameLength);

    byteArray = bytedata.slice(16 + tokenNameLength, 16 + tokenNameLength + tokenSymbolLength);

    for (let i = 0; i < byteArray.length; i++) {
        tokenSymbol += String.fromCharCode(byteArray[i]);
    }
    console.log('-------------> tokenSymbol: ', tokenSymbol);

    ///////////////
    let metaDataLinkLength = 0;

    byteArray = bytedata.slice(16 + tokenNameLength + tokenSymbolLength, 20 + tokenNameLength + tokenSymbolLength);

    for (let i = 0; i < byteArray.length; i++) {
        metaDataLinkLength += byteArray[i] * (256 ** i)
    }
    // console.log('metaDataLink length: ', metaDataLinkLength);

    byteArray = bytedata.slice(20 + tokenNameLength + tokenSymbolLength, 20 + tokenNameLength + tokenSymbolLength + metaDataLinkLength);

    for (let i = 0; i < byteArray.length; i++) {
        metaDataLink += String.fromCharCode(byteArray[i]);
    }
    // console.log('-------------> metaDataLink: ', metaDataLink);

    const response = await axios.get(metaDataLink, {
        headers: {
            "User-Agent": "curl/7.68.0",
            Accept: "*/*",
        }
    });

    tokenImage = response.data.image;

    console.log('-------------> tokenImage: ', tokenImage);

    return {
        tokenName,
        tokenSymbol,
        tokenImage
    }
}