import { Filter, FilterResult } from './pool-filters';
import { MintLayout } from '@solana/spl-token';
import { Connection } from '@solana/web3.js';
import { LiquidityPoolKeysV4 } from '@raydium-io/raydium-sdk';
import { logger } from '../helpers';

export class RenouncedFreezeFilter implements Filter {
  constructor(private readonly connection: Connection, private readonly checkRenounced: boolean, private readonly checkFreezable: boolean) {}

  async execute(poolKeys: LiquidityPoolKeysV4): Promise<FilterResult> {
    const errorMessage = [ this.checkRenounced ? 'mint' : undefined, this.checkFreezable ? 'freeze' : undefined ].filter((e) => e !== undefined);
    try {
      const accountInfo = await this.connection.getAccountInfo(poolKeys.baseMint, this.connection.commitment);
      if (!accountInfo?.data) {
        return { ok: false, message: 'Failed to fetch account data' };
      }

      const deserialize = MintLayout.decode(accountInfo.data);
      const renounced = !this.checkRenounced || deserialize.mintAuthorityOption === 0;
      const freezable = !this.checkFreezable || deserialize.freezeAuthorityOption !== 0;

      const message = [ renounced ? undefined : 'mint', !freezable ? undefined : 'freeze' ].filter((e) => e !== undefined);
      const ok = renounced && !freezable;

      return { ok: ok, message: ok ? undefined : `RenouncedFreeze -> Creator can ${message.join(' and ')} tokens` };
    } catch (e) {
      logger.error({ mint: poolKeys.baseMint }, `RenouncedFreeze -> Failed to check if creator can ${errorMessage.join(' and ')} tokens`);
    }

    return { ok: false, message: `RenouncedFreeze -> Failed to check if creator can ${errorMessage.join(' and ')} tokens` };
  }
}
