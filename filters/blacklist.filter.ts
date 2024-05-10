import { Filter, FilterResult } from './pool-filters';
import { Connection, PublicKey } from '@solana/web3.js';
import { LiquidityPoolKeysV4 } from '@raydium-io/raydium-sdk';
import { getPdaMetadataKey } from '@raydium-io/raydium-sdk';
import { MetadataAccountData, MetadataAccountDataArgs } from '@metaplex-foundation/mpl-token-metadata';
import { Serializer } from '@metaplex-foundation/umi/serializers';
import { logger } from '../helpers';

export class BlacklistFilter implements Filter {

  constructor(
    private readonly connection: Connection,
    private readonly metadataSerializer: Serializer<MetadataAccountDataArgs, MetadataAccountData>
  ) { }

  async execute(poolKeys: LiquidityPoolKeysV4): Promise<FilterResult> {
    try {

      let blacklist = [
        "8N57pYk1SoHkBZcPMhyJMJCLLfEyHMq3SqYn63W9RoVG",
        "GH8GPjSX9XNvxsVaJHg9KfEXVovqtiY5pyhu8vYrwjTb"
      ];

      const metadataPDA = getPdaMetadataKey(poolKeys.baseMint);
      const metadataAccount = await this.connection.getAccountInfo(metadataPDA.publicKey, this.connection.commitment);

      if (!metadataAccount?.data) {
        return { ok: false, message: 'Blacklist -> Failed to fetch account data' };
      }

      const deserialize = this.metadataSerializer.deserialize(metadataAccount.data);

      if (blacklist.includes(deserialize[0].updateAuthority.toString())) {
        return { ok: false, message: `Blacklist -> ${deserialize[0].updateAuthority.toString()} fuck this guy!` };
      }

      return { ok: true, message: undefined };

    } catch (e) {
      logger.error({ mint: poolKeys.baseMint }, `Blacklist -> Failed to check blacklist`);
    }

    return {
      ok: false,
      message: `Blacklist -> Failed to check for cringe`,
    };
  }
}
