import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAccount,
  getAssociatedTokenAddress,
  RawAccount,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { Liquidity, LiquidityPoolKeysV4, LiquidityStateV4, Percent, Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { MarketCache, PoolCache, SnipeListCache } from './cache';
import { PoolFilters } from './filters';
import { TransactionExecutor } from './transactions';
import { createPoolKeys, logger, NETWORK, sleep } from './helpers';
import { Mutex } from 'async-mutex';
import BN from 'bn.js';
import { WarpTransactionExecutor } from './transactions/warp-transaction-executor';
import { JitoTransactionExecutor } from './transactions/jito-rpc-transaction-executor';

interface TrailingStopData {
  highestPrice: TokenAmount;
  currentStopLoss: TokenAmount;
}

export interface BotConfig {
  wallet: Keypair;
  checkRenounced: boolean;
  checkFreezable: boolean;
  checkBurned: boolean;
  minPoolSize: TokenAmount;
  maxPoolSize: TokenAmount;
  quoteToken: Token;
  quoteAmount: TokenAmount;
  quoteAta: PublicKey;
  oneTokenAtATime: boolean;
  useSnipeList: boolean;
  autoSell: boolean;
  autoBuyDelay: number;
  autoSellDelay: number;
  maxBuyRetries: number;
  maxSellRetries: number;
  unitLimit: number;
  unitPrice: number;
  takeProfit: number;
  stopLoss: number;
  useTrailingStop: boolean;
  buySlippage: number;
  sellSlippage: number;
  priceCheckInterval: number;
  priceCheckDuration: number;
  filterCheckInterval: number;
  filterCheckDuration: number;
  consecutiveMatchCount: number;
  }


export class Bot {
  private readonly poolFilters: PoolFilters;

  // snipe list
  private readonly snipeListCache?: SnipeListCache;

  // one token at the time
  private readonly mutex: Mutex;
  private sellExecutionCount = 0;
  public readonly isWarp: boolean = false;
  public readonly isJito: boolean = false;
  private readonly trailingStops: Map<string, TrailingStopData> = new Map();

  constructor(
    private readonly connection: Connection,
    private readonly marketStorage: MarketCache,
    private readonly poolStorage: PoolCache,
    private readonly txExecutor: TransactionExecutor,
    readonly config: BotConfig,
  ) {
    this.isWarp = txExecutor instanceof WarpTransactionExecutor;
    this.isJito = txExecutor instanceof JitoTransactionExecutor;

    this.mutex = new Mutex();
    this.poolFilters = new PoolFilters(connection, {
      quoteToken: this.config.quoteToken,
      minPoolSize: this.config.minPoolSize,
      maxPoolSize: this.config.maxPoolSize,
    });

    if (this.config.useSnipeList) {
      this.snipeListCache = new SnipeListCache();
      this.snipeListCache.init();
    }
  }

  async validate() {
    try {
      await getAccount(this.connection, this.config.quoteAta, this.connection.commitment);
    } catch (error) {
      logger.error(
        `${this.config.quoteToken.symbol} token account not found in wallet: ${this.config.wallet.publicKey.toString()}`,
      );
      return false;
    }

    return true;
  }

  public async buy(accountId: PublicKey, poolState: LiquidityStateV4) {
    logger.trace({ mint: poolState.baseMint }, `Processing new pool...`);

    if (this.config.useSnipeList && !this.snipeListCache?.isInList(poolState.baseMint.toString())) {
      logger.debug({ mint: poolState.baseMint.toString() }, `Skipping buy because token is not in a snipe list`);
      return;
    }

    if (this.config.autoBuyDelay > 0) {
      logger.debug({ mint: poolState.baseMint }, `Waiting for ${this.config.autoBuyDelay} ms before buy`);
      await sleep(this.config.autoBuyDelay);
    }

    if (this.config.oneTokenAtATime) {
      if (this.mutex.isLocked() || this.sellExecutionCount > 0) {
        logger.debug(
          { mint: poolState.baseMint.toString() },
          `Skipping buy because one token at a time is turned on and token is already being processed`,
        );
        return;
      }

      await this.mutex.acquire();
    }

    try {
      const [market, mintAta] = await Promise.all([
        this.marketStorage.get(poolState.marketId.toString()),
        getAssociatedTokenAddress(poolState.baseMint, this.config.wallet.publicKey),
      ]);
      const poolKeys: LiquidityPoolKeysV4 = createPoolKeys(accountId, poolState, market);

      if (!this.config.useSnipeList) {
        const match = await this.filterMatch(poolKeys);

        if (!match) {
          logger.trace({ mint: poolKeys.baseMint.toString() }, `Skipping buy because pool doesn't match filters`);
          return;
        }
      }

      for (let i = 0; i < this.config.maxBuyRetries; i++) {
        try {
          logger.info(
            { mint: poolState.baseMint.toString() },
            `Send buy transaction attempt: ${i + 1}/${this.config.maxBuyRetries}`,
          );
          const tokenOut = new Token(TOKEN_PROGRAM_ID, poolKeys.baseMint, poolKeys.baseDecimals);
          const result = await this.swap(
            poolKeys,
            this.config.quoteAta,
            mintAta,
            this.config.quoteToken,
            tokenOut,
            this.config.quoteAmount,
            this.config.buySlippage,
            this.config.wallet,
            'buy',
          );

          if (result.confirmed) {
            logger.info(
              {
                mint: poolState.baseMint.toString(),
                signature: result.signature,
                url: `https://solscan.io/tx/${result.signature}?cluster=${NETWORK}`,
              },
              `Confirmed buy tx`,
            );

            break;
          }

          logger.info(
            {
              mint: poolState.baseMint.toString(),
              signature: result.signature,
              error: result.error,
            },
            `Error confirming buy tx`,
          );
        } catch (error) {
          logger.debug({ mint: poolState.baseMint.toString(), error }, `Error confirming buy transaction`);
        }
      }
    } catch (error) {
      logger.error({ mint: poolState.baseMint.toString(), error }, `Failed to buy token`);
    } finally {
      if (this.config.oneTokenAtATime) {
        this.mutex.release();
      }
    }
  }

  public async sell(accountId: PublicKey, rawAccount: RawAccount) {
    if (this.config.oneTokenAtATime) {
      this.sellExecutionCount++;
    }

    try {
      logger.trace({ mint: rawAccount.mint }, `Processing new token...`);

      const poolData = await this.poolStorage.get(rawAccount.mint.toString());

      if (!poolData) {
        logger.trace({ mint: rawAccount.mint.toString() }, `Token pool data is not found, can't sell`);
        return;
      }

      const tokenIn = new Token(TOKEN_PROGRAM_ID, poolData.state.baseMint, poolData.state.baseDecimal.toNumber());
      const tokenAmountIn = new TokenAmount(tokenIn, rawAccount.amount, true);

      if (tokenAmountIn.isZero()) {
        logger.info({ mint: rawAccount.mint.toString() }, `Empty balance, can't sell`);
        return;
      }

      if (this.config.autoSellDelay > 0) {
        logger.debug({ mint: rawAccount.mint }, `Waiting for ${this.config.autoSellDelay} ms before sell`);
        await sleep(this.config.autoSellDelay);
      }

      const market = await this.marketStorage.get(poolData.state.marketId.toString());
      const poolKeys: LiquidityPoolKeysV4 = createPoolKeys(new PublicKey(poolData.id), poolData.state, market);

      await this.priceMatch(tokenAmountIn, poolKeys);

      for (let i = 0; i < this.config.maxSellRetries; i++) {
        try {
          logger.info(
            { mint: rawAccount.mint },
            `Send sell transaction attempt: ${i + 1}/${this.config.maxSellRetries}`,
          );

          const result = await this.swap(
            poolKeys,
            accountId,
            this.config.quoteAta,
            tokenIn,
            this.config.quoteToken,
            tokenAmountIn,
            this.config.sellSlippage,
            this.config.wallet,
            'sell',
          );

          if (result.confirmed) {
            logger.info(
              {
                dex: `https://dexscreener.com/solana/${rawAccount.mint.toString()}?maker=${this.config.wallet.publicKey}`,
                mint: rawAccount.mint.toString(),
                signature: result.signature,
                url: `https://solscan.io/tx/${result.signature}?cluster=${NETWORK}`,
              },
              `Confirmed sell tx`,
            );
            break;
          }

          logger.info(
            {
              mint: rawAccount.mint.toString(),
              signature: result.signature,
              error: result.error,
            },
            `Error confirming sell tx`,
          );
        } catch (error) {
          logger.debug({ mint: rawAccount.mint.toString(), error }, `Error confirming sell transaction`);
        }
      }
    } catch (error) {
      logger.error({ mint: rawAccount.mint.toString(), error }, `Failed to sell token`);
    } finally {
      if (this.config.oneTokenAtATime) {
        this.sellExecutionCount--;
      }
    }
  }

  // noinspection JSUnusedLocalSymbols
  private async swap(
    poolKeys: LiquidityPoolKeysV4,
    ataIn: PublicKey,
    ataOut: PublicKey,
    tokenIn: Token,
    tokenOut: Token,
    amountIn: TokenAmount,
    slippage: number,
    wallet: Keypair,
    direction: 'buy' | 'sell',
  ) {
    const slippagePercent = new Percent(slippage, 100);
    const poolInfo = await Liquidity.fetchInfo({
      connection: this.connection,
      poolKeys,
    });

    const computedAmountOut = Liquidity.computeAmountOut({
      poolKeys,
      poolInfo,
      amountIn,
      currencyOut: tokenOut,
      slippage: slippagePercent,
    });

    const latestBlockhash = await this.connection.getLatestBlockhash();
    const { innerTransaction } = Liquidity.makeSwapFixedInInstruction(
      {
        poolKeys: poolKeys,
        userKeys: {
          tokenAccountIn: ataIn,
          tokenAccountOut: ataOut,
          owner: wallet.publicKey,
        },
        amountIn: amountIn.raw,
        minAmountOut: computedAmountOut.minAmountOut.raw,
      },
      poolKeys.version,
    );

    const messageV0 = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: [
        ...(this.isWarp || this.isJito
          ? []
          : [
              ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.config.unitPrice }),
              ComputeBudgetProgram.setComputeUnitLimit({ units: this.config.unitLimit }),
            ]),
        ...(direction === 'buy'
          ? [
              createAssociatedTokenAccountIdempotentInstruction(
                wallet.publicKey,
                ataOut,
                wallet.publicKey,
                tokenOut.mint,
              ),
            ]
          : []),
        ...innerTransaction.instructions,
        ...(direction === 'sell' ? [createCloseAccountInstruction(ataIn, wallet.publicKey, wallet.publicKey)] : []),
      ],
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([wallet, ...innerTransaction.signers]);

    return this.txExecutor.executeAndConfirm(transaction, wallet, latestBlockhash);
  }

  private async filterMatch(poolKeys: LiquidityPoolKeysV4) {
    if (this.config.filterCheckInterval === 0 || this.config.filterCheckDuration === 0) {
      return true;
    }

    const timesToCheck = this.config.filterCheckDuration / this.config.filterCheckInterval;
    let timesChecked = 0;
    let matchCount = 0;

    do {
      try {
        const shouldBuy = await this.poolFilters.execute(poolKeys);

        if (shouldBuy) {
          matchCount++;

          if (this.config.consecutiveMatchCount <= matchCount) {
            logger.debug(
              { mint: poolKeys.baseMint.toString() },
              `Filter match ${matchCount}/${this.config.consecutiveMatchCount}`,
            );
            return true;
          }
        } else {
          matchCount = 0;
        }

        await sleep(this.config.filterCheckInterval);
      } finally {
        timesChecked++;
      }
    } while (timesChecked < timesToCheck);

    return false;
  }

  private calculateStopLoss(currentPrice: TokenAmount): TokenAmount {
    // Calculate stop loss as percentage of current price
    const stopLossFraction = currentPrice.mul(this.config.stopLoss).numerator.div(new BN(100));
    const stopLossAmount = new TokenAmount(this.config.quoteToken, stopLossFraction, true);
    return currentPrice.subtract(stopLossAmount);
  }

  private initializeTrailingStop(mint: string, initialPrice: TokenAmount): void {
    const initialStopLoss = this.calculateStopLoss(initialPrice);
    this.trailingStops.set(mint, {
      highestPrice: initialPrice,
      currentStopLoss: initialStopLoss,
    });
    
    logger.debug(
      { 
        mint,
        initialPrice: initialPrice.toFixed(),
        initialStopLoss: initialStopLoss.toFixed(),
      },
      'Initialized trailing stop'
    );
  }

  private updateTrailingStop(mint: string, currentPrice: TokenAmount): void {
    const trailingData = this.trailingStops.get(mint);
    if (!trailingData) return;

    // Only update if we have a new highest price
    if (currentPrice.gt(trailingData.highestPrice)) {
      const newStopLoss = this.calculateStopLoss(currentPrice);
      
      // Only update if the new stop loss is higher than current stop loss
      if (newStopLoss.gt(trailingData.currentStopLoss)) {
        trailingData.highestPrice = currentPrice;
        trailingData.currentStopLoss = newStopLoss;
        
        logger.debug(
          { 
            mint,
            highestPrice: currentPrice.toFixed(),
            newStopLoss: newStopLoss.toFixed(),
            priceIncrease: currentPrice.subtract(trailingData.highestPrice).toFixed(),
            stopLossIncrease: newStopLoss.subtract(trailingData.currentStopLoss).toFixed()
          },
          'Updated trailing stop'
        );
      }
    }
  }


  private async priceMatch(amountIn: TokenAmount, poolKeys: LiquidityPoolKeysV4) {
    if (this.config.priceCheckDuration === 0 || this.config.priceCheckInterval === 0) {
      return;
    }

    const timesToCheck = this.config.priceCheckDuration / this.config.priceCheckInterval;
    const profitFraction = this.config.quoteAmount.mul(this.config.takeProfit).numerator.div(new BN(100));
    const profitAmount = new TokenAmount(this.config.quoteToken, profitFraction, true);
    const takeProfit = this.config.quoteAmount.add(profitAmount);
    
    const slippage = new Percent(this.config.sellSlippage, 100);
    let timesChecked = 0;

    const mintString = poolKeys.baseMint.toString();
    let firstCheck = true;

    do {
      try {
        const poolInfo = await Liquidity.fetchInfo({
          connection: this.connection,
          poolKeys,
        });

        const computedAmountOut = Liquidity.computeAmountOut({
          poolKeys,
          poolInfo,
          amountIn: amountIn,
          currencyOut: this.config.quoteToken,
          slippage,
        });

        const amountOut = new TokenAmount(
          this.config.quoteToken,
          computedAmountOut.amountOut.raw,
          true
        );

        if (this.config.useTrailingStop) {
          if (firstCheck) {
            this.initializeTrailingStop(mintString, amountOut);
            firstCheck = false;
          }

          this.updateTrailingStop(mintString, amountOut);
          const trailingData = this.trailingStops.get(mintString);

          if (!trailingData) {
            logger.error({ mint: mintString }, 'Trailing stop data not found');
            break;
          }

          logger.debug(
            { 
              mint: mintString,
              takeProfit: takeProfit.toFixed(),
              trailingStop: trailingData.currentStopLoss.toFixed(),
              currentPrice: amountOut.toFixed(),
              highestPrice: trailingData.highestPrice.toFixed()
            },
            'Price check (Trailing Stop)'
          );

          if (amountOut.lt(trailingData.currentStopLoss)) {
            const dropAmount = trailingData.highestPrice.subtract(amountOut);
            const dropPercentage = dropAmount.mul(new BN(100)).div(trailingData.highestPrice.raw);
            
            logger.info(
              { 
                mint: mintString,
                currentPrice: amountOut.toFixed(),
                trailingStop: trailingData.currentStopLoss.toFixed(),
                highestPrice: trailingData.highestPrice.toFixed(),
                percentageDropFromHigh: `${dropPercentage.toString()}%`
              },
              'Trailing stop triggered'
            );
            break;
          }
        } else {
          // Regular stop loss logic
          const lossFraction = this.config.quoteAmount.mul(this.config.stopLoss).numerator.div(new BN(100));
          const lossAmount = new TokenAmount(this.config.quoteToken, lossFraction, true);
          const fixedStopLoss = this.config.quoteAmount.subtract(lossAmount);

          logger.debug(
            { 
              mint: mintString,
              takeProfit: takeProfit.toFixed(),
              stopLoss: fixedStopLoss.toFixed(),
              currentPrice: amountOut.toFixed()
            },
            'Price check (Regular Stop)'
          );

          if (amountOut.lt(fixedStopLoss)) {
            logger.info(
              { 
                mint: mintString,
                currentPrice: amountOut.toFixed(),
                stopLoss: fixedStopLoss.toFixed()
              },
              'Stop loss triggered'
            );
            break;
          }
        }

        // Check take profit (same for both modes)
        if (amountOut.gt(takeProfit)) {
          logger.info(
            { 
              mint: mintString,
              currentPrice: amountOut.toFixed(),
              takeProfit: takeProfit.toFixed()
            },
            'Take profit triggered'
          );
          break;
        }

        await sleep(this.config.priceCheckInterval);
      } catch (e: any) {
        logger.trace({ mint: mintString, e }, 'Failed to check token price');
      } finally {
        timesChecked++;
      }
    } while (timesChecked < timesToCheck);

    // Clean up trailing stop data if it exists
    if (this.config.useTrailingStop) {
      this.trailingStops.delete(mintString);
    }
  }
}