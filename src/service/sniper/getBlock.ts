import { BlockhashWithExpiryBlockHeight, PublicKey } from "@solana/web3.js";
import { config, connection } from "../../config";
import logger from "../../logs/logger";

let latestBlockhash: BlockhashWithExpiryBlockHeight;

// setInterval(async () => {
//   try {
//     latestBlockhash = await connection.getLatestBlockhash();
//   } catch (error: any) {
//     logger.error("getLatestBlockhash Interval error:" + error.message);
//   }
// }, config.lastBlock_Update_cycle);

// export function getLatestBlockhash(): BlockhashWithExpiryBlockHeight {
//   return latestBlockhash;
// }