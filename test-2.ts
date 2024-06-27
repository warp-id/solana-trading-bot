import Client, { CommitmentLevel, SubscribeRequest } from '@triton-one/yellowstone-grpc';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  LIQUIDITY_STATE_LAYOUT_V4,
  MAINNET_PROGRAM_ID,
  MARKET_STATE_LAYOUT_V3,
  Token,
  publicKey,
} from '@raydium-io/raydium-sdk';
import bs58 from 'bs58';
import { Connection, PublicKey } from '@solana/web3.js';
import { COMMITMENT_LEVEL, RPC_ENDPOINT, RPC_WEBSOCKET_ENDPOINT } from './helpers';

(async function main() {
  const connection = new Connection(RPC_ENDPOINT, {
    wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
    commitment: COMMITMENT_LEVEL,
  });

  let pair = new PublicKey(bs58.decode('24EY192uRz52WAD3XtnrrmKfhSmucojKRd9TeRhfCL9c'));
  let pairAccount = await connection.getAccountInfo(pair);
  
  let poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(pairAccount!.data);
  const poolOpenTime = parseInt(poolState.poolOpenTime.toString());

  console.log(poolOpenTime,poolState);
  



})();
