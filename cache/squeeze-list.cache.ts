import { MetadataAccountData, MetadataAccountDataArgs } from "@metaplex-foundation/mpl-token-metadata";
import { getPdaMetadataKey } from "@raydium-io/raydium-sdk";
import { Connection, PublicKey } from "@solana/web3.js";
import { Serializer } from '@metaplex-foundation/umi/serializers';
import { MintLayout } from "@solana/spl-token";

export class SqueezeListCache {

  private squeezeList: string[] = [
    "GH8GPjSX9XNvxsVaJHg9KfEXVovqtiY5pyhu8vYrwjTb"
  ];


  constructor(private readonly metadataSerializer: Serializer<MetadataAccountDataArgs, MetadataAccountData>) { }

  public async doWeSqueezeThatFucker(mint: PublicKey, connection: Connection): Promise<boolean> {
    const metadataPDA = getPdaMetadataKey(mint);
    const metadataAccount = await connection.getAccountInfo(metadataPDA.publicKey, connection.commitment);

    if (!metadataAccount?.data) {
      return false;
    }

    const deserialize = this.metadataSerializer.deserialize(metadataAccount.data);
    if (this.squeezeList.includes(deserialize[0].updateAuthority.toString())) {
      const accountInfo = await connection.getAccountInfo(mint, connection.commitment);
      if (!accountInfo?.data) {
        return false;
      }
      const deserialize = MintLayout.decode(accountInfo.data);

      const renounced = deserialize.mintAuthorityOption === 0;
      const freezable = deserialize.freezeAuthorityOption !== 0;

      return renounced && !freezable;
    }

    return false;
  }
}
