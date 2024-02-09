import {
  Liquidity,
  LIQUIDITY_STATE_LAYOUT_V4,
  LiquidityPoolKeys,
  LiquidityStateV4,
  MARKET_STATE_LAYOUT_V2,
  MARKET_STATE_LAYOUT_V3,
  MarketStateV3,
  Token,
  TokenAmount,
} from '@raydium-io/raydium-sdk';
import {
  createAssociatedTokenAccountIdempotentInstruction,
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
import {
  getTokenAccounts,
  RAYDIUM_LIQUIDITY_PROGRAM_ID_V4,
  OPENBOOK_PROGRAM_ID,
  createPoolKeys,
} from './liquidity';
import { retrieveEnvVariable } from './utils';
import { getAllMarketsV3, MinimalMarketLayoutV3 } from './market';
import pino from 'pino';
import bs58 from 'bs58';
import * as fs from 'fs';
import * as path from 'path';

const transport = pino.transport({
  targets: [
    /*
    {
      level: 'trace',
      target: 'pino/file',
      options: {
        destination: 'buy.log',
      },
    },
    */
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
const RPC_WEBSOCKET_ENDPOINT = retrieveEnvVariable(
  'RPC_WEBSOCKET_ENDPOINT',
  logger,
);

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
let existingTokenAccounts: Map<string, MinimalTokenAccountData> = new Map<
  string,
  MinimalTokenAccountData
>();

let wallet: Keypair;
let quoteToken: Token;
let quoteTokenAssociatedAddress: PublicKey;
let quoteAmount: TokenAmount;
let commitment: Commitment = retrieveEnvVariable(
  'COMMITMENT_LEVEL',
  logger,
) as Commitment;

const USE_SNIPE_LIST = retrieveEnvVariable('USE_SNIPE_LIST', logger) === 'true';
const SNIPE_LIST_REFRESH_INTERVAL = Number(
  retrieveEnvVariable('SNIPE_LIST_REFRESH_INTERVAL', logger),
);
let snipeList: string[] = [];

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
      throw new Error(
        `Unsupported quote mint "${QUOTE_MINT}". Supported values are USDC and WSOL`,
      );
    }
  }

  logger.info(
    `Script will buy all new tokens using ${QUOTE_MINT}. Amount that will be used to buy each token is: ${quoteAmount.toFixed().toString()}`,
  );

  logger.info(`Loading existing markets...`);
  // get all open-book markets
  const allMarkets = await getAllMarketsV3(
    solanaConnection,
    quoteToken.mint,
    commitment,
  );
  existingOpenBookMarkets = new Set(allMarkets.map((p) => p.id.toString()));
  logger.info(
    `Loaded ${existingOpenBookMarkets.size} ${quoteToken.symbol} markets`,
  );
  // check existing wallet for associated token account of quote mint
  const tokenAccounts = await getTokenAccounts(
    solanaConnection,
    wallet.publicKey,
    commitment,
  );

  for (const ta of tokenAccounts) {
    existingTokenAccounts.set(ta.accountInfo.mint.toString(), <
      MinimalTokenAccountData
    >{
      mint: ta.accountInfo.mint,
      address: ta.pubkey,
    });
  }

  const tokenAccount = tokenAccounts.find(
    (acc) => acc.accountInfo.mint.toString() === quoteToken.mint.toString(),
  )!;

  if (!tokenAccount) {
    throw new Error(
      `No ${quoteToken.symbol} token account found in wallet: ${wallet.publicKey}`,
    );
  }

  quoteTokenAssociatedAddress = tokenAccount.pubkey;

  // load tokens to snipe
  loadSnipeList();
}

export async function processRaydiumPool(
  id: PublicKey,
  poolState: LiquidityStateV4,
) {
  try {
    if (!shouldBuy(poolState.baseMint.toString())) {
      return;
    }

    await buy(id, poolState);
  } catch (e) {
    logger.error({ ...poolState, error: e }, `Failed to process pool`);
  }
}

export async function processOpenBookMarket(
  updatedAccountInfo: KeyedAccountInfo,
) {
  let accountData: MarketStateV3 | undefined;
  try {
    accountData = MARKET_STATE_LAYOUT_V3.decode(
      updatedAccountInfo.accountInfo.data,
    );

    // to be competitive, we collect market data before buying the token...
    if (existingTokenAccounts.has(accountData.baseMint.toString())) {
      return;
    }

    const ata = getAssociatedTokenAddressSync(
      accountData.baseMint,
      wallet.publicKey,
    );
    existingTokenAccounts.set(accountData.baseMint.toString(), <
      MinimalTokenAccountData
    >{
      address: ata,
      mint: accountData.baseMint,
      market: <MinimalMarketLayoutV3>{
        bids: accountData.bids,
        asks: accountData.asks,
        eventQueue: accountData.eventQueue,
      },
    });
  } catch (e) {
    logger.error({ ...accountData, error: e }, `Failed to process market`);
  }
}

async function buy(
  accountId: PublicKey,
  accountData: LiquidityStateV4,
): Promise<void> {
  const tokenAccount = existingTokenAccounts.get(
    accountData.baseMint.toString(),
  );

  if (!tokenAccount) {
    return;
  }

  tokenAccount.poolKeys = createPoolKeys(
    accountId,
    accountData,
    tokenAccount.market!,
  );
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
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 30000 }),
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
  const signature = await solanaConnection.sendRawTransaction(
    transaction.serialize(),
    {
      maxRetries: 20,
      preflightCommitment: commitment,
    },
  );
  logger.info(
    {
      mint: accountData.baseMint,
      url: `https://solscan.io/tx/${signature}?cluster=${network}`,
    },
    'Buy',
  );
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
  return USE_SNIPE_LIST ? snipeList.includes(key) : true;
}

const runListener = async () => {
  await init();
  const runTimestamp = Math.floor(new Date().getTime() / 1000);
  const raydiumSubscriptionId = solanaConnection.onProgramAccountChange(
    RAYDIUM_LIQUIDITY_PROGRAM_ID_V4,
    async (updatedAccountInfo) => {
      const key = updatedAccountInfo.accountId.toString();
      const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(
        updatedAccountInfo.accountInfo.data,
      );
      const poolOpenTime = parseInt(poolState.poolOpenTime.toString());
      const existing = existingLiquidityPools.has(key);

      if (poolOpenTime > runTimestamp && !existing) {
        existingLiquidityPools.add(key);
        const _ = processRaydiumPool(updatedAccountInfo.accountId, poolState);
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
      { dataSize: MARKET_STATE_LAYOUT_V2.span },
      {
        memcmp: {
          offset: MARKET_STATE_LAYOUT_V2.offsetOf('quoteMint'),
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
