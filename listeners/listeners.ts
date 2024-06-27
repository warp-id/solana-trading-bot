import { Token } from '@raydium-io/raydium-sdk';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { EventEmitter } from 'events';
import Client, { CommitmentLevel, SubscribeRequest } from '@triton-one/yellowstone-grpc';
import { GRPC_ENDPOINT, GRPC_TOKEN } from '../helpers';

const createPoolFeeAccount = '7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5';

export class Listeners extends EventEmitter {
  private stream: any;

  constructor() {
    super();
  }

  public async start(config: {
    walletPublicKey: PublicKey;
    quoteToken: Token;
    autoSell: boolean;
    cacheNewMarkets: boolean;
  }) {
    const client = new Client(GRPC_ENDPOINT, GRPC_TOKEN, {});
    this.stream = await client.subscribe();

    this.stream.on('data', (chunk: any) => {
      let tag = chunk.filters[0];
      this.emit(tag, chunk);
    });

    const request: SubscribeRequest = {
      slots: {},
      accounts: {
        wallet: {
          account: [],
          owner: [TOKEN_PROGRAM_ID.toBase58()],
          filters: [
            {
              datasize: '165',
            },
            {
              memcmp: {
                offset: '32',
                bytes: config.walletPublicKey.toBytes(),
              },
            },
          ],
        },
      },
      transactions: {
        pool: {
          accountInclude: [createPoolFeeAccount],
          accountExclude: [],
          accountRequired: [],
        },
      },
      blocks: {},
      blocksMeta: {},
      accountsDataSlice: [],
      commitment: CommitmentLevel.CONFIRMED,
      entry: {},
    };

    await new Promise<void>((resolve, reject) => {
      this.stream.write(request, (err: any) => {
        if (err === null || err === undefined) {
          resolve();
        } else {
          reject(err);
        }
      });
    }).catch((reason) => {
      console.error(reason);
      throw reason;
    });
  }

  public async stop() {
    const request = {
      slots: {},
      accounts: {},
      transactions: {},
      blocks: {},
      blocksMeta: {},
      accountsDataSlice: [],
    };

    this.stream.write(request);
  }
}
