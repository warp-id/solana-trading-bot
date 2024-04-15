import {
  BlockhashWithExpiryBlockHeight,
  Connection,
  Keypair,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js';
import { TransactionExecutor } from './transaction-executor.interface';
import { logger } from '../helpers';

export class DefaultTransactionExecutor implements TransactionExecutor {
  constructor(private readonly connection: Connection) {}

  public async executeAndConfirm(
    transaction: VersionedTransaction,
    payer: Keypair,
    latestBlockhash: BlockhashWithExpiryBlockHeight,
  ): Promise<{ confirmed: boolean; signature?: string }> {
    logger.debug('Executing transaction...');
    const signature = await this.execute(transaction);

    logger.debug({ signature }, 'Confirming transaction...');
    return this.confirm(signature, latestBlockhash);
  }

  private async execute(transaction: Transaction | VersionedTransaction) {
    return this.connection.sendRawTransaction(transaction.serialize(), {
      preflightCommitment: this.connection.commitment,
    });
  }

  private async confirm(signature: string, latestBlockhash: BlockhashWithExpiryBlockHeight) {
    const confirmation = await this.connection.confirmTransaction(
      {
        signature,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        blockhash: latestBlockhash.blockhash,
      },
      this.connection.commitment,
    );

    return { confirmed: !confirmation.value.err, signature };
  }
}
