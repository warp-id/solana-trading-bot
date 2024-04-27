import { Filter, FilterResult } from './pool-filters';
import { Connection } from '@solana/web3.js';
import { LiquidityPoolKeysV4 } from '@raydium-io/raydium-sdk';
import { getPdaMetadataKey } from '@raydium-io/raydium-sdk';
import { MetadataAccountData, MetadataAccountDataArgs } from '@metaplex-foundation/mpl-token-metadata';
import { Serializer } from '@metaplex-foundation/umi/serializers';
import { logger } from '../helpers';

export class MutableFilter implements Filter {
  constructor(private readonly connection: Connection, private readonly metadataSerializer: Serializer<MetadataAccountDataArgs, MetadataAccountData>, private readonly checkMutable: boolean, private readonly checkSocials: boolean) {}

  async execute(poolKeys: LiquidityPoolKeysV4): Promise<FilterResult> {
    const errorMessage = [ this.checkMutable ? 'mutable' : undefined, this.checkSocials ? 'socials' : undefined ].filter((e) => e !== undefined);
    try {
      const metadataPDA = getPdaMetadataKey(poolKeys.baseMint);
      const metadataAccount = await this.connection.getAccountInfo(metadataPDA.publicKey);
      if (!metadataAccount?.data) {
        return { ok: false, message: 'Mutable -> Failed to fetch account data' };
      }
      const deserialize = this.metadataSerializer.deserialize(metadataAccount.data);
      const mutable = this.checkMutable ? deserialize[0].isMutable: false;

      const hasSocials = this.checkSocials ? (Object.values(await this.getSocials(deserialize[0])).some((value: any) => value !== null && value.length > 0)) === true: true;

      const message = [ !mutable ? undefined : 'metadata can be changed', hasSocials ? undefined : 'has no socials' ].filter((e) => e !== undefined);
      const ok = !mutable && hasSocials;

      return { ok: ok, message: ok ? undefined : `MutableSocials -> Token ${message.join(' and ')}` };
    } catch (e) {
      logger.error({ mint: poolKeys.baseMint, error: e }, `MutableSocials -> Failed to check ${errorMessage.join(' and ')}`);
      return { ok: false, message: `MutableSocials -> Failed to check ${errorMessage.join(' and ')}` };
    }

    logger.error({ mint: poolKeys.baseMint }, `MutableSocials -> Failed to check ${errorMessage.join(' and ')}`);
    return { ok: false, message: `MutableSocials -> Failed to check ${errorMessage.join(' and ')}` };
  }

  async getSocials(metadata: MetadataAccountData): Promise<Object> {
    const response = await fetch(metadata.uri);
    const data = await response.json();
    return data?.extensions;
  }
}
