# Solana Sniper Bot
Proof of concept - 2023-04-20

This code is written as proof of concept for demonstrating how we can buy new tokens immediately after liquidity pool is created.

Script listens to new raydium USDC pools and buys token for a fixed amount in USDC.
Depending on speed of RPC node, the purchase usually happens before token is available on Raydium for swapping.

# Setup
In order to run the script you need to:
- Create a new empty Solana wallet
- Transfer some SOL to it.
- Convert some SOL to USDC.
  - We need USDC because the script is buying USDC pairs.
- Export wallet private key and paste it into: `wallet.json`
- Modify the buy.ts file and enter your RPC endpoint
  - Find line where it says: `ENTER RPC ENDPOINT HERE` and `ENTER RPC WEBSOCKET ENDPOINT HERE`
    and replace it with your endpoint
- Install dependencies buy typing: `npm install`
- Run the script by typing: `npm run buy` in terminal
