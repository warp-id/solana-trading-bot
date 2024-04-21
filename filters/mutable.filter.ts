import { Filter, FilterResult } from './pool-filters';
import { Connection, PublicKey } from '@solana/web3.js';
import { LiquidityPoolKeysV4 } from '@raydium-io/raydium-sdk';
import { getPdaMetadataKey } from '@raydium-io/raydium-sdk';
import { getMetadataAccountDataSerializer, MetadataAccountData, MetadataAccountDataArgs } from '@metaplex-foundation/mpl-token-metadata';
import { Serializer } from '@metaplex-foundation/umi/serializers';
import { logger } from '../helpers';

export class MutableFilter implements Filter {
  constructor(private readonly connection: Connection, private readonly metadataSerializer: Serializer<MetadataAccountDataArgs, MetadataAccountData>) {}

  async execute(poolKeys: LiquidityPoolKeysV4): Promise<FilterResult> {
    try {
      const metadataPDA = getPdaMetadataKey(poolKeys.baseMint);
      const metadataAccount = await this.connection.getAccountInfo(metadataPDA.publicKey);
      if (!metadataAccount?.data) {
        return { ok: false, message: 'Mutable -> Failed to fetch account data' };
      }
      const deserialize = this.metadataSerializer.deserialize(metadataAccount.data);
      const mutable = deserialize[0].isMutable;

      return { ok: !mutable, message: !mutable ? undefined : "Mutable -> Creator can change metadata" };
    } catch (e: any) {
      logger.error({ mint: poolKeys.baseMint }, `Mutable -> Failed to check if metadata are mutable`);
    }

    return { ok: false, message: 'Mutable -> Failed to check if metadata are mutable' };
  }
}
