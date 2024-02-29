import {
  Liquidity,
  LIQUIDITY_STATE_LAYOUT_V4,
  LiquidityPoolKeys,
  LiquidityStateV4,
  MARKET_STATE_LAYOUT_V3,
  MarketStateV3,
  Token,
  TokenAmount,
} from '@raydium-io/raydium-sdk';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  Keypair,
  Connection,
  PublicKey,
  ComputeBudgetProgram,
  KeyedAccountInfo,
  TransactionMessage,
  VersionedTransaction,
  Commitment,
} from '@solana/web3.js';
import { getTokenAccounts, RAYDIUM_LIQUIDITY_PROGRAM_ID_V4, OPENBOOK_PROGRAM_ID, createPoolKeys } from './liquidity';
import { retrieveEnvVariable } from './utils';
import { getMinimalMarketV3, MinimalMarketLayoutV3 } from './market';
import pino from 'pino';
import bs58 from 'bs58';
import * as fs from 'fs';
import * as path from 'path';
import BN from 'bn.js';
import { MintLayout } from './types';
import moment from 'moment';

const transport = pino.transport({
  targets: [
    // {
    //   level: 'trace',
    //   target: 'pino/file',
    //   options: {
    //     destination: 'buy.log',
    //   },
    // },

    {
      level: 'trace',
      target: 'pino-pretty',
      options: {},
    },
  ],
});

export const logger = pino(
  {
    redact: ['poolKeys'],
    serializers: {
      error: pino.stdSerializers.err,
    },
    base: undefined,
  },
  transport,
);

const network = 'mainnet-beta';
const RPC_ENDPOINT = retrieveEnvVariable('RPC_ENDPOINT', logger);
const RPC_WEBSOCKET_ENDPOINT = retrieveEnvVariable('RPC_WEBSOCKET_ENDPOINT', logger);

const solanaConnection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
});

export type MinimalTokenAccountData = {
  mint: PublicKey;
  address: PublicKey;
  poolKeys?: LiquidityPoolKeys;
  market?: MinimalMarketLayoutV3;
};

let existingLiquidityPools: Set<string> = new Set<string>();
let existingOpenBookMarkets: Set<string> = new Set<string>();
let existingTokenAccounts: Map<string, MinimalTokenAccountData> = new Map<string, MinimalTokenAccountData>();

let wallet: Keypair;
let quoteToken: Token;
let quoteTokenAssociatedAddress: PublicKey;
let quoteAmount: TokenAmount;
let commitment: Commitment = retrieveEnvVariable('COMMITMENT_LEVEL', logger) as Commitment;

const USE_SNIPE_LIST = retrieveEnvVariable('USE_SNIPE_LIST', logger) === 'true';
const SNIPE_LIST_REFRESH_INTERVAL = Number(retrieveEnvVariable('SNIPE_LIST_REFRESH_INTERVAL', logger));
// const AUTO_SELL = retrieveEnvVariable('AUTO_SELL', logger) === 'true';
const SELL_DELAY = Number(retrieveEnvVariable('SELL_DELAY', logger));
const MAX_TOKENS_TO_BUY = Number(retrieveEnvVariable('MAX_TOKENS_TO_BUY', logger));

const MAX_SELL_RETRIES = 5;

let snipeList: string[] = [];

// init
async function init(): Promise<void> {
  // get wallet
  const PRIVATE_KEY = retrieveEnvVariable('PRIVATE_KEY', logger);
  wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
  logger.info(`Wallet Address: ${wallet.publicKey}`);

  // get quote mint and amount
  const QUOTE_MINT = retrieveEnvVariable('QUOTE_MINT', logger);
  const QUOTE_AMOUNT = retrieveEnvVariable('QUOTE_AMOUNT', logger);
  switch (QUOTE_MINT) {
    case 'WSOL': {
      quoteToken = Token.WSOL;
      quoteAmount = new TokenAmount(Token.WSOL, QUOTE_AMOUNT, false);
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
      break;
    }
    default: {
      throw new Error(`Unsupported quote mint "${QUOTE_MINT}". Supported values are USDC and WSOL`);
    }
  }

  logger.info(
    `Script will buy all new tokens using ${QUOTE_MINT}. Amount that will be used to buy each token is: ${quoteAmount.toFixed().toString()}`,
  );

  // check existing wallet for associated token account of quote mint
  const tokenAccounts = await getTokenAccounts(solanaConnection, wallet.publicKey, commitment);

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

// save token account
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

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// process raydium pool
let tokensBoughtCount = 0;
let startNewCycle = true;

async function processRaydiumPool(updatedAccountInfo: KeyedAccountInfo) {
  let accountData: LiquidityStateV4 | undefined;
  try {
    if (updatedAccountInfo.accountInfo.data === undefined) {
      console.error('Account data is undefined');
      return;
    }

    // Decode the account data and ensure it's of type LiquidityStateV4
    const decodedData = LIQUIDITY_STATE_LAYOUT_V4.decode(updatedAccountInfo.accountInfo.data);
    accountData = decodedData as LiquidityStateV4;

    // Convert start time to Moment object
    const startTime = moment.utc(accountData.poolOpenTime.toNumber() * 1000).utcOffset('+0100');

    console.log('Trading Starts:', startTime.fromNow());

    // Get the associated liquidity pool key
    const lpMintAddress = updatedAccountInfo.accountId;

    console.log('Liquidity Pool Pair:', lpMintAddress.toString());

    // Check if the token is mintable before proceeding with the buy transaction
    // const mintable = await checkMintable(accountData.baseMint);
    // if (!mintable) {
    //   logger.info('Token Mint is not revoked, skipping buy transaction.');
    //   return;
    // }

    if (startNewCycle) {
      tokensBoughtCount = 0;
      startNewCycle = false;
      logger.info('New cycle started');
    }

    if (tokensBoughtCount < MAX_TOKENS_TO_BUY) {
      // Display baseMint, quoteMint, and lpMint addresses before buy transaction
      logger.info(`baseMint Address: ${accountData.baseMint.toString()}`);
      logger.info(`baseVault Address: ${accountData.baseVault.toString()}`);
      logger.info(`quoteVault Address: ${accountData.quoteVault.toString()}`);

      // logger.info(`quoteMint Address: ${accountData.quoteMint.toString()}`);
      logger.info(`lpMint Address: ${accountData.lpMint.toString()}`);

      const qvault: number = await solanaConnection.getBalance(accountData.quoteVault);

      const solAmount: number = qvault / Math.pow(10, 9);
      const baseDecimal: number = accountData.baseDecimal.toNumber();
      logger.info(`Base Decimal: ${baseDecimal}`);
      logger.info(`Pool Sol Balance: ${solAmount}`);

      // Retrieve the token balance of the baseVault
      const tokenBalanceResponse = await solanaConnection.getTokenAccountBalance(accountData.baseVault);
      const baseVaultTokenBalance = tokenBalanceResponse.value.amount;
      logger.info(`Base Token Balance: ${baseVaultTokenBalance}`);      

      await buy(updatedAccountInfo.accountId, accountData);

      // Delay before selling
      setTimeout(async () => {
        await sell(updatedAccountInfo.accountId, accountData as LiquidityStateV4, tokensBoughtCount);
      }, SELL_DELAY);

      tokensBoughtCount++;
      logger.info(`Bought ${tokensBoughtCount} tokens`);
    }

    if (tokensBoughtCount >= MAX_TOKENS_TO_BUY) {
      startNewCycle = true;
      logger.info('Previous cycle ended, Starting new cycle');
    }
  } catch (e) {
    console.log(e);
  }
}

// Checks if the mint is mintable
export async function checkMintable(vault: PublicKey) {
  try {
    let { data } = (await solanaConnection.getAccountInfo(vault)) || {};
    if (!data) {
      return;
    }
    // Deserialize Data.
    const deserialize = MintLayout.decode(data);
    const mintoption = deserialize.mintAuthorityOption;

    if (mintoption === 0) {
      return true;
    } else {
      const mintAddress = vault.toBase58();
      logger.info(
        {
          mintAddress: `${mintAddress}`,
        },
        'Token Mint is enabled',
      );
      logger.info(
        {
          url: `https://explorer.solana.com/address/${mintAddress}`,
        },
        'View token on Solscan',
      );
      return false;
    }
  } catch {
    return null;
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
    logger.error({ ...accountData, error: e }, `Failed to process market`);
  }
}

async function buy(accountId: PublicKey, accountData: LiquidityStateV4): Promise<void> {
  let tokenAccount = existingTokenAccounts.get(accountData.baseMint.toString());

  if (!tokenAccount) {
    // it's possible that we didn't have time to fetch open book data
    const market = await getMinimalMarketV3(solanaConnection, accountData.marketId, commitment);
    tokenAccount = saveTokenAccount(accountData.baseMint, market);
  }

  tokenAccount.poolKeys = createPoolKeys(accountId, accountData, tokenAccount.market!);
  const { innerTransaction, address } = Liquidity.makeSwapFixedInInstruction(
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

  const latestBlockhash = await solanaConnection.getLatestBlockhash({
    commitment: commitment,
  });
  const messageV0 = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: latestBlockhash.blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }), // you can increase this number for more gas fee
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200000 }), // you can increase this number for more gas fee
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
  const signature = await solanaConnection.sendRawTransaction(transaction.serialize(), {
    maxRetries: 5,
    preflightCommitment: commitment,
  });
  logger.info(
    {
      mint: accountData.baseMint,
      url: `https://solscan.io/tx/${signature}?cluster=${network}`,
      dexURL: `https://dexscreener.com/solana/${accountData.baseMint}?maker=${wallet.publicKey}`,
      dexScreenerURL: `https://dexscreener.com/solana/${accountData.baseMint}`,
    },
    'Buy',
  );
}

// sell the token
async function sell(accountId: PublicKey, accountData: LiquidityStateV4, tokensBoughtCount: number): Promise<void> {
  const tokenAccount = existingTokenAccounts.get(accountData.baseMint.toString());

  if (!tokenAccount) {
    logger.error(`Token account not found for mint: ${accountData.baseMint.toString()}`);
    return;
  }

  let retries = 0;
  let balanceFound = false;
  while (retries < MAX_SELL_RETRIES) {
    try {
      const balanceResponse = (await solanaConnection.getTokenAccountBalance(tokenAccount.address)).value.amount;

      if (balanceResponse !== null && Number(balanceResponse) > 0 && !balanceFound) {
        balanceFound = true;
        logger.info(`Token Balance: ${balanceResponse}`);
        tokenAccount.poolKeys = createPoolKeys(accountId, accountData, tokenAccount.market!);
        const { innerTransaction, address } = Liquidity.makeSwapFixedInInstruction(
          {
            poolKeys: tokenAccount.poolKeys,
            userKeys: {
              tokenAccountIn: tokenAccount.address,
              tokenAccountOut: quoteTokenAssociatedAddress,
              owner: wallet.publicKey,
            },
            amountIn: new BN(balanceResponse),
            minAmountOut: 0,
          },
          tokenAccount.poolKeys.version,
        );

        const latestBlockhash = await solanaConnection.getLatestBlockhash({
          commitment: commitment,
        });
        const messageV0 = new TransactionMessage({
          payerKey: wallet.publicKey,
          recentBlockhash: latestBlockhash.blockhash,
          instructions: [
            ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200000 }),
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
        const signature = await solanaConnection.sendRawTransaction(transaction.serialize(), {
          maxRetries: 5,
          preflightCommitment: commitment,
        });
        logger.info(
          {
            mint: accountData.baseMint,
            url: `https://solscan.io/tx/${signature}?cluster=${network}`,
          },
          'Sell transaction sent',
        );
        logger.info(`Sold ${tokensBoughtCount} tokens`);
        return;
      }
    } catch (error) {
      logger.error({ error }, 'Error in sell operation');
    }
    retries++;
    await delay(35000); // Wait for 35 seconds before retrying
  }
}

// load snipe list
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
  return USE_SNIPE_LIST ? snipeList.includes(key) : true;
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

      // Use shouldBuy function here
      if (shouldBuy(key) && poolOpenTime >= runTimestamp && !existing) {
        existingLiquidityPools.add(key);
        logger.info('Looking for new pool...');
        const _ = processRaydiumPool(updatedAccountInfo);
      }
    },
    commitment,
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
    commitment,
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

  if (USE_SNIPE_LIST) {
    setInterval(loadSnipeList, SNIPE_LIST_REFRESH_INTERVAL);
  }
};

runListener();
