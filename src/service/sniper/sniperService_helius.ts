import WebSocket from "ws";
import { WSS_URL } from "../../config";

export let WS = new WebSocket(WSS_URL);

export const sniperService = (ws: WebSocket) => {

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
                    WS = new WebSocket(WSS_URL);
                    sniperService(WS);
                    return;
                }

                console.log('-------------> messageObj: ', messageObj);

                const signature = messageObj.params.result.signature;

                console.log(`-------------> new detect, signature: ${signature}`);

                const instructions = messageObj.params.result.transaction.transaction.message.instructions;
                // const addLiquidityInstruction = instructions.filter((instruction: any) => {
                //     if (instruction.programId == RAYDIUM_CPMM_PROGRAM_ID)
                //         return true;
                //     else
                //         return false;
                // })[0];
                // const poolAccountKeys = addLiquidityInstruction.accounts;
            }
        } catch (e) {
            console.error('WebSocket message handle error :', e);
        }
    });

    ws.on('error', function error(err) {

    });

    ws.on('close', function close() {
        console.log('WebSocket is closed');
        WS = new WebSocket(WSS_URL);
        sniperService(WS);
    });

}

function startPing(ws: WebSocket) {
    setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.ping();
        }
    }, 30000);
}
