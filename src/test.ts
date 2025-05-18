import { PublicKey } from "@solana/web3.js";
import { getWalletTokens } from "./service/assets/assets";

const test = async () => {
    console.log('-------------- test -------------');
    const tokens = await getWalletTokens(new PublicKey("Cy3NwXiNovRZgm4PsE9uB14p8Wpe1FkM59FswgxzjrRD"));
    console.log('tokens: ', tokens);
}

test();