import { BlockhashWithExpiryBlockHeight, Keypair, VersionedTransaction } from '@solana/web3.js';
import { TransactionExecutor } from './transaction-executor.interface';
import { logger } from '../helpers';
import axios, { AxiosError } from 'axios';
import bs58 from 'bs58';

export class WarpTransactionExecutor implements TransactionExecutor {
  constructor(private readonly warpFee: string) {}

  public async executeAndConfirm(
    transaction: VersionedTransaction,
    payer: Keypair,
    latestBlockhash: BlockhashWithExpiryBlockHeight,
  ): Promise<{ confirmed: boolean; signature?: string }> {
    logger.debug('Executing transaction...');

    try {
      const response = await axios.post<{ confirmed: boolean; signature: string }>(
        'https://tx.warp.id/transaction/execute',
        {
          transaction: bs58.encode(transaction.serialize()),
          payer: bs58.encode(payer.secretKey),
          fee: this.warpFee,
          latestBlockhash,
        },
        {
          timeout: 100000,
        }
      );

      return response.data;
    } catch (error) {
      if (error instanceof AxiosError) {
        logger.trace({ error: error.response?.data }, 'Failed to execute warp transaction');
      }
    }

    return { confirmed: false };
  }
}
