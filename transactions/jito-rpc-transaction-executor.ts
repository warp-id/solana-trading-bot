import {
  BlockhashWithExpiryBlockHeight,
  Keypair,
  PublicKey,
  SystemProgram,
  Connection,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { TransactionExecutor } from './transaction-executor.interface';
import { logger } from '../helpers';
import axios, { AxiosError } from 'axios';
import bs58 from 'bs58';
import { Currency, CurrencyAmount } from '@raydium-io/raydium-sdk';

export class JitoTransactionExecutor implements TransactionExecutor {
  // https://jito-labs.gitbook.io/mev/searcher-resources/json-rpc-api-reference/bundles/gettipaccounts
  private jitpTipAccounts = [
    'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
    'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
    '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
    '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
    'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
    'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
    'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
    'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  ];

  private JitoFeeWallet: PublicKey;

  constructor(
    private readonly jitoFee: string,
    private readonly connection: Connection,
  ) {
    this.JitoFeeWallet = this.getRandomValidatorKey();
  }

  private getRandomValidatorKey(): PublicKey {
    const randomValidator = this.jitpTipAccounts[Math.floor(Math.random() * this.jitpTipAccounts.length)];
    return new PublicKey(randomValidator);
  }

  public async executeAndConfirm(
    transaction: VersionedTransaction,
    payer: Keypair,
    latestBlockhash: BlockhashWithExpiryBlockHeight,
  ): Promise<{ confirmed: boolean; signature?: string }> {
    logger.debug('Starting Jito transaction execution...');
    this.JitoFeeWallet = this.getRandomValidatorKey(); // Update wallet key each execution
    logger.trace(`Selected Jito fee wallet: ${this.JitoFeeWallet.toBase58()}`);

    try {
      const fee = new CurrencyAmount(Currency.SOL, this.jitoFee, false).raw.toNumber();
      logger.trace(`Calculated fee: ${fee} lamports`);

      const jitTipTxFeeMessage = new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions: [
          SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: this.JitoFeeWallet,
            lamports: fee,
          }),
        ],
      }).compileToV0Message();

      const jitoFeeTx = new VersionedTransaction(jitTipTxFeeMessage);
      jitoFeeTx.sign([payer]);

      const jitoTxsignature = bs58.encode(jitoFeeTx.signatures[0]);

      // Serialize the transactions once here
      const serializedjitoFeeTx = bs58.encode(jitoFeeTx.serialize());
      const serializedTransaction = bs58.encode(transaction.serialize());
      const serializedTransactions = [serializedjitoFeeTx, serializedTransaction];

      // https://jito-labs.gitbook.io/mev/searcher-resources/json-rpc-api-reference/url
      const endpoints = [
        'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
        'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles',
        'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles',
        'https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles',
        'https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles',
      ];

      const requests = endpoints.map((url) =>
        axios.post(url, {
          jsonrpc: '2.0',
          id: 1,
          method: 'sendBundle',
          params: [serializedTransactions],
        }),
      );

      logger.trace('Sending transactions to endpoints...');
      const results = await Promise.all(requests.map((p) => p.catch((e) => e)));

      const successfulResults = results.filter((result) => !(result instanceof Error));

      if (successfulResults.length > 0) {
        logger.trace(`At least one successful response`);
        logger.debug(`Confirming jito transaction...`);
        return await this.confirm(jitoTxsignature, latestBlockhash);
      } else {
        logger.debug(`No successful responses received for jito`);
      }

      return { confirmed: false };
    } catch (error) {
      if (error instanceof AxiosError) {
        logger.trace({ error: error.response?.data }, 'Failed to execute jito transaction');
      }
      logger.error('Error during transaction execution', error);
      return { confirmed: false };
    }
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
