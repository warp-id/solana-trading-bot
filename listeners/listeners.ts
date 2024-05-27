import { LIQUIDITY_STATE_LAYOUT_V4, MAINNET_PROGRAM_ID, MARKET_STATE_LAYOUT_V3, Token } from '@raydium-io/raydium-sdk';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { EventEmitter } from 'events';
import Client, { CommitmentLevel, SubscribeRequest } from '@triton-one/yellowstone-grpc';
import { GRPC_ENDPOINT, logger } from '../helpers';

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
    const client = new Client(GRPC_ENDPOINT, '', {});
    this.stream = await client.subscribe();

    this.stream.on('data', (chunk: any) => {
      let tag = chunk.filters[0];
      this.emit(tag, chunk);
    });

    const request: SubscribeRequest = {
      slots: {},
      accounts: {
        market: {
          account: [],
          owner: [MAINNET_PROGRAM_ID.OPENBOOK_MARKET.toBase58()],
          filters: [
            {
              datasize: MARKET_STATE_LAYOUT_V3.span.toString(),
            },
            {
              memcmp: {
                offset: MARKET_STATE_LAYOUT_V3.offsetOf('quoteMint').toString(),
                bytes: config.quoteToken.mint.toBytes(),
              },
            },
          ],
        },
        pool: {
          account: [],
          owner: [MAINNET_PROGRAM_ID.AmmV4.toBase58()],
          filters: [
            {
              datasize: LIQUIDITY_STATE_LAYOUT_V4.span.toString(),
            },
            {
              memcmp: {
                offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('quoteMint').toString(),
                bytes: config.quoteToken.mint.toBytes(),
              },
            },
            {
              memcmp: {
                offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('marketProgramId').toString(),
                bytes: MAINNET_PROGRAM_ID.OPENBOOK_MARKET.toBytes(),
              },
            },
            {
              memcmp: {
                offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('status').toString(),
                bytes: Buffer.from([6, 0, 0, 0, 0, 0, 0, 0]),
              },
            },
          ],
        },
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
      transactions: {},
      blocks: {},
      blocksMeta: {},
      accountsDataSlice: [],
      commitment: CommitmentLevel.PROCESSED,
      entry: {},
    };

    this.stream.write(request, (error: any) => {
      if (error) {
        logger.error(error);
      }
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
