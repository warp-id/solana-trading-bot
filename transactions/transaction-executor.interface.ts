import { BlockhashWithExpiryBlockHeight, Keypair, VersionedTransaction } from '@solana/web3.js';

export interface TransactionExecutor {
  executeAndConfirm(
    transaction: VersionedTransaction,
    payer: Keypair,
    latestBlockHash: BlockhashWithExpiryBlockHeight,
    simulate: boolean,
  ): Promise<{ confirmed: boolean; signature?: string, error?: string }>;
}
