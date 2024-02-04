import { Commitment, Connection, PublicKey } from '@solana/web3.js';
import {
  Liquidity,
  LiquidityPoolKeys,
  Market,
  TokenAccount,
  SPL_ACCOUNT_LAYOUT,
  publicKey,
  struct,
  MAINNET_PROGRAM_ID,
  LiquidityStateV4,
} from '@raydium-io/raydium-sdk';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { MinimalMarketLayoutV3 } from '../market';
import bs58 from 'bs58';
import axios from 'axios';

interface LiquidityPool {
  id: string;
  baseMint: string;
  quoteMint: string;
  // ... autres propriétés
}

interface LiquidityJsonResponse {
  official: LiquidityPool[];
  unOfficial: LiquidityPool[];
}

interface MinimalLiquidityAccountData {
  id: string;
  version: number;
  programId: string;
}

export const RAYDIUM_LIQUIDITY_PROGRAM_ID_V4 = MAINNET_PROGRAM_ID.AmmV4;
export const OPENBOOK_PROGRAM_ID = MAINNET_PROGRAM_ID.OPENBOOK_MARKET;

export const MINIMAL_MARKET_STATE_LAYOUT_V3 = struct([
  publicKey('eventQueue'),
  publicKey('bids'),
  publicKey('asks'),
]);

export async function getAllAccountsV4(
  quoteMint: PublicKey,
): Promise<{ id: string; version: number; programId: PublicKey }[]> {
  const url = 'https://api.raydium.io/v2/sdk/liquidity/mainnet.json';
  try {
    const response = await axios.get<LiquidityJsonResponse>(url);
    // @ts-ignore
    const json = response.data;
    const filteredPools = json.official.concat(json.unOfficial)
      .filter(pool => {
        if (!pool) {
          console.log('Pool undefined:', pool);
          return false;
        }
        return pool.quoteMint && pool.quoteMint === quoteMint.toBase58();
      });
    return filteredPools.map(pool => ({
      id: pool.id,
      version: 4,
      programId: RAYDIUM_LIQUIDITY_PROGRAM_ID_V4, // Assurez-vous que cette constante est définie
    }));
  } catch (error) {
    console.error('Error during data retrieval:', error);
    return [];
  }
}

export function createPoolKeys(
  id: PublicKey,
  accountData: LiquidityStateV4,
  minimalMarketLayoutV3: MinimalMarketLayoutV3,
): LiquidityPoolKeys {
  return {
    id,
    baseMint: accountData.baseMint,
    quoteMint: accountData.quoteMint,
    lpMint: accountData.lpMint,
    baseDecimals: accountData.baseDecimal.toNumber(),
    quoteDecimals: accountData.quoteDecimal.toNumber(),
    lpDecimals: 5,
    version: 4,
    programId: RAYDIUM_LIQUIDITY_PROGRAM_ID_V4,
    authority: Liquidity.getAssociatedAuthority({
      programId: RAYDIUM_LIQUIDITY_PROGRAM_ID_V4,
    }).publicKey,
    openOrders: accountData.openOrders,
    targetOrders: accountData.targetOrders,
    baseVault: accountData.baseVault,
    quoteVault: accountData.quoteVault,
    marketVersion: 3,
    marketProgramId: accountData.marketProgramId,
    marketId: accountData.marketId,
    marketAuthority: Market.getAssociatedAuthority({
      programId: accountData.marketProgramId,
      marketId: accountData.marketId,
    }).publicKey,
    marketBaseVault: accountData.baseVault,
    marketQuoteVault: accountData.quoteVault,
    marketBids: minimalMarketLayoutV3.bids,
    marketAsks: minimalMarketLayoutV3.asks,
    marketEventQueue: minimalMarketLayoutV3.eventQueue,
    withdrawQueue: accountData.withdrawQueue,
    lpVault: accountData.lpVault,
    lookupTableAccount: PublicKey.default,
  };
}

export async function getAccountPoolKeysFromAccountDataV4(
  connection: Connection,
  id: PublicKey,
  accountData: LiquidityStateV4,
  commitment?: Commitment,
): Promise<LiquidityPoolKeys> {
  const marketInfo = await connection.getAccountInfo(accountData.marketId, {
    commitment: commitment,
    dataSlice: {
      offset: 253, // eventQueue
      length: 32 * 3,
    },
  });

  const minimalMarketData = MINIMAL_MARKET_STATE_LAYOUT_V3.decode(
    marketInfo!.data,
  );

  return {
    id,
    baseMint: accountData.baseMint,
    quoteMint: accountData.quoteMint,
    lpMint: accountData.lpMint,
    baseDecimals: accountData.baseDecimal.toNumber(),
    quoteDecimals: accountData.quoteDecimal.toNumber(),
    lpDecimals: 5,
    version: 4,
    programId: RAYDIUM_LIQUIDITY_PROGRAM_ID_V4,
    authority: Liquidity.getAssociatedAuthority({
      programId: RAYDIUM_LIQUIDITY_PROGRAM_ID_V4,
    }).publicKey,
    openOrders: accountData.openOrders,
    targetOrders: accountData.targetOrders,
    baseVault: accountData.baseVault,
    quoteVault: accountData.quoteVault,
    marketVersion: 3,
    marketProgramId: accountData.marketProgramId,
    marketId: accountData.marketId,
    marketAuthority: Market.getAssociatedAuthority({
      programId: accountData.marketProgramId,
      marketId: accountData.marketId,
    }).publicKey,
    marketBaseVault: accountData.baseVault,
    marketQuoteVault: accountData.quoteVault,
    marketBids: minimalMarketData.bids,
    marketAsks: minimalMarketData.asks,
    marketEventQueue: minimalMarketData.eventQueue,
    withdrawQueue: accountData.withdrawQueue,
    lpVault: accountData.lpVault,
    lookupTableAccount: PublicKey.default,
  };
}

export async function getTokenAccounts(
  connection: Connection,
  owner: PublicKey,
  commitment?: Commitment,
) {
  const tokenResp = await connection.getTokenAccountsByOwner(
    owner,
    {
      programId: TOKEN_PROGRAM_ID,
    },
    commitment,
  );

  const accounts: TokenAccount[] = [];
  for (const { pubkey, account } of tokenResp.value) {
    accounts.push({
      pubkey,
      programId: account.owner,
      accountInfo: SPL_ACCOUNT_LAYOUT.decode(account.data),
    });
  }

  return accounts;
}
