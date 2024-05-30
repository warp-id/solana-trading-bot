import Client, { CommitmentLevel, SubscribeRequest } from '@triton-one/yellowstone-grpc';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  ApiPoolInfoV4,
  LIQUIDITY_STATE_LAYOUT_V4,
  LiquidityStateV4,
  MAINNET_PROGRAM_ID,
  MARKET_STATE_LAYOUT_V3,
  Market,
  SPL_MINT_LAYOUT,
  Token,
} from '@raydium-io/raydium-sdk';
import bs58 from 'bs58';
import { Connection, PublicKey } from '@solana/web3.js';
import base58 from 'bs58';
import { COMMITMENT_LEVEL, RPC_ENDPOINT, RPC_WEBSOCKET_ENDPOINT } from './helpers';

(async function main() {
  const connection = new Connection(RPC_ENDPOINT, {
    // wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
    commitment: COMMITMENT_LEVEL,
  });

  const client = new Client('', '', {});

  const programId = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
  const createPoolFeeAccount = '7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5';

  const rpcConnInfo = await client.subscribe();

  rpcConnInfo.on('data', (data: any) => {
    console.log(data);
    callback(data, programId, connection);
  });

  await new Promise<void>((resolve, reject) => {
    if (rpcConnInfo === undefined) throw Error('rpc conn error');
    rpcConnInfo.write(
      {
        slots: {},
        accounts: {},
        transactions: {
          transactionsSubKey: {
            accountInclude: [createPoolFeeAccount],
            accountExclude: [],
            accountRequired: [],
          },
        },
        blocks: {},
        blocksMeta: {},
        accountsDataSlice: [],
        entry: {},
        commitment: 1,
      },
      (err: Error) => {
        if (err === null || err === undefined) {
          resolve();
        } else {
          reject(err);
        }
      },
    );
  }).catch((reason) => {
    console.error(reason);
    throw reason;
  });
})();

async function callback(data: any, programId: string, connection: Connection) {
  if (!data.filters.includes('transactionsSubKey')) return undefined;

  const info = data.transaction;
  if (info.transaction.meta.err !== undefined) return undefined;

  const formatData: {
    updateTime: number;
    slot: number;
    txid: string;
    poolInfos: LiquidityStateV4[];
  } = {
    updateTime: new Date().getTime(),
    slot: info.slot,
    txid: base58.encode(info.transaction.signature),
    poolInfos: [],
  };

  const accounts = info.transaction.transaction.message.accountKeys.map((i: Buffer) => base58.encode(i));

  for (const item of [
    ...info.transaction.transaction.message.instructions,
    ...info.transaction.meta.innerInstructions.map((i: any) => i.instructions).flat(),
  ]) {
    if (accounts[item.programIdIndex] !== programId) continue;

    if ([...(item.data as Buffer).values()][0] != 1) continue;

    const keyIndex = [...(item.accounts as Buffer).values()];
    console.log(accounts[keyIndex[4]]);

    let pairAccount = await connection.getAccountInfo(new PublicKey(accounts[keyIndex[4]]));
    if (pairAccount === null) throw Error('get account info error');

    let poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(pairAccount!.data);

    if (poolState.status.toNumber() !== 6) continue;

    formatData.poolInfos.push(poolState);
  }

  console.log(formatData);

  return formatData;
}
