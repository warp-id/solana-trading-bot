import {
  Liquidity,
  LIQUIDITY_STATE_LAYOUT_V4,
  LiquidityStateV4,
  MARKET_STATE_LAYOUT_V2,
} from '@raydium-io/raydium-sdk';
import { getOrCreateAssociatedTokenAccount } from '@solana/spl-token';
import {
  Keypair,
  Connection,
  PublicKey,
  ComputeBudgetProgram,
  KeyedAccountInfo,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import secret from './wallet.json';
import {
  getAllAccountsV4,
  getTokenAccounts,
  getAccountPoolKeysFromAccountDataV4,
  RAYDIUM_LIQUIDITY_PROGRAM_ID_V4,
  OPENBOOK_PROGRAM_ID,
} from './liquidity';
import { retry } from './utils';
import { USDC_AMOUNT, USDC_TOKEN_ID } from './common';
import { getAllMarketsV3 } from './market';
import pino from 'pino';

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
      error: pino.stdSerializers.err
    },
    base: undefined,
  },
  transport,
);

const network = 'mainnet-beta';
const solanaConnection = new Connection(
  'ENTER RPC ENDPOINT HERE',
  {
    wsEndpoint:
     'ENTER RPC WEBSOCKET ENDPOINT HERE',
  },
);

export type MinimalTokenAccountData = {
  mint: PublicKey;
  address: PublicKey;
};

let existingLiquidityPools: Set<string> = new Set<string>();
let existingOpenBookMarkets: Set<string> = new Set<string>();
let existingTokenAccounts: Map<string, MinimalTokenAccountData> = new Map<
  string,
  MinimalTokenAccountData
>();

let wallet: Keypair;
let usdcTokenKey: PublicKey;

async function init(): Promise<void> {
  wallet = Keypair.fromSecretKey(new Uint8Array(secret));
  logger.info(`Wallet Address: ${wallet.publicKey.toString()}`);
  const allLiquidityPools = await getAllAccountsV4(solanaConnection);
  existingLiquidityPools = new Set(
    allLiquidityPools.map((p) => p.id.toString()),
  );
  const allMarkets = await getAllMarketsV3(solanaConnection);
  existingOpenBookMarkets = new Set(allMarkets.map((p) => p.id.toString()));
  const tokenAccounts = await getTokenAccounts(
    solanaConnection,
    wallet.publicKey,
  );
  logger.info(`Total USDC markets ${existingOpenBookMarkets.size}`);
  logger.info(`Total USDC pools ${existingLiquidityPools.size}`);
  tokenAccounts.forEach((ta) => {
    existingTokenAccounts.set(ta.accountInfo.mint.toString(), <
      MinimalTokenAccountData
    >{
      mint: ta.accountInfo.mint,
      address: ta.pubkey,
    });
  });
  const token = tokenAccounts.find(
    (acc) => acc.accountInfo.mint.toString() === USDC_TOKEN_ID.toString(),
  )!;
  usdcTokenKey = token!.pubkey;
}

export async function processRaydiumPool(updatedAccountInfo: KeyedAccountInfo) {
  let accountData: LiquidityStateV4 | undefined;
  try {
    accountData = LIQUIDITY_STATE_LAYOUT_V4.decode(
      updatedAccountInfo.accountInfo.data,
    );
    await buy(updatedAccountInfo.accountId, accountData);
  } catch (e) {
    logger.error({ ...accountData, error: e }, `Failed to process pool`);
  }
}

export async function processOpenBookMarket(
  updatedAccountInfo: KeyedAccountInfo,
) {
  let accountData: any;
  try {
    accountData = MARKET_STATE_LAYOUT_V2.decode(
      updatedAccountInfo.accountInfo.data,
    );

    // to be competitive, we create token account before buying the token...
    if (existingTokenAccounts.has(accountData.baseMint.toString())) {
      return;
    }

    const destinationAccount = await getOrCreateAssociatedTokenAccount(
      solanaConnection,
      wallet,
      accountData.baseMint,
      wallet.publicKey,
    );
    existingTokenAccounts.set(accountData.baseMint.toString(), <
      MinimalTokenAccountData
    >{
      address: destinationAccount.address,
      mint: destinationAccount.mint,
    });
    logger.info(
      accountData,
      `Created destination account: ${destinationAccount.address}`,
    );
  } catch (e) {
    logger.error({ ...accountData, error: e }, `Failed to process market`);
  }
}

async function buy(accountId: PublicKey, accountData: any): Promise<void> {
  const [poolKeys, latestBlockhash] = await Promise.all([
    getAccountPoolKeysFromAccountDataV4(
      solanaConnection,
      accountId,
      accountData,
    ),
    solanaConnection.getLatestBlockhash({ commitment: 'processed' }),
  ]);

  const { innerTransaction, address } = Liquidity.makeSwapFixedInInstruction(
    {
      poolKeys,
      userKeys: {
        tokenAccountIn: usdcTokenKey,
        tokenAccountOut: existingTokenAccounts.get(
          poolKeys.baseMint.toString(),
        )!.address,
        owner: wallet.publicKey,
      },
      amountIn: USDC_AMOUNT * 1000000,
      minAmountOut: 0,
    },
    poolKeys.version,
  );

  const messageV0 = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: latestBlockhash.blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 30000 }),
      ...innerTransaction.instructions,
    ],
  }).compileToV0Message();
  const transaction = new VersionedTransaction(messageV0);
  transaction.sign([wallet, ...innerTransaction.signers]);
  const rawTransaction = transaction.serialize();
  const signature = await retry(
    () =>
      solanaConnection.sendRawTransaction(rawTransaction, {
        skipPreflight: true,
      }),
    { retryIntervalMs: 10, retries: 50 }, // TODO handle retries more efficiently
  );
  logger.info(
    {
      ...accountData,
      url: `https://solscan.io/tx/${signature}?cluster=${network}`,
    },
    'Buy',
  );
}

const runListener = async () => {
  await init();
  const raydiumSubscriptionId = solanaConnection.onProgramAccountChange(
    RAYDIUM_LIQUIDITY_PROGRAM_ID_V4,
    async (updatedAccountInfo) => {
      const existing = existingLiquidityPools.has(
        updatedAccountInfo.accountId.toString(),
      );
      if (!existing) {
        existingLiquidityPools.add(updatedAccountInfo.accountId.toString());
        const _ = processRaydiumPool(updatedAccountInfo);
      }
    },
    'processed',
    [
      { dataSize: LIQUIDITY_STATE_LAYOUT_V4.span },
      {
        memcmp: {
          offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('quoteMint'),
          bytes: USDC_TOKEN_ID.toBase58(),
        },
      },
      {
        memcmp: {
          offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('marketProgramId'),
          bytes: OPENBOOK_PROGRAM_ID.toBase58(),
        },
      },
    ],
  );

  const openBookSubscriptionId = solanaConnection.onProgramAccountChange(
    OPENBOOK_PROGRAM_ID,
    async (updatedAccountInfo) => {
      const existing = existingOpenBookMarkets.has(
        updatedAccountInfo.accountId.toString(),
      );
      if (!existing) {
        existingOpenBookMarkets.add(updatedAccountInfo.accountId.toString());
        const _ = processOpenBookMarket(updatedAccountInfo);
      }
    },
    'processed',
    [
      { dataSize: MARKET_STATE_LAYOUT_V2.span },
      {
        memcmp: {
          offset: MARKET_STATE_LAYOUT_V2.offsetOf('quoteMint'),
          bytes: USDC_TOKEN_ID.toBase58(),
        },
      },
    ],
  );

  logger.info(`Listening for raydium changes: ${raydiumSubscriptionId}`);
  logger.info(`Listening for open book changes: ${openBookSubscriptionId}`);
};

runListener();
