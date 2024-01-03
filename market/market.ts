import { Connection, PublicKey } from '@solana/web3.js';
import {
  MARKET_STATE_LAYOUT_V3,
} from '@raydium-io/raydium-sdk';
import { USDC_TOKEN_ID } from '../common';
import {
  OPENBOOK_PROGRAM_ID,

} from '../liquidity';

export type MinimalOpenBookAccountData = {
  id: PublicKey;
  programId: PublicKey;
};

export async function getAllMarketsV3(
  connection: Connection,
): Promise<MinimalOpenBookAccountData[]> {
  const { span } = MARKET_STATE_LAYOUT_V3;
  const accounts = await connection.getProgramAccounts(OPENBOOK_PROGRAM_ID, {
    dataSlice: { offset: 0, length: 0 },
    commitment: 'processed',
    filters: [
      { dataSize: span },
      {
        memcmp: {
          offset: MARKET_STATE_LAYOUT_V3.offsetOf('quoteMint'),
          bytes: USDC_TOKEN_ID.toBase58(),
        },
      },
    ],
  });

  return accounts.map(
    (info) =>
      <MinimalOpenBookAccountData>{
        id: info.pubkey,
        programId: OPENBOOK_PROGRAM_ID,
      },
  );
}
