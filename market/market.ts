import { Commitment, Connection, PublicKey } from '@solana/web3.js';
import {
  GetStructureSchema,
  MARKET_STATE_LAYOUT_V3,
} from '@raydium-io/raydium-sdk';
import {
  MINIMAL_MARKET_STATE_LAYOUT_V3,
  OPENBOOK_PROGRAM_ID,
} from '../liquidity';

export type MinimalOpenBookAccountData = {
  id: PublicKey;
  programId: PublicKey;
};
export type MinimalMarketStateLayoutV3 = typeof MINIMAL_MARKET_STATE_LAYOUT_V3;
export type MinimalMarketLayoutV3 =
  GetStructureSchema<MinimalMarketStateLayoutV3>;

export async function getAllMarketsV3(
  connection: Connection,
  quoteMint: PublicKey,
  commitment?: Commitment,
): Promise<MinimalOpenBookAccountData[]> {
  const { span } = MARKET_STATE_LAYOUT_V3;
  const accounts = await connection.getProgramAccounts(OPENBOOK_PROGRAM_ID, {
    dataSlice: { offset: 0, length: 0 },
    commitment: commitment,
    filters: [
      { dataSize: span },
      {
        memcmp: {
          offset: MARKET_STATE_LAYOUT_V3.offsetOf('quoteMint'),
          bytes: quoteMint.toBase58(),
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
