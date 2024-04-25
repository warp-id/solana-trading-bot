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
  constructor(private readonly connection: Connection) { }

  public async executeAndConfirm(
    transaction: VersionedTransaction,
    payer: Keypair,
    latestBlockhash: BlockhashWithExpiryBlockHeight,
    simulate: boolean
  ): Promise<{ confirmed: boolean; signature?: string }> {
    logger.debug('Executing transaction...');
    const signature = await this.execute(transaction, payer, simulate);

    logger.debug({ signature }, 'Confirming transaction...');
    return this.confirm(signature, latestBlockhash, simulate);
  }

  private async execute(transaction: Transaction | VersionedTransaction, signer?: Keypair, simulate: boolean = false) {
    if (simulate) {
      const simulateTx = transaction instanceof VersionedTransaction
        ? await this.connection.simulateTransaction(transaction as VersionedTransaction)
        : await this.connection.simulateTransaction(transaction as Transaction,[signer!]);

      logger.debug({ simulateTx }, 'Simulated transaction');
      return simulateTx.value.err ? 'ERROR' : "SUCCESS"
    }

    return this.connection.sendRawTransaction(transaction.serialize(), {
      preflightCommitment: this.connection.commitment,
    });
  }

  private async confirm(signature: string, latestBlockhash: BlockhashWithExpiryBlockHeight, simulate: boolean = false) {

    if (simulate) {
      return { confirmed: true, signature };
    }

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
