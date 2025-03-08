import { Router } from "express";
import logger from "../../logs/logger";
import { config, wallet } from "../../config";
import { ITransaction, SniperTxns } from "../../models/SniperTxns";
import { getCachedSolPrice } from "../../service/sniper/getBlock";
import {
  ITokenAnalysisData,
} from "../../utils/types";
import {
  getCalculatedTableData,
  getSolBananceFromWallet,
  getTokenDataforAssets,
  getTotalTokenDataforAssets,
  getWalletTokens,
} from "../../service/assets/assets";
import {
  getTokenBalance,
} from "../../service/pumpfun/pumpfun";
import { sellTokenSwap, sleepTime } from "../../utils/utils";
import { AlertService } from "../../models/Alert";
import { TokenAnalysis } from "../../service/assets/tokenAnalysisService";
import jwt from "jsonwebtoken";


const router = Router();

router.get("/", async (req, res) => {
  try {
    // assets/?limit=10&offset=0&sort_field=total_invested&sort_order=desc
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const search = (req.query.search as string) || "";
    const sortField = (req.query.sort_field as string) || "";
    const sortOrder = (req.query.sort_order as string) || "desc";
    const show_zero = req.query.show_zero === "true";

    const totalData: ITokenAnalysisData[] = await getTotalTokenDataforAssets();

    const zeroData = !show_zero
      ? totalData
      : totalData.filter((item) => Number(item.currentAmount) > 0);

    const filteredData = search
      ? zeroData.filter(
          (item) =>
            item.tokenName?.toLowerCase().includes(search.toLowerCase()) ||
            item.tokenSymbol?.toLowerCase().includes(search.toLowerCase()) ||
            item.mint.toLowerCase().includes(search.toLowerCase())
        )
      : zeroData;

    const sortedData =
      sortField !== ""
        ? [...filteredData].sort((a, b) => {
            let aValue, bValue;
            if (sortField === "age") {
              aValue = a.tokenCreateTime;
              bValue = b.tokenCreateTime;
            } else if (sortField === "marketCap") {
              aValue = a.currentMC_usd;
              bValue = b.currentMC_usd;
            } else if (sortField === "price") {
              aValue = a.currentPrice_usd;
              bValue = b.currentPrice_usd;
            } else if (sortField === "total_invested") {
              aValue = a.investedAmount;
              bValue = b.investedAmount;
            } else if (sortField === "pnl") {
              aValue = a.pnl.percent;
              bValue = b.pnl.percent;
            } else if (sortField === "holding") {
              aValue = a.currentAmount || 0;
              bValue = b.currentAmount || 0;
            } else if (sortField === "selling_step") {
              aValue = a.sellingStep || 0;
              bValue = b.sellingStep || 0;
            } else if (sortField === "real_profit") {
              aValue = a.realisedProfit || 0;
              bValue = b.realisedProfit || 0;
            }
            if (sortOrder === "desc") {
              return (bValue || 0) - (aValue || 0);
            }
            return (aValue || 0) - (bValue || 0);
          })
        : [...filteredData].sort((a, b) => {
            // Sort by created_timestamp in default
            let aValue, bValue;
            aValue = a.tokenCreateTime || 0;
            bValue = b.tokenCreateTime || 0;
            return bValue - aValue;
          });
    // Apply pagination
    const paginatedData = sortedData.slice(offset, offset + limit);

    const calcTable = getCalculatedTableData(totalData);

    res.json({
      calcTable: calcTable,
      data: paginatedData,
      total: zeroData.length,
      offset,
      limit,
    });
  } catch (error: any) {
    logger.error(`[GET] assets/ Error fetching assets data: ${error.message}`);
    res.status(500).json({ message: "Error fetching assets data" });
  }
});

router.get("/wallet", async (req, res) => {
  try {
    const solBalance = await getSolBananceFromWallet(wallet);
    const solPice = getCachedSolPrice();
    res.json({
      walletBal: solBalance,
      solPrice: solPice,
    });
  } catch (error: any) {
    logger.error(
      `[GET] assets/wallet  Error fetching assets data: ${error.message}`
    );
    res.status(500).json({ message: "Error fetching assets data" });
  }
});

router.post("/selltoken", async (req, res) => {
  try {
    const { mint } = req.body;
    logger.info("manual sell token " + mint);
    const currentAmount = await getTokenBalance(
      wallet.publicKey.toBase58(),
      mint
    );
    if (currentAmount === 0)
      return res.status(400).json({ message: "no token to sell" });

    const txHash = await sellTokenSwap(mint, currentAmount, true, false);
    if(txHash) {
      res.status(200).json({
        status: "successfully sold.",
      });
    } else {
      res.status(400).json({ message: "sell failed" });
    }
  } catch (error: any) {
    logger.error(
      `[GET] assets/selltoken Error fetching assets data: ${error.message}`
    );
    res.status(500).json({ message: "Error fetching assets data" });
  }
});

router.post("/sellall", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ message: "`The request is not authorized" });
    }
    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, config.jwtSecret) as { email: string };
    const request_user = decoded.email;

    const tokens = await getWalletTokens(wallet.publicKey);
    logger.info(`[POST] /sellall from ${request_user}. ` + tokens.length);

    const BATCH_SIZE = 5;
    let rlt:(string|null)[] = [];
    for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
      const tokenBatch = tokens.slice(i, i + BATCH_SIZE);
      const tmp = await Promise.all(
        tokenBatch.map((token) =>
          sellTokenSwap(token.mint, token.amount, true, true)
        )
      );
      rlt.push(...tmp);
      await sleepTime(100);
    }


    if (rlt.includes(null)) {
      logger.info("[sellall]"  + " sell all failed");
      return res.status(400).json({ message: "sell all failed." });
    }
    await SniperTxns.collection.drop();
    await AlertService.collection.drop();
    console.log(("[sellall] successfully"))
    TokenAnalysis.clearCache();
    res.status(200).json({
      status: "successfully sold.",
    });
  } catch (error: any) {
    logger.error(
      `[GET] assets/sellall Error fetching assets data: ${error.message}`
    );
    res.status(500).json({ message: "Error fetching assets data" });
  }
});

router.get("/:mint", async (req, res) => {
  try {
    const { mint } = req.params;
    const tokenData = await getTokenDataforAssets(mint);
    if(!tokenData) {
      return res.status(400).json({ message: "no token data" });
    }
    const txData: ITransaction[] = await SniperTxns.find({ mint: mint }).sort({
      txTime: -1,
    });

    return res.status(200).json({
      success: true,
      data: {
        tokenData,
        txData,
      },
    });
  } catch (error) {
    logger.error(`Error fetching token data: ${error}`);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

export default router;
