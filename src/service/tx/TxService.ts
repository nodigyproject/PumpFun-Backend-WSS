import { IAlertMsg, ITxntmpData } from "../../utils/types";
import { SniperTxns } from "../../models/SniperTxns";
import logger from "../../logs/logger";
import { TokenAnalysis } from "../assets/tokenAnalysisService";
import { TOTAL_SUPPLY } from "../../utils/constants";
import { sniperService } from "../sniper/sniperService";
import { createAlert } from "../alarm/alarm";
import mongoose from "mongoose";

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

// First, create an in-memory transaction cache at module level
const processedTransactions = new Set<string>();


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

  // In-memory check first (fastest)
  if (txHash && processedTransactions.has(txHash)) {
    logger.warn(`[🚫 MEMORY-DUPLICATE] ${shortMint} | Transaction ${shortTx} already processed in memory, skipping DB operation`);
    return null;
  }

  try {
    // Database check
    if (txHash) {
      const existingTransaction = await SniperTxns.findOne({ txHash });
      
      if (existingTransaction) {
        logger.warn(`[⚠️ DB-DUPLICATE] ${shortMint} | Transaction ${shortTx} already exists in database, skipping save`);
        // Add to memory cache to prevent future attempts
        processedTransactions.add(txHash);
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

    // SOLUTION: Remove transaction and use direct findOneAndUpdate with upsert
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
        // Remove writeConcern - that was causing the error
      }
    );

    if (result) {
      // Add to memory cache
      if (txHash) processedTransactions.add(txHash);
      
      logger.info(`[💾 DB-SAVED] ${shortMint} | Transaction ${shortTx} saved successfully`);
      TokenAnalysis.updateCacheFromTransaction(result);
      
      // Create alert if needed
      if (isAlert) {
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
    }
    
    return result;
  } catch (err: unknown) {
    // Type handling for errors
    const error = err as any;
    
    // Check for duplicate key error
    if (error && error.code === 11000) {
      logger.warn(`[⚠️ DB-DUPLICATE-ERROR] ${shortMint} | Duplicate key error for ${shortTx}`);
      // Add to memory cache to prevent future attempts
      if (txHash) processedTransactions.add(txHash);
      // Try to fetch and return the existing transaction
      return await SniperTxns.findOne({ txHash });
    }
    
    logger.error(`[❌ DB-ERROR] ${shortMint} | Error saving transaction: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
};

// Add periodic cleanup for the in-memory cache (optional)
setInterval(() => {
  // Keep the set from growing indefinitely - clear older entries
  // This assumes you don't need to remember transactions older than 1 hour
  if (processedTransactions.size > 1000) {
    logger.info(`[🧹 CACHE-CLEANUP] Clearing in-memory transaction cache (size: ${processedTransactions.size})`);
    processedTransactions.clear();
  }
}, 3600000); // Clean up once per hour