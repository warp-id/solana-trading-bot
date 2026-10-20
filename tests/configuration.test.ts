import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));
vi.mock('../helpers/logger', () => ({ logger: { error: vi.fn() } }));

beforeEach(() => {
  vi.resetModules();
  for (const key of [
    'PRIVATE_KEY', 'COMMITMENT_LEVEL', 'RPC_ENDPOINT', 'RPC_WEBSOCKET_ENDPOINT', 'LOG_LEVEL',
    'ONE_TOKEN_AT_A_TIME', 'COMPUTE_UNIT_LIMIT', 'COMPUTE_UNIT_PRICE', 'PRE_LOAD_EXISTING_MARKETS',
    'CACHE_NEW_MARKETS', 'TRANSACTION_EXECUTOR', 'CUSTOM_FEE', 'AUTO_BUY_DELAY', 'QUOTE_MINT', 'QUOTE_AMOUNT',
    'MAX_BUY_RETRIES', 'BUY_SLIPPAGE', 'AUTO_SELL', 'AUTO_SELL_DELAY', 'MAX_SELL_RETRIES', 'TAKE_PROFIT',
    'STOP_LOSS', 'PRICE_CHECK_INTERVAL', 'PRICE_CHECK_DURATION', 'SELL_SLIPPAGE', 'FILTER_CHECK_INTERVAL',
    'FILTER_CHECK_DURATION', 'CONSECUTIVE_FILTER_MATCHES', 'CHECK_IF_MUTABLE', 'CHECK_IF_SOCIALS',
    'CHECK_IF_MINT_IS_RENOUNCED', 'CHECK_IF_FREEZABLE', 'CHECK_IF_BURNED', 'MIN_POOL_SIZE', 'MAX_POOL_SIZE',
    'USE_SNIPE_LIST', 'SNIPE_LIST_REFRESH_INTERVAL',
  ]) vi.stubEnv(key, '1');
});
afterEach(() => vi.unstubAllEnvs());

it.each(['true', 'false'])('accepts explicit simulation setting %s', async value => {
  vi.stubEnv('SIMULATE_TX', value);
  expect((await import('../helpers/constants')).SIMULATE_TX).toBe(value === 'true');
});

it('rejects a misspelled simulation setting before a live executor can start', async () => {
  vi.stubEnv('SIMULATE_TX', 'TRUE');
  await expect(import('../helpers/constants')).rejects.toThrow('SIMULATE_TX must be true or false');
});
