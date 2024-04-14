import {
  BigNumberish,
  Liquidity,
  LIQUIDITY_STATE_LAYOUT_V4,
  LiquidityPoolKeys,
  LiquidityStateV4,
  MARKET_STATE_LAYOUT_V3,
  MarketStateV3,
  Token,
  TokenAmount,
  WSOL,
} from '@raydium-io/raydium-sdk';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  ComputeBudgetProgram,
  Connection,
  GetVersionedTransactionConfig,
  KeyedAccountInfo,
  Keypair,
  PublicKey,
  TokenBalance,
  TransactionMessage,
  TransactionSignature,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  createPoolKeys,
  getTokenAccounts,
  OPENBOOK_PROGRAM_ID,
  RAYDIUM_LIQUIDITY_PROGRAM_ID_V4,
} from './liquidity';
import {logger} from './utils';
import {
  getMinimalMarketV3,
  MinimalMarketLayoutV3,
} from './market';
import {MintLayout} from './types';
import bs58 from 'bs58';
import * as fs from 'fs';
import * as path from 'path';
import {
  AUTO_SELL,
  AUTO_SELL_DELAY,
  CHECK_IF_MINT_IS_RENOUNCED,
  COMMITMENT_LEVEL,
  LOG_LEVEL,
  MAX_POOL_SIZE,
  MAX_SELL_RETRIES,
  MIN_POOL_SIZE,
  NETWORK,
  ONE_TOKEN_AT_A_TIME,
  PRIVATE_KEY,
  QUOTE_AMOUNT,
  QUOTE_MINT,
  RPC_ENDPOINT,
  RPC_WEBSOCKET_ENDPOINT,
  SNIPE_LIST_REFRESH_INTERVAL,
  USE_SNIPE_LIST,
  RUG_CHECK_WAIT_TIMEOUT_SECONDS,
  STOP_LOSS,
  TAKE_PROFIT,
  BIRDEYE_API_KEY,
  RUG_CHECK,
  CHECK_PRICE_INTERVAL_SECONDS,
  MAX_BUY_RETRIES,
} from './constants';
import BN from "bn.js";
import {version} from './package.json'

const solanaConnection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
});

export interface MinimalTokenAccountData {
  mint: PublicKey;
  address: PublicKey;
  poolKeys?: LiquidityPoolKeys;
  market?: MinimalMarketLayoutV3;
}

const existingLiquidityPools: Set<string> = new Set<string>();
const existingOpenBookMarkets: Set<string> = new Set<string>();
const existingTokenAccounts: Map<string, MinimalTokenAccountData> = new Map<string, MinimalTokenAccountData>();

let wallet: Keypair;
let quoteToken: Token;
let quoteTokenAssociatedAddress: PublicKey;
let quoteAmount: TokenAmount;
let quoteMinPoolSizeAmount: TokenAmount;
let quoteMaxPoolSizeAmount: TokenAmount;
let processingToken: Boolean = false;
let snipeList: string[] = [];
let sellingTokenIntervals: Record<string, NodeJS.Timeout> = {};
let boughtAmounts: { [key: string]: {solAmountSent: number, tokenAmountGain:BN|number, tokenPriceUsd: number } } = {};

async function init(): Promise<void> {
  logger.level = LOG_LEVEL;

  logger.info(`
 ____        _                     ____        _                 
/ ___|  ___ | | __ _ _ __   __ _  / ___| _ __ (_)_ __   ___ _ __ 
\\___ \\ / _ \\| |/ _\` | '_ \\ / _\` | \\___ \\| '_ \\| | '_ \\ / _ \\ '__|
 ___) | (_) | | (_| | | | | (_| |  ___) | | | | | |_) |  __/ |   
|____/ \\___/|_|\\__,_|_| |_|\\__,_| |____/|_| |_|_| .__/ \\___|_|   
| __ )  ___ | |_                                |_|              
|  _ \\ / _ \\| __|                                                
| |_) | (_) | |_       version: ${version}                                          
|____/ \\___/ \\__| 
  `)

  // get wallet
  wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
  logger.info(`Wallet Address: ${wallet.publicKey}`);

  // get quote mint and amount
  switch (QUOTE_MINT) {
    case 'WSOL': {
      quoteToken = Token.WSOL;
      quoteAmount = new TokenAmount(Token.WSOL, QUOTE_AMOUNT, false);
      quoteMinPoolSizeAmount = new TokenAmount(quoteToken, MIN_POOL_SIZE, false);
      quoteMaxPoolSizeAmount = new TokenAmount(quoteToken, MAX_POOL_SIZE, false);
      break;
    }
    case 'USDC': {
      quoteToken = new Token(
          TOKEN_PROGRAM_ID,
          new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
          6,
          'USDC',
          'USDC',
      );
      quoteAmount = new TokenAmount(quoteToken, QUOTE_AMOUNT, false);
      quoteMinPoolSizeAmount = new TokenAmount(quoteToken, MIN_POOL_SIZE, false);
      quoteMaxPoolSizeAmount = new TokenAmount(quoteToken, MAX_POOL_SIZE, false);
      break;
    }
    default: {
      throw new Error(`Unsupported quote mint "${QUOTE_MINT}". Supported values are USDC and WSOL`);
    }
  }

  logger.info(`Snipe list: ${USE_SNIPE_LIST}`);
  logger.info(`Check mint renounced: ${CHECK_IF_MINT_IS_RENOUNCED}`);
  logger.info(
      `Min pool size: ${quoteMinPoolSizeAmount.toFixed()} ${quoteToken.symbol}`,
  );
  logger.info(
      `Max pool size: ${quoteMaxPoolSizeAmount.toFixed()} ${quoteToken.symbol}`,
  );
  logger.info(`One token at a time: ${ONE_TOKEN_AT_A_TIME}`);
  logger.info(`Buy amount: ${quoteAmount.toFixed()} ${quoteToken.symbol}`);
  logger.info(`Auto sell: ${AUTO_SELL}`);
  logger.info(`Sell delay: ${AUTO_SELL_DELAY === 0 ? 'false' : AUTO_SELL_DELAY}`);
  logger.info(`Rug check: ${RUG_CHECK}`);
  logger.info(`Rug check delay: ${RUG_CHECK_WAIT_TIMEOUT_SECONDS} sec.`);
  logger.info(`Check price interval: ${CHECK_PRICE_INTERVAL_SECONDS} sec.`);
  logger.info(`Take profit: ${TAKE_PROFIT}%.`);
  logger.info(`Stop loss: ${STOP_LOSS}%.`);

  // check existing wallet for associated token account of quote mint
  const tokenAccounts = await getTokenAccounts(solanaConnection, wallet.publicKey, COMMITMENT_LEVEL);

  for (const ta of tokenAccounts) {
    existingTokenAccounts.set(ta.accountInfo.mint.toString(), <MinimalTokenAccountData>{
      mint: ta.accountInfo.mint,
      address: ta.pubkey,
    });
  }

  const tokenAccount = tokenAccounts.find((acc) => acc.accountInfo.mint.toString() === quoteToken.mint.toString())!;

  if (!tokenAccount) {
    throw new Error(`No ${quoteToken.symbol} token account found in wallet: ${wallet.publicKey}`);
  }

  quoteTokenAssociatedAddress = tokenAccount.pubkey;

  // load tokens to snipe
  loadSnipeList();
}

function saveTokenAccount(mint: PublicKey, accountData: MinimalMarketLayoutV3) {
  const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey);
  const tokenAccount = <MinimalTokenAccountData>{
    address: ata,
    mint: mint,
    market: <MinimalMarketLayoutV3>{
      bids: accountData.bids,
      asks: accountData.asks,
      eventQueue: accountData.eventQueue,
    },
  };
  existingTokenAccounts.set(mint.toString(), tokenAccount);
  return tokenAccount;
}

export async function processRaydiumPool(id: PublicKey, poolState: LiquidityStateV4) {
  if (!shouldBuy(poolState.baseMint.toString())) {
    return;
  }

  if (!quoteMinPoolSizeAmount.isZero()) {
    const poolSize = new TokenAmount(quoteToken, poolState.swapQuoteInAmount, true);
    logger.info(`Processing pool: ${id.toString()} with ${poolSize.toFixed()} ${quoteToken.symbol} in liquidity`);

    if (poolSize.lt(quoteMinPoolSizeAmount)) {
      logger.warn(
          `Skipping pool, smaller than ${quoteMinPoolSizeAmount.toFixed()} ${quoteToken.symbol}. Swap quote in amount: ${poolSize.toFixed()}`,
      );
      logger.info(`——————————————————————————————————————————`);
      return;
    }
  }

  if (!quoteMaxPoolSizeAmount.isZero()) {
    const poolSize = new TokenAmount(quoteToken, poolState.swapQuoteInAmount, true);

    if (poolSize.gt(quoteMaxPoolSizeAmount)) {
      logger.warn(
          {
            mint: poolState.baseMint,
            pooled: `${poolSize.toFixed()} ${quoteToken.symbol}`,
          },
          `Skipping pool, bigger than ${quoteMaxPoolSizeAmount.toFixed()} ${quoteToken.symbol}`,
          `Swap quote in amount: ${poolSize.toFixed()}`,
      );
      logger.info(`——————————————————————————————————————————`);
      return;
    }
  }

  if (CHECK_IF_MINT_IS_RENOUNCED) {
    const mintOption = await checkMintable(poolState.baseMint);

    if (mintOption !== true) {
      logger.warn(`${poolState.baseMint} - Skipping, owner can mint tokens!`);
      return;
    }
  }

  if (RUG_CHECK) {
    const rugScore = await getRugScore(poolState.baseMint.toString());
    if (!rugScore || rugScore > 600) {
      logger.warn(`Skipping, rug detected for mint ${poolState.baseMint}`);
      return;
    }
  }

  await buy(id, poolState);
}

export async function checkMintable(vault: PublicKey): Promise<boolean | undefined> {
  try {
    let {data} = (await solanaConnection.getAccountInfo(vault)) || {};
    if (!data) {
      return;
    }
    const deserialize = MintLayout.decode(data);
    return deserialize.mintAuthorityOption === 0;
  } catch (e) {
    logger.debug(e);
    logger.error({mint: vault}, `Failed to check if mint is renounced`);
  }
}

export async function getRugScore(tokenAddress: string) {
  try {
    await new Promise((resolve) => setTimeout(resolve, RUG_CHECK_WAIT_TIMEOUT_SECONDS * 1000));
    const responseRaw = await fetch(`https://api.rugcheck.xyz/v1/tokens/${tokenAddress}/report`);
    let response
    try {
      response = await responseRaw.json()
    }
    catch (error) {
      logger.warn(`Rugcheck response is not a valid json: ${error}`)
      return undefined
    }

    logger.debug(`Rugcheck score: ${response?.score} for token ${tokenAddress}`)

    return response?.score
  } catch (error) {
    logger.error(error);
  }
}

export async function processOpenBookMarket(updatedAccountInfo: KeyedAccountInfo) {
  let accountData: MarketStateV3 | undefined;
  try {
    accountData = MARKET_STATE_LAYOUT_V3.decode(updatedAccountInfo.accountInfo.data);

    // to be competitive, we collect market data before buying the token...
    if (existingTokenAccounts.has(accountData.baseMint.toString())) {
      return;
    }

    saveTokenAccount(accountData.baseMint, accountData);
  } catch (e) {
    logger.debug(e);
    logger.error({mint: accountData?.baseMint}, `Failed to process market`);
  }
}

async function buy(accountId: PublicKey, accountData: LiquidityStateV4): Promise<void> {
  try {
    let tokenAccount = existingTokenAccounts.get(accountData.baseMint.toString());

    if (!tokenAccount) {
      // it's possible that we didn't have time to fetch open book data
      const market = await getMinimalMarketV3(solanaConnection, accountData.marketId, COMMITMENT_LEVEL);
      tokenAccount = saveTokenAccount(accountData.baseMint, market);
    }

    tokenAccount.poolKeys = createPoolKeys(accountId, accountData, tokenAccount.market!);
    const {innerTransaction} = Liquidity.makeSwapFixedInInstruction(
        {
          poolKeys: tokenAccount.poolKeys,
          userKeys: {
            tokenAccountIn: quoteTokenAssociatedAddress,
            tokenAccountOut: tokenAccount.address,
            owner: wallet.publicKey,
          },
          amountIn: quoteAmount.raw,
          minAmountOut: 0,
        },
        tokenAccount.poolKeys.version,
    );

    const maxSendTxnAttempts = MAX_BUY_RETRIES;

    let signature: string = '';
    let isTransactionConfirmed = false;

    for (let i = 0; i < MAX_BUY_RETRIES; i++) {
      logger.info(`send transaction attempt: ${i}`);

      let latestBlockhash = await solanaConnection.getLatestBlockhash({
        commitment: COMMITMENT_LEVEL,
      });

      try {
        const messageV0 = new TransactionMessage({
          payerKey: wallet.publicKey,
          recentBlockhash: latestBlockhash.blockhash,
          instructions: [
            ComputeBudgetProgram.setComputeUnitPrice({microLamports: 421197}),
            ComputeBudgetProgram.setComputeUnitLimit({units: 101337}),
            createAssociatedTokenAccountIdempotentInstruction(
                wallet.publicKey,
                tokenAccount.address,
                wallet.publicKey,
                accountData.baseMint,
            ),
            ...innerTransaction.instructions,
          ],
        }).compileToV0Message();
        const transaction = new VersionedTransaction(messageV0);
        transaction.sign([wallet, ...innerTransaction.signers]);
        signature = await solanaConnection.sendRawTransaction(transaction.serialize(), {
          preflightCommitment: COMMITMENT_LEVEL,
        });
        logger.info({mint: accountData.baseMint, signature}, `Sent buy tx`);
        processingToken = true;

        const confirmation = await solanaConnection.confirmTransaction(
            {
              signature,
              lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
              blockhash: latestBlockhash.blockhash,
            },
            COMMITMENT_LEVEL,
        );
        if (!confirmation.value.err) {
          logger.info(`——————————————————————————————————————————`);
          logger.info(
              {
                mint: accountData.baseMint,
                signature,
                url: `https://solscan.io/tx/${signature}?cluster=${NETWORK}`,
              },
              `Confirmed buy tx`,
          );
          isTransactionConfirmed = true;

          logger.debug('Getting bought amount...')
          const boughtAmount = await processTransactionForAmount(signature, accountData.baseMint);
          logger.info(`Token received: got amount: ${boughtAmount?.tokenAmountGain.toString()} for price ${boughtAmount.tokenPriceUsd} USD / each`)
          boughtAmounts[tokenAccount.mint.toString()] = boughtAmount

          if (AUTO_SELL && boughtAmount.tokenAmountGain) {
            checkPriceAndSell(wallet.publicKey, tokenAccount.mint, boughtAmount.tokenAmountGain)
          }
          break;
        } else {
          logger.debug(confirmation.value.err);
          logger.info({mint: accountData.baseMint, signature}, `Error confirming buy tx`);
          throw new Error(`failed to confirm transaction, ${confirmation.value.err}`)
        }
      } catch (error) {
        logger.warn(`got error on buy tx: ${error}`)
        if (i === maxSendTxnAttempts - 1) throw error;
      }
    }
  } catch (e) {
    logger.debug(e);
    processingToken = false;
    logger.error({mint: accountData.baseMint}, `Failed to buy token`);
  }
}

async function getTokenPrice (tokenAddress:string) {
  const response = await fetch(`https://public-api.birdeye.so/defi/price?include_liquidity=true&address=${tokenAddress}`,
      {
        method: 'GET',
        headers: {'x-chain': 'solana', 'X-API-KEY': BIRDEYE_API_KEY}
      })

  return await response.json();
}

async function processTransactionForAmount(signature: TransactionSignature, mint: PublicKey) {
  try {

    const solPriceData = await getTokenPrice(WSOL.mint)

    logger.info(`Solana price is ${solPriceData.data.value}`)

    const config: GetVersionedTransactionConfig = {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0
    }
    const confirmedTransactionResponse = await solanaConnection.getTransaction(signature, config);
    const preTokenBalances: Array<TokenBalance> | null | undefined = confirmedTransactionResponse?.meta?.preTokenBalances
    const postTokenBalances: Array<TokenBalance> | null | undefined = confirmedTransactionResponse?.meta?.postTokenBalances

    const solPreBalance = preTokenBalances!.find(token => token.mint === WSOL.mint.toString())?.uiTokenAmount?.amount
    const solPostBalance = postTokenBalances!.find(token => token.mint === WSOL.mint.toString())?.uiTokenAmount?.amount

    let solAmountSent = Number(solPreBalance) - Number(solPostBalance)
    let tokenAmountGain:number|BN = 0
    let tokenAmount
    let tokenPriceUsd:number = 0
    if (postTokenBalances) {
      tokenAmount = postTokenBalances.find(token => token.mint === mint.toString())?.uiTokenAmount
      const tokenAmountGainShort = tokenAmount?.uiAmount
      logger.info(tokenAmount, `tokenAmount is`)

      if (tokenAmountGainShort && tokenAmount){
        tokenAmountGain = new BN(tokenAmount.amount)
        tokenPriceUsd = (Math.abs(solAmountSent) / (10 ** WSOL.decimals) * solPriceData.data.value) / (tokenAmountGainShort) // / (10 ** tokenAmount?.decimals)
      }
    }

    return {solAmountSent, tokenAmountGain, tokenPriceUsd}
  } catch (e) {
    logger.error(`Failed to fetch or process transaction ${signature}`, e);
    throw e;
  }
}

async function sell(accountId: PublicKey, mint: PublicKey, amount: BigNumberish): Promise<void> {
  logger.info(`Start selling... amount: ${amount}`)
  let sold = false;
  let retries = 0;

  if (AUTO_SELL_DELAY > 0) {
    await new Promise((resolve) => setTimeout(resolve, AUTO_SELL_DELAY));
  }

  do {
    try {
      const tokenAccount = existingTokenAccounts.get(mint.toString());

      if (!tokenAccount) {
        return;
      }

      if (!tokenAccount.poolKeys) {
        logger.warn({mint}, 'No pool keys found');
        return;
      }

      if (amount === 0) {
        logger.info(
          {
            mint: tokenAccount.mint,
          },
          `Empty balance, can't sell`,
        );
        return;
      }

      const { innerTransaction } = Liquidity.makeSwapFixedInInstruction(
        {
          poolKeys: tokenAccount.poolKeys!,
          userKeys: {
            tokenAccountOut: quoteTokenAssociatedAddress,
            tokenAccountIn: tokenAccount.address,
            owner: wallet.publicKey,
          },
          amountIn: amount,
          minAmountOut: 0,
        },
        tokenAccount.poolKeys!.version,
      );

      const latestBlockhash = await solanaConnection.getLatestBlockhash({
        commitment: COMMITMENT_LEVEL,
      });
      const messageV0 = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions: [
          ComputeBudgetProgram.setComputeUnitPrice({microLamports: 421197}),
          ComputeBudgetProgram.setComputeUnitLimit({units: 101337}),
          ...innerTransaction.instructions,
          createCloseAccountInstruction(tokenAccount.address, wallet.publicKey, wallet.publicKey),
        ],
      }).compileToV0Message();
      const transaction = new VersionedTransaction(messageV0);
      transaction.sign([wallet, ...innerTransaction.signers]);
      const signature = await solanaConnection.sendRawTransaction(transaction.serialize(), {
        preflightCommitment: COMMITMENT_LEVEL,
      });
      logger.info({mint, signature}, `Sent sell tx`);
      const confirmation = await solanaConnection.confirmTransaction(
        {
          signature,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
          blockhash: latestBlockhash.blockhash,
        },
        COMMITMENT_LEVEL,
      );
      if (confirmation.value.err) {
        logger.debug(confirmation.value.err);
        logger.info({mint, signature}, `Error confirming sell tx`);
        continue;
      }
      logger.info(`——————————————————————————————————————————`);
      logger.info(
        {
          dex: `https://dexscreener.com/solana/${mint}?maker=${wallet.publicKey}`,
          mint,
          signature,
          url: `https://solscan.io/tx/${signature}?cluster=${NETWORK}`,
        },
        `Confirmed sell tx`,
      );
      sold = true;
      processingToken = false;
    } catch (e: any) {
      // wait for a bit before retrying
      await new Promise((resolve) => setTimeout(resolve, 100));
      retries++;
      logger.debug(e);
      logger.error({mint}, `Failed to sell token, retry: ${retries}/${MAX_SELL_RETRIES}`);
    }
  } while (!sold && retries < MAX_SELL_RETRIES)

  clearInterval(sellingTokenIntervals[mint.toString() as keyof typeof sellingTokenIntervals])
  processingToken = false;
}

function loadSnipeList() {
  if (!USE_SNIPE_LIST) {
    return;
  }

  const count = snipeList.length;
  const data = fs.readFileSync(path.join(__dirname, 'snipe-list.txt'), 'utf-8');
  snipeList = data
    .split('\n')
    .map((a) => a.trim())
    .filter((a) => a);

  if (snipeList.length != count) {
    logger.info(`Loaded snipe list: ${snipeList.length}`);
  }
}

function shouldBuy(key: string): boolean {
  logger.info(`New token minted: ${key}`);
  return USE_SNIPE_LIST ? snipeList.includes(key) : ONE_TOKEN_AT_A_TIME ? !processingToken : true
}

const runListener = async () => {
  await init();
  const runTimestamp = Math.floor(new Date().getTime() / 1000);
  const raydiumSubscriptionId = solanaConnection.onProgramAccountChange(
    RAYDIUM_LIQUIDITY_PROGRAM_ID_V4,
    async (updatedAccountInfo) => {
      const key = updatedAccountInfo.accountId.toString();
      const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(updatedAccountInfo.accountInfo.data);
      const poolOpenTime = parseInt(poolState.poolOpenTime.toString());
      const existing = existingLiquidityPools.has(key);

      if (poolOpenTime > runTimestamp && !existing) {
        existingLiquidityPools.add(key);
        const _ = processRaydiumPool(updatedAccountInfo.accountId, poolState);
      }
    },
    COMMITMENT_LEVEL,
    [
      { dataSize: LIQUIDITY_STATE_LAYOUT_V4.span },
      {
        memcmp: {
          offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('quoteMint'),
          bytes: quoteToken.mint.toBase58(),
        },
      },
      {
        memcmp: {
          offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('marketProgramId'),
          bytes: OPENBOOK_PROGRAM_ID.toBase58(),
        },
      },
      {
        memcmp: {
          offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('status'),
          bytes: bs58.encode([6, 0, 0, 0, 0, 0, 0, 0]),
        },
      },
    ],
  );

  const openBookSubscriptionId = solanaConnection.onProgramAccountChange(
    OPENBOOK_PROGRAM_ID,
    async (updatedAccountInfo) => {
      const key = updatedAccountInfo.accountId.toString();
      const existing = existingOpenBookMarkets.has(key);
      if (!existing) {
        existingOpenBookMarkets.add(key);
        const _ = processOpenBookMarket(updatedAccountInfo);
      }
    },
    COMMITMENT_LEVEL,
    [
      { dataSize: MARKET_STATE_LAYOUT_V3.span },
      {
        memcmp: {
          offset: MARKET_STATE_LAYOUT_V3.offsetOf('quoteMint'),
          bytes: quoteToken.mint.toBase58(),
        },
      },
    ],
  );

  logger.info(`Listening for raydium changes: ${raydiumSubscriptionId}`);
  logger.info(`Listening for open book changes: ${openBookSubscriptionId}`);

  logger.info('——————————————————————————————————————————');
  logger.info('Bot is running! Press CTRL + C to stop it.');
  logger.info('——————————————————————————————————————————');

  if (USE_SNIPE_LIST) {
    setInterval(loadSnipeList, SNIPE_LIST_REFRESH_INTERVAL);
  }
};

async function checkPriceAndSell(walletPublicKey:PublicKey, mintAddress:PublicKey, amount: BigNumberish) {
  try {
    const tokenPriceData = await getTokenPrice(mintAddress.toString())
    const currentTokenPrice = tokenPriceData.data.value
    const currentTokenLiq = tokenPriceData.data.liquidity

    if (currentTokenLiq < 1000) {
      logger.warn(`${mintAddress.toString()} - low liquidity: ${currentTokenLiq}. Stop watching.`)
      return
    }

    const boughtInfo = boughtAmounts[mintAddress.toString() as keyof typeof boughtAmounts]

    logger.info(`${mintAddress.toString()} - Price is ${currentTokenPrice} USD (${Math.round(((currentTokenPrice / boughtInfo?.tokenPriceUsd) * 100 - 100) * 100) / 100 }%)`)

    // if token lost more than 90% then skip watching
    if (currentTokenPrice <= boughtInfo?.tokenPriceUsd * (100 - 90) / 100) {
      logger.warn(`${mintAddress.toString()} lost more than 90%. Skip selling.`)
      return
    }

    if (RUG_CHECK) {
      const rugScore = await getRugScore(mintAddress.toString())
      if (!rugScore) {
        logger.warn(`Rug score is ${rugScore}. Possible that rate limit reached.`)
      }

      if (rugScore >= 1000) {
        logger.warn(`${mintAddress.toString()} - rug risk increased with score ${rugScore}`)
        await sell(walletPublicKey, mintAddress, amount);
        return
      }
    }

    if (currentTokenPrice <= boughtInfo?.tokenPriceUsd * (100 - STOP_LOSS) / 100) {
      logger.warn(`${mintAddress.toString()} - Stop Loss triggered: ${currentTokenPrice} and ${boughtInfo?.tokenPriceUsd}. ${currentTokenPrice <= boughtInfo?.tokenPriceUsd * (100 - STOP_LOSS) / 100}`);
      await sell(walletPublicKey, mintAddress, amount);
    } else if (currentTokenPrice >= boughtInfo?.tokenPriceUsd * (100 + TAKE_PROFIT) / 100) {
      logger.warn(`${mintAddress.toString()} - Take Profit triggered: ${currentTokenPrice} and ${boughtInfo?.tokenPriceUsd}. ${currentTokenPrice >= boughtInfo?.tokenPriceUsd * (100 + TAKE_PROFIT) / 100}`);
      await sell(walletPublicKey, mintAddress, amount);
    } else {
      sellingTokenIntervals[mintAddress.toString()] = setTimeout(() => {
        checkPriceAndSell(walletPublicKey, mintAddress, amount);
      }, CHECK_PRICE_INTERVAL_SECONDS * 1000);
    }
  } catch (error) {
    logger.error(error, 'Failed to fetch or process price:', );

    sellingTokenIntervals[mintAddress.toString()] = setTimeout(() => {
      checkPriceAndSell(walletPublicKey, mintAddress, amount);
    }, CHECK_PRICE_INTERVAL_SECONDS * 1000);
  }
}

runListener();
