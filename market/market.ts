import {PublicKey } from '@solana/web3.js';
import {
  GetStructureSchema,
} from '@raydium-io/raydium-sdk';
import {
  MINIMAL_MARKET_STATE_LAYOUT_V3,
  OPENBOOK_PROGRAM_ID,
} from '../liquidity';
import axios from 'axios';

interface AccountData {
  data: string[];
  executable: boolean;
  lamports: number;
  owner: string;
  rentEpoch: number;
  space: number;
}

interface MarketAccount {
  account: AccountData;
  pubkey: string;
}

interface JsonResponse {
  jsonrpc: string;
  result: MarketAccount[];
}

export type MinimalOpenBookAccountData = {
  id: PublicKey;
  programId: PublicKey;
};
export type MinimalMarketStateLayoutV3 = typeof MINIMAL_MARKET_STATE_LAYOUT_V3;
export type MinimalMarketLayoutV3 =
  GetStructureSchema<MinimalMarketStateLayoutV3>;

export async function getAllMarketsV3(
): Promise<{ id: string; programId: PublicKey }[]> {
  const url = 'https://cache.prism.ag/openbook.json';

  try {
    const response = await axios.get<JsonResponse>(url);
    // @ts-ignore
    const json: JsonResponse = response.data;

    return json.result
      .map(account => ({
        id: account.pubkey,
        programId: OPENBOOK_PROGRAM_ID,
      }));
  } catch (error) {
    console.error('Error during data retrieval:', error);
    return [];
  }
}
