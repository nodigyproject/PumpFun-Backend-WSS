import WebSocket from "ws";
import { wallet, WSS_URL } from "../../config";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import axios from "axios";
import { isRunning, isWorkingTime } from "../../utils/utils";
import { getWalletBalanceFromCache } from "./getWalletBalance";
import logger from "../../logs/logger";
import { IAlertMsg } from "../../utils/types";
import { PUMPFUN_IMG } from "../../utils/constants";
import { createAlert } from "../alarm/alarm";
import { SniperBotConfig } from "../setting/botConfigClass";

let lastProcessTime = 0;
const MIN_TOKEN_PROCESS_INTERVAL = 5000;

export const sniperService = () => {

    console.log('----------------> sniperService --------------->');

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

                console.log(`-------------> new detect, signature: ${signature}`);

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

                const devBuySol = (messageObj.params.result.transaction.meta.preBalances[0] - messageObj.params.result.transaction.meta.postBalances[0]) / LAMPORTS_PER_SOL;

                console.log('-------------> Dev Buy Sol Amount= ', devBuySol);

                const createPoolInstruction = pumpfunInstructions[0];

                console.log('-------------> Create Pool Instructions = ', createPoolInstruction);

                const { tokenName, tokenSymbol, tokenImage } = await getMetaData(createPoolInstruction.data);

                const buyInstruction = pumpfunInstructions[pumpfunInstructions.length - 1];

                console.log('-------------> Buy Instructions = ', buyInstruction);

                const poolAccountKeys = buyInstruction.accounts;

                console.log('-------------> poolAccountKeys = ', poolAccountKeys);

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

                const creatorVault = poolAccountKeys[9];

                console.log('-------------> createValult: ', creatorVault);

                const event = poolAccountKeys[10];

                console.log('-------------> Event: ', event);



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

    console.log('tokenName: ', tokenName);

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
    console.log('tokenSymbol: ', tokenSymbol);

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
    console.log('metaDataLink: ', metaDataLink);

    const response = await axios.get("https://ipfs.io/ipfs/QmRF9SoNRyPUMtEy2e2z1Eu9VFVtyHbnXH4qkiPAqxtwzF", {
        headers: {
            "User-Agent": "curl/7.68.0",
            Accept: "*/*",
        }
    });

    tokenImage = response.data.image;

    console.log('tokenImage: ', tokenImage);

    return {
        tokenName,
        tokenSymbol,
        tokenImage
    }
}