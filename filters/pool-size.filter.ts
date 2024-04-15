import { Filter, FilterResult } from './pool-filters';
import { LiquidityStateV4, Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { Connection } from '@solana/web3.js';

export class PoolSizeFilter implements Filter {
  constructor(
    private readonly connection: Connection,
    private readonly quoteToken: Token,
    private readonly minPoolSize: TokenAmount,
    private readonly maxPoolSize: TokenAmount,
  ) {}

  async execute(poolState: LiquidityStateV4): Promise<FilterResult> {
    const response = await this.connection.getTokenAccountBalance(poolState.quoteVault, this.connection.commitment);
    const poolSize = new TokenAmount(this.quoteToken, response.value.amount, true);
    let inRange = true;

    if (!this.maxPoolSize?.isZero()) {
      inRange = poolSize.lt(this.maxPoolSize);

      if (!inRange) {
        return { ok: false, message: `PoolSize -> Pool size ${poolSize.toFixed()} > ${this.maxPoolSize.toFixed()}` };
      }
    }

    if (!this.minPoolSize?.isZero()) {
      inRange = poolSize.gt(this.minPoolSize);

      if (!inRange) {
        return { ok: false, message: `PoolSize -> Pool size ${poolSize.toFixed()} < ${this.minPoolSize.toFixed()}` };
      }
    }

    return { ok: inRange };
  }
}
