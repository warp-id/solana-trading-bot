import { LiquidityStateV4, Token } from '@raydium-io/raydium-sdk';
import { logger } from '../helpers';

export class PoolCache {
  private readonly keys: Map<string, { id: string; state: LiquidityStateV4 }> = new Map<
    string,
    { id: string; state: LiquidityStateV4 }
  >();

  public save(id: string, state: LiquidityStateV4) {
    // baseMint 不能是 wsol 和 usdc
    const baseMint = [Token.WSOL.mint.toBase58(), 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'].includes(
      state.quoteMint.toString(),
    )
      ? state.baseMint
      : state.quoteMint;

    if (!this.keys.has(baseMint.toString())) {
      logger.trace(`Caching new pool for mint: ${baseMint.toString()}`);

      this.keys.set(baseMint.toString(), { id, state });
    }
  }

  public async get(mint: string): Promise<{ id: string; state: LiquidityStateV4 }> {
    return this.keys.get(mint)!;
  }
}
