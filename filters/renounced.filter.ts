import { Filter, FilterResult } from './pool-filters';
import { MintLayout } from '@solana/spl-token';
import { Connection } from '@solana/web3.js';
import { LiquidityPoolKeysV4 } from '@raydium-io/raydium-sdk';
import { logger } from '../helpers';

export class RenouncedFilter implements Filter {
  constructor(private readonly connection: Connection) {}

  async execute(poolKeys: LiquidityPoolKeysV4): Promise<FilterResult> {
    try {
      const accountInfo = await this.connection.getAccountInfo(poolKeys.baseMint, this.connection.commitment);
      if (!accountInfo?.data) {
        return { ok: false, message: 'Renounced -> Failed to fetch account data' };
      }

      const deserialize = MintLayout.decode(accountInfo.data);
      const renounced = deserialize.mintAuthorityOption === 0;
      return { ok: renounced, message: renounced ? undefined : 'Renounced -> Creator can mint more tokens' };
    } catch (e) {
      logger.error({ mint: poolKeys.baseMint }, `Failed to check if mint is renounced`);
    }

    return { ok: false, message: 'Renounced -> Failed to check if mint is renounced' };
  }
}
