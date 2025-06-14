import WebSocket from "ws";
import { WSS_URL } from "../../config";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";

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
        try {

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

                console.log(`-------------> instructions: `, instructions);

                // const accountKeys = messageObj.params.result.transaction.transaction.message.accountKeys;

                // console.log(`-------------> accountKeys: `, accountKeys);

                const devBuySol = (messageObj.params.result.transaction.meta.preBalances[0] - messageObj.params.result.transaction.meta.postBalances[0]) / LAMPORTS_PER_SOL;

                console.log('-------------> Dev Buy Sol Amount= ', devBuySol);

                const buyInstruction = instructions[instructions.length];

                console.log('-------------> Buy Instructions = ', buyInstruction);

                const poolAccountKeys = buyInstruction.accounts;

                console.log('-------------> poolAccountKeys = ', poolAccountKeys);

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
