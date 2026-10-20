import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { Liquidity, LiquidityPoolKeysV4, Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import fs from 'fs';
import axios from 'axios';
import { Bot, BotConfig } from '../bot';
import { DefaultTransactionExecutor } from '../transactions/default-transaction-executor';
import { JitoTransactionExecutor } from '../transactions/jito-rpc-transaction-executor';
import { WarpTransactionExecutor } from '../transactions/warp-transaction-executor';
import { MarketCache, PoolCache } from '../cache';

vi.mock('../helpers', () => ({
  logger: { debug: vi.fn(), trace: vi.fn(), info: vi.fn(), error: vi.fn() },
  NETWORK: 'mainnet-beta', sleep: vi.fn(), createPoolKeys: vi.fn(),
  CHECK_IF_BURNED: false, CHECK_IF_FREEZABLE: false, CHECK_IF_MINT_IS_RENOUNCED: false,
  CHECK_IF_MUTABLE: false, CHECK_IF_SOCIALS: false,
}));

const wallet = Keypair.generate();
const tokenIn = new Token(TOKEN_PROGRAM_ID, Keypair.generate().publicKey, 6);
const tokenOut = new Token(TOKEN_PROGRAM_ID, Keypair.generate().publicKey, 6);
const amount = new TokenAmount(tokenIn, '1000000');
const hash = { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 10 };
let connection: Connection;

beforeEach(() => {
  connection = {
    commitment: 'confirmed',
    getLatestBlockhash: vi.fn().mockResolvedValue(hash),
    simulateTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
    getTokenAccountBalance: vi.fn().mockResolvedValue({ value: { amount: '2000000' } }),
  } as unknown as Connection;
  vi.spyOn(Liquidity, 'fetchInfo').mockResolvedValue({} as never);
  vi.spyOn(Liquidity, 'computeAmountOut').mockReturnValue({ amountOut: new TokenAmount(tokenOut, '2000000'), minAmountOut: new TokenAmount(tokenOut, '1900000') } as never);
  vi.spyOn(Liquidity, 'makeSwapFixedInInstruction').mockReturnValue({ innerTransaction: { instructions: [], signers: [] } } as never);
  vi.spyOn(axios, 'post').mockRejectedValue(new Error('Network disabled in tests'));
  vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
  vi.spyOn(fs, 'existsSync').mockReturnValue(false);
  vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);
  vi.spyOn(fs, 'renameSync').mockReturnValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

function setup(kind: 'default' | 'jito' | 'warp', simulate = true) {
  const executor = kind === 'default' ? new DefaultTransactionExecutor(connection) : kind === 'jito' ? new JitoTransactionExecutor('0.001', connection) : new WarpTransactionExecutor('0.001');
  const execute = vi.spyOn(executor, 'executeAndConfirm').mockResolvedValue({ confirmed: true, signature: 'confirmed-signature' });
  const config = { wallet, quoteToken: tokenIn, minPoolSize: new TokenAmount(tokenIn, '0'), maxPoolSize: new TokenAmount(tokenIn, '0'),
    unitLimit: 100000, unitPrice: 10, simulateTx: simulate } as BotConfig;
  const bot = new Bot(connection, {} as MarketCache, {} as PoolCache, executor, config);
  const swap = (direction: 'buy' | 'sell' = 'buy') => bot['swap']({ version: 4 } as LiquidityPoolKeysV4, Keypair.generate().publicKey,
    Keypair.generate().publicKey, tokenIn, tokenOut, amount, 5, wallet, direction, simulate);
  return { swap, execute };
}

it.each(['default', 'jito', 'warp'] as const)('simulates signed transactions without invoking the %s executor or recording trades', async kind => {
  const { swap, execute } = setup(kind);
  const result = await swap();
  expect(result).toEqual({ confirmed: true, simulated: true, signature: undefined, error: undefined });
  const transaction = vi.mocked(connection.simulateTransaction).mock.calls[0][0] as VersionedTransaction;
  expect(transaction).toBeInstanceOf(VersionedTransaction);
  expect(transaction.signatures[0].some(byte => byte !== 0)).toBe(true);
  expect(connection.simulateTransaction).toHaveBeenCalledWith(transaction, { sigVerify: true });
  expect(execute).not.toHaveBeenCalled();
  expect(axios.post).not.toHaveBeenCalled();
  expect(fs.writeFileSync).not.toHaveBeenCalled();
});

it.each(['default', 'jito', 'warp'] as const)('reports simulation errors without falling back to a live %s trade', async kind => {
  vi.mocked(connection.simulateTransaction).mockResolvedValue({ value: { err: { InstructionError: [0, 'InvalidArgument'] } } } as never);
  const { swap, execute } = setup(kind);
  expect(await swap('sell')).toMatchObject({ confirmed: false, simulated: true, error: '{"InstructionError":[0,"InvalidArgument"]}' });
  expect(execute).not.toHaveBeenCalled();
  expect(axios.post).not.toHaveBeenCalled();
});

it('propagates simulation transport failure without executing a real trade', async () => {
  vi.mocked(connection.simulateTransaction).mockRejectedValue(new Error('RPC unavailable'));
  const { swap, execute } = setup('default');
  await expect(swap()).rejects.toThrow('RPC unavailable');
  expect(execute).not.toHaveBeenCalled();
});

it('records a confirmed live buy with an atomic file replacement', async () => {
  const { swap, execute } = setup('default', false);
  expect(await swap()).toMatchObject({ confirmed: true, simulated: false, signature: 'confirmed-signature' });
  expect(execute).toHaveBeenCalledOnce();
  expect(connection.simulateTransaction).not.toHaveBeenCalled();
  const [file, data] = vi.mocked(fs.writeFileSync).mock.calls[0];
  expect(JSON.parse(data as string)[0]).toMatchObject({ buySignature: 'confirmed-signature', mintBalance: '2.000000', buyAmountIn: '1.000000' });
  expect(fs.renameSync).toHaveBeenCalledWith(file, `history/${wallet.publicKey.toBase58()}.json`);
});

it.each(['balance', 'corrupt_history', 'write'])('retains confirmation when %s fails, preventing a duplicate trade retry', async mode => {
  if (mode === 'balance') vi.mocked(connection.getTokenAccountBalance).mockRejectedValue(new Error('RPC unavailable'));
  if (mode === 'corrupt_history') {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue('not-json');
  }
  if (mode === 'write') vi.mocked(fs.writeFileSync).mockImplementation(() => { throw new Error('disk full'); });
  const { swap, execute } = setup('default', false);
  expect(await swap()).toMatchObject({ confirmed: true, signature: 'confirmed-signature' });
  expect(execute).toHaveBeenCalledOnce();
});
