import { Connection } from '@solana/web3.js';
import { LiquidityStateV4, Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { BurnFilter } from './burn.filter';
import { RenouncedFilter } from './renounced.filter';
import { PoolSizeFilter } from './pool-size.filter';
import { CHECK_IF_BURNED, CHECK_IF_MINT_IS_RENOUNCED, logger } from '../helpers';

export interface Filter {
  execute(poolState: LiquidityStateV4): Promise<FilterResult>;
}

export interface FilterResult {
  ok: boolean;
  message?: string;
}

export interface PoolFilterArgs {
  minPoolSize: TokenAmount;
  maxPoolSize: TokenAmount;
  quoteToken: Token;
}

export class PoolFilters {
  private readonly filters: Filter[] = [];

  constructor(
    readonly connection: Connection,
    readonly args: PoolFilterArgs,
  ) {
    if (CHECK_IF_BURNED) {
      this.filters.push(new BurnFilter(connection));
    }

    if (CHECK_IF_MINT_IS_RENOUNCED) {
      this.filters.push(new RenouncedFilter(connection));
    }

    if (!args.minPoolSize.isZero() || !args.maxPoolSize.isZero()) {
      this.filters.push(new PoolSizeFilter(connection, args.quoteToken, args.minPoolSize, args.maxPoolSize));
    }
  }

  public async execute(poolState: LiquidityStateV4): Promise<boolean> {
    if (this.filters.length === 0) {
      return true;
    }

    const result = await Promise.all(this.filters.map((f) => f.execute(poolState)));
    const pass = result.every((r) => r.ok);

    if (pass) {
      return true;
    }

    for (const filterResult of result.filter((r) => !r.ok)) {
      logger.info(filterResult.message);
    }

    return false;
  }
}
