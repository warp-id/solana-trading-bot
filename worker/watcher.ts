// sellWorker.ts
import { parentPort, workerData } from 'worker_threads';
import { PublicKey, TokenAmount, Connection, Commitment } from '@solana/web3.js';
import { LIQUIDITY_STATE_LAYOUT_V4, Liquidity, SPL_ACCOUNT_LAYOUT, TOKEN_PROGRAM_ID, TokenAccount } from '@raydium-io/raydium-sdk';
import { retrieveEnvVariable } from '../utils';
import BN from 'bn.js';
import pino from 'pino';

const transport = pino.transport({
  targets: [
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

async function getTokenAccounts(connection: Connection, owner: PublicKey) {
  const tokenResp = await connection.getTokenAccountsByOwner(owner, {
    programId: TOKEN_PROGRAM_ID
  });

  const accounts: TokenAccount[] = [];
  for (const { pubkey, account } of tokenResp.value) {
    accounts.push({
      pubkey,
      accountInfo: SPL_ACCOUNT_LAYOUT.decode(account.data),
      programId: new PublicKey(account.owner.toBase58())
    });
  }

  return accounts;
}

const SOL_SDC_POOL_ID = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
const OPENBOOK_PROGRAM_ID = new PublicKey(
  "srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX"
);

async function parsePoolInfo() {
  const network = 'mainnet-beta';
  const RPC_ENDPOINT = retrieveEnvVariable('RPC_ENDPOINT', logger);
  const RPC_WEBSOCKET_ENDPOINT = retrieveEnvVariable(
    'RPC_WEBSOCKET_ENDPOINT',
    logger,
  );

  const connection = new Connection(RPC_ENDPOINT, {
    wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
  });
  const owner = new PublicKey("VnxDzsZ7chE88e9rB6UKztCt2HUwrkgCTx8WieWf5mM");

  const tokenAccounts = await getTokenAccounts(connection, owner);

  // example to get pool info
  const info = await connection.getAccountInfo(new PublicKey(SOL_SDC_POOL_ID));
  if (!info) {
    throw new Error("Pool not found");
  }

  const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(info.data);

  const baseDecimal = 10 ** poolState.baseDecimal.toNumber();
  const quoteDecimal = 10 ** poolState.quoteDecimal.toNumber();

  const baseTokenAmount = await connection.getTokenAccountBalance(
    poolState.baseVault
  )

  const quoteTokenAmount = await connection.getTokenAccountBalance(
    poolState.quoteVault
  )

  const basePnl = poolState.baseNeedTakePnl.toNumber() / baseDecimal;
  const quotePnl = poolState.quoteNeedTakePnl.toNumber() / quoteDecimal;

  const base = (baseTokenAmount.value?.uiAmount || 0) - basePnl;
  const quote = (quoteTokenAmount.value?.uiAmount || 0) - quotePnl;

  const denominator = new BN(10).pow(poolState.baseDecimal);

  const addedLpAccount = tokenAccounts.find((a) => a.accountInfo.mint.equals(poolState.lpMint));

  const message = `
  SOL - USDC Pool Info:
  
  Pool total base: ${base},
  Pool total quote: ${quote},

  Base vault balance: ${baseTokenAmount.value.uiAmount},
  Quote vault balance: ${quoteTokenAmount.value.uiAmount},

  Base token decimals: ${poolState.baseDecimal.toNumber()},
  Quote token decimals: ${poolState.quoteDecimal.toNumber()},
  Total LP: ${poolState.lpReserve.div(denominator).toString()},

  Added LP amount: ${(addedLpAccount?.accountInfo.amount.toNumber() || 0) / baseDecimal},
  `;

  logger.info(message);

  // send message to discord (embed)
  // post to discord webhook
  let embed = {
    embeds: [
      {
        title: "SOL - USDC Pool Info",
        description: `
        Pool total base: **${base}**,
        Pool total quote: **${quote}**,

        Base vault balance: **${baseTokenAmount.value.uiAmount}**,
        Quote vault balance: **${quoteTokenAmount.value.uiAmount}**,

        Base token decimals:** ${poolState.baseDecimal.toNumber()}**,
        Quote token decimals:** ${poolState.quoteDecimal.toNumber()}**,

        Total LP: **${poolState.lpReserve.div(denominator).toString()}**,
        Added LP amount: **${(addedLpAccount?.accountInfo.amount.toNumber() || 0) / baseDecimal}**

        Happy trading! 🚀
        `
      }

    ]

  };

  const DISCORD_WEBHOOK = retrieveEnvVariable('DISCORD_WEBHOOK', logger);
  // use native fetch to post to discord
  fetch(DISCORD_WEBHOOK, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(embed),
  });

  logger.info("Message sent to Discord");

}

// Function to periodically check the pool
async function checkPoolPeriodically(interval: number) {
  while (true) {
    await parsePoolInfo();
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

// Check pool periodically with a specified interval
checkPoolPeriodically(60000); // 1 minute
