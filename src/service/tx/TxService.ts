import { IAlertMsg, ITxntmpData } from "../../utils/types";
import { SniperTxns } from "../../models/SniperTxns";
import logger from "../../logs/logger";
import { TokenAnalysis } from "../assets/tokenAnalysisService";
import { TOTAL_SUPPLY } from "../../utils/constants";
import { sniperService } from "../sniper/sniperService";
import { createAlert } from "../alarm/alarm";
import { IToken, DBTokenList } from "../../models/TokenList";
// import { io } from "../..";

// Get all transactions
export const getAllTransactions = async () => {
  return await SniperTxns.find().sort({ date: -1 });
};

// Get transactions by wallet
export const getTransactionsByCA = async (mint: string) => {
  try {
    const transactions = await SniperTxns.aggregate([
      { $match: { mint: mint, swap: "BUY" } },
      { $sort: { date: -1 } },
    ]);
    return (
      transactions[0] || {
        tokenName: "",
        tokenSymbol: "",
        tokenImage: "",
        txTime: 0,
        swapMC_usd: 0,
        total_supply: 0,
      }
    );
  } catch (error) {
    logger.error("getTransactionsByCA error" + error);
    return [];
  }
};

// Get transactions by type (BUY/SELL)
export const getTransactionsByType = async (swap: "BUY" | "SELL") => {
  return await SniperTxns.find({ swap }).sort({ date: -1 });
};

export async function fetchTokenData(mint: string): Promise<any> {
  try {
    
    const buyTxn = await SniperTxns.findOne({ mint, swap: "BUY" });
    if (buyTxn) {
      return {
        name: buyTxn.tokenName,
        symbol: buyTxn.tokenSymbol,
        image_uri: buyTxn.tokenImage,
        usd_market_cap: buyTxn.swapMC_usd,
        buyMC_usd: buyTxn.swapMC_usd,
      };
    }
    const tmpdata = await fetch(`https://frontend-api.pump.fun/coins/${mint}`);
    const data = await tmpdata.json();
    
    const tokenData = await DBTokenList.findOne({ mint });
    if (!data.name || !data.symbol || !data.usd_market_cap) {
      return {
        name: "UNKNOWN",
        symbol: "UNKNOWN",
        image_uri: "UNKNOWN",
        usd_market_cap: 0,
        buyMC_usd: 0,
      };
    } 
    return {
      name: tokenData?.tokenName,
      symbol: tokenData?.tokenSymbol,
      image_uri: tokenData?.tokenImage,
      usd_market_cap: 0,
      buyMC_usd: 0,
    };
  } catch (error) {
    return {
      name: "UNKNOWN",
      symbol: "UNKNOWN",
      image_uri: "",
      usd_market_cap: 0,
    };
  }
}

export const saveTXonDB = async (save_data: ITxntmpData) => {
  const {
    isAlert,
    txHash,
    mint,
    swap,
    swapPrice_usd,
    swapAmount,
    swapFee_usd,
    swapProfit_usd,
    swapProfitPercent_usd,
    dex,
  } = save_data;

  const shortMint = mint.slice(0, 8) + '...';
  const shortTx = txHash ? txHash.slice(0, 8) + '...' : 'unknown';

  try {
    // Explicit check for existing transaction - this is more reliable than depending on the unique index
    if (txHash) {
      const existingTransaction = await SniperTxns.findOne({ txHash: txHash });
      
      if (existingTransaction) {
        logger.warn(`[⚠️ DB-DUPLICATE] ${shortMint} | Transaction ${shortTx} already exists in database, skipping save`);
        return existingTransaction;
      }
      
      logger.info(`[✅ DB-UNIQUE] ${shortMint} | Transaction ${shortTx} is unique, proceeding with save`);
    }
    
    // Continue with normal save process
    const data = await fetchTokenData(mint);
    const tokenName = data.name || "UNKNOWN";
    const tokenSymbol = data.symbol || "UNKNOWN";
    const tokenImage = data.image_uri || "UNKNOWN";
    const buyMC_usd = data.buyMC_usd || 0;

    // Use findOneAndUpdate with upsert for atomic operation (prevents race conditions)
    const result = await SniperTxns.findOneAndUpdate(
      { txHash }, // Query
      { // Update document
        $setOnInsert: {
          txHash,
          mint,
          txTime: Date.now(),
          tokenName,
          tokenSymbol,
          tokenImage,
          swap,
          swapPrice_usd: Number(swapPrice_usd),
          swapAmount: Number(swapAmount),
          swapFee_usd: Number(swapFee_usd),
          swapMC_usd: Number(swapPrice_usd * TOTAL_SUPPLY),
          swapProfit_usd: Number(swapProfit_usd),
          swapProfitPercent_usd: Number(swapProfitPercent_usd),
          buyMC_usd: Number(buyMC_usd),
          dex,
          date: Date.now()
        }
      },
      { 
        upsert: true, // Create if doesn't exist
        new: true, // Return the updated document
        runValidators: true // Run schema validators
      }
    );

    const isNewRecord = !result?.date || result?.date === Date.now();
    
    if (isNewRecord) {
      logger.info(`[💾 DB-SAVED] ${shortMint} | Transaction ${shortTx} saved successfully`);
      TokenAnalysis.updateCacheFromTransaction(result);
    } else {
      logger.info(`[⚠️ DB-EXISTING] ${shortMint} | Transaction ${shortTx} already existed, returned existing record`);
    }

    // Create alert if needed
    if (isAlert && isNewRecord) {
      try {
        const alertData: IAlertMsg = {
          imageUrl: tokenImage,
          title: tokenName,
          content: "You just sold out this token.",
          link: mint,
          time: Date.now(),
          isRead: false,
        };
        await createAlert(alertData);
      } catch (error) {
        logger.error(`[❌ ALERT-ERROR] Error creating alert: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    
    return result;
    
  } catch (error) {
    // Log specific details for duplicate key errors
    if (error.name === 'MongoError' && error.code === 11000) {
      logger.warn(`[⚠️ DB-DUPLICATE-ERROR] ${shortMint} | Duplicate key error for ${shortTx}`);
      // Try to fetch and return the existing transaction
      const existingTx = await SniperTxns.findOne({ txHash });
      return existingTx;
    }
    
    logger.error(`[❌ DB-ERROR] ${shortMint} | Error saving transaction: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
};
