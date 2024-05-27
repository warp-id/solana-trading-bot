import Client, { CommitmentLevel, SubscribeRequest } from '@triton-one/yellowstone-grpc';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { LIQUIDITY_STATE_LAYOUT_V4, MAINNET_PROGRAM_ID, MARKET_STATE_LAYOUT_V3, Token } from '@raydium-io/raydium-sdk';
import bs58 from 'bs58';

(async function main() {
  const client = new Client('http://gastroscopic-agars-gGx9fjhXm7.helius-rpc.com:4001', '', {});

  const stream = await client.subscribe();

  stream.on('data', (chunk: any) => {
    if (chunk.filters[0] === 'ammv4') {
      const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(chunk.account.account.data);
      const poolOpenTime = parseInt(poolState.poolOpenTime.toString());

      console.log('ammv4', chunk, poolState, poolOpenTime);
    } else if (chunk.filters[0] === 'market') {
      const marketState = MARKET_STATE_LAYOUT_V3.decode(chunk.account.account.data);
      console.log('market', chunk, marketState, bs58.encode(chunk.account.account.pubkey).toString() );
    } else {
      console.log('data', chunk);
    }
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
              bytes: bs58.decode('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
            },
          },
        ],
      },
      ammv4: {
        account: [],
        owner: [MAINNET_PROGRAM_ID.AmmV4.toBase58()],
        filters: [
          {
            datasize: LIQUIDITY_STATE_LAYOUT_V4.span.toString(),
          },
          {
            memcmp: {
              offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('quoteMint').toString(),
              bytes: bs58.decode('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
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
              bytes: bs58.decode('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'),
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

  stream.write(request, (err: any) => {
    console.log('err', err);
  });
})();
