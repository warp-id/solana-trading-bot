import { Connection, PublicKey, AccountInfo } from '@solana/web3.js';
import { LiquidityPoolKeysV4 } from '@raydium-io/raydium-sdk';
import { Filter, FilterResult } from './pool-filters';
import { TOKEN_PROGRAM_ID, MintLayout } from '@solana/spl-token';
import { logger, HOLDER_MIN_AMOUNT, TOP_HOLDER_MAX_PERCENTAGE, ABNORMAL_HOLDER_NR, TOP_10_MAX_PERCENTAGE, CHECK_ABNORMAL_DISTRIBUTION, TOP_10_PERCENTAGE_CHECK } from '../helpers';

export class HoldersCountFilter implements Filter {
    constructor(private readonly connection: Connection) { }

    async execute(poolKeys: LiquidityPoolKeysV4): Promise<FilterResult> {
        const baseThisCase = poolKeys.baseMint.toBase58();
        const accounts = await this.connection.getProgramAccounts(
            TOKEN_PROGRAM_ID,
            {
                dataSlice: { offset: 0, length: 0 },  // No need to fetch data if not inspecting it
                filters: [
                    { dataSize: 165 },  // Size of a SPL Token account
                    {
                        memcmp: {
                            offset: 0,  // Mint address is at the start of the SPL Token account data
                            bytes: poolKeys.baseMint.toBase58(),
                        },
                    },
                ],
            }
        );
        const holderCount = accounts.length;
        logger.trace(`Holders count : ${holderCount}`);
        const isSuspicious = holderCount < HOLDER_MIN_AMOUNT; // Example condition

        return {
            ok: !isSuspicious,
            message: isSuspicious ? `Too few holders ${holderCount} ` : `Sufficient number of holders. ${holderCount}`,
        };
    }
}



interface HolderInfo {
    address: PublicKey;
    uiAmount: number;
    owner: PublicKey;
    lamports: number;
}

export class TopHolderDistributionFilter implements Filter {
    constructor(private readonly connection: Connection) { }

    async execute(poolKeys: LiquidityPoolKeysV4): Promise<FilterResult> {
        try {

            // Fetch the total supply of the token from its mint account
            const mintAccountInfo = await this.connection.getAccountInfo(poolKeys.baseMint);
            let totalSupply = 0;
            let supplyDecimals = 0;
            if (mintAccountInfo && mintAccountInfo.data.length === MintLayout.span) {
                const mintData = MintLayout.decode(mintAccountInfo.data);
                supplyDecimals = mintData.decimals;
                totalSupply = Number(mintData.supply);  // Adjust based on your needs (handle big numbers appropriately)
            }
            const largestAccountsResponse = await this.connection.getTokenLargestAccounts(poolKeys.baseMint);
            const addresses = largestAccountsResponse.value.map(account => new PublicKey(account.address));

            // Fetch additional account details for each of the largest accounts
            const accountInfos = await this.connection.getMultipleAccountsInfo(addresses, { commitment: 'confirmed' });

            const largestAccounts = accountInfos.map((info, index) => ({
                address: addresses[index],
                uiAmount: largestAccountsResponse.value[index].uiAmount ?? 0,
                owner: info ? new PublicKey(info.data.slice(32, 64)) : new PublicKey('11111111111111111111111111111111'), // Use a default or null-like public key
                lamports: info ? info.lamports : 0
            }));

            const distributionResult = await this.checkTokenDistribution(largestAccounts);
            let message = `Total Supply: ${totalSupply}, \nTop holder percentages: ${distributionResult.percentages.join(' | ')}`;

            if (distributionResult.isTopHolderExcessive) {
                message += `.\nWarning: Top holder exceeds threshold, has: ${distributionResult.percentages[0]}.`;
            }

            if (TOP_10_PERCENTAGE_CHECK && distributionResult.isTopTenPercentageExcessive) {
                message += `\nWarning: Top ten holders collectively exceed threshold of ${TOP_10_MAX_PERCENTAGE}% with ${distributionResult.topTenPercentage.toFixed(2)}%.`;
            }

            logger.trace(`Top holders total SOL: ${distributionResult.topHoldersTotalSol}`);
            if (distributionResult.isTopHoldersPoor) {
                message += `.\nWarning: Top holders are poor, total net worth: ${distributionResult.topHoldersTotalSol.toFixed(3)}.`;
            }

            const distributionOk = !distributionResult.isTopHolderExcessive && !distributionResult.isTopHoldersPoor && (!TOP_10_PERCENTAGE_CHECK || !distributionResult.isTopTenPercentageExcessive);

            if (CHECK_ABNORMAL_DISTRIBUTION) {
                const abnormalDistribution = this.checkForAbnormalDistribution(largestAccounts);
                message += abnormalDistribution ? "\nAbnormal distribution detected!" : "\nDistribution looks normal.";
                return {
                    ok: distributionOk && !abnormalDistribution,
                    message: message
                };
            } else {
                return {
                    ok: distributionOk,
                    message: message + ". Abnormal distribution check is disabled."
                };
            }
        } catch (error) {
            logger.error(`Failed to execute TopHolderDistributionFilter: ${error}`);
            return { ok: false, message: 'Failed to check token distribution.' };
        }
    }

    private async checkTokenDistribution(accounts: HolderInfo[]): Promise<{ percentages: string[], totalSupply: number, topTenPercentage: number, isTopTenPercentageExcessive: boolean, isTopHolderExcessive: boolean, isTopHoldersPoor: boolean, topHoldersTotalSol: number }> {
        const totalSupply = accounts.reduce((sum, account) => sum + account.uiAmount, 0);
        const excludeAddress = new PublicKey("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1");
        const filteredAccounts = accounts.filter(account => !account.owner.equals(excludeAddress));

        const percentages = filteredAccounts.slice(0, 10).map(account => ((account.uiAmount / totalSupply) * 100).toFixed(2) + '%');
        const percentagesRaw = filteredAccounts.slice(0, 10).map(account => (account.uiAmount / totalSupply) * 100);
        const isTopHolderExcessive = parseFloat(percentages[0]) > TOP_HOLDER_MAX_PERCENTAGE;
        const topTenPercentage = percentagesRaw.reduce((sum, current) => sum + current, 0);
        const isTopTenPercentageExcessive = topTenPercentage > TOP_10_MAX_PERCENTAGE;
       
        const ownerAddresses = filteredAccounts.map(x=>x.owner);
        const ownerAccounts = await this.connection.getMultipleAccountsInfo(ownerAddresses, { commitment: 'confirmed' });

        const lessThanThresholdAccounts = ownerAccounts.filter(account => account && account.lamports < 1000000000).length;
        const isTopHoldersPoor = lessThanThresholdAccounts > (ownerAccounts.length / 2);
        const topHoldersTotalSol = ownerAccounts.filter(x=>x).reduce((sum, account) => sum + (account.lamports / 1000000000), 0);

        return { percentages, totalSupply, topTenPercentage, isTopTenPercentageExcessive, isTopHolderExcessive, isTopHoldersPoor, topHoldersTotalSol };
    }

    private checkForAbnormalDistribution(accounts: HolderInfo[]): boolean {
        const amountsMap = new Map<number, number>();
        accounts.forEach(account => {
            amountsMap.set(account.uiAmount, (amountsMap.get(account.uiAmount) || 0) + 1);
        });

        return Array.from(amountsMap.values()).some(count => count >= ABNORMAL_HOLDER_NR);
    }
}