import { PublicKey } from "@solana/web3.js";
import { getWalletTokens } from "./service/assets/assets";
import { getBondingCurveStatus } from "./service/sniper/sniperService_grpc";
import { connection } from "./config";

const test = async () => {
    console.log('-------------- test -------------');
    const data = await getBondingCurveStatus(connection, new PublicKey("HmsVaSu62JHjDxtihzQ9ZKRp4E3X9mRkK3z2rvCityP"));
    console.log('data: ', data);
}

test();