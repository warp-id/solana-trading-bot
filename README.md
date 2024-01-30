# Solana Sniper Bot
This code is written as proof of concept for demonstrating how we can buy new tokens immediately after liquidity pool is created.

Script listens to new raydium USDC/SOL pools and buys token for a fixed amount in USDC/SOL.
Depending on speed of RPC node, the purchase usually happens before token is available on Raydium UI for swapping.

# Setup
In order to run the script you need to:
- Create a new empty Solana wallet
- Transfer some SOL to it.
- Convert some SOL to USDC or WSOL.
  - You need USDC or WSOL depending on configuration set below.
- Set your 
  - PRIVATE_KEY (your wallet private key)
  - RPC_ENDPOINT (https RPC endpoint)
  - RPC_WEBSOCKET_ENDPOINT (websocket RPC endpoint)
  - QUOTE_MINT (which pools to snipe, USDC or WSOL)
  - QUOTE_AMOUNT (amount used to buy each new token)
  - COMMITMENT_LEVEL

  in the .env file (remove the .copy from the file name when done). 
  Make sure to replace default values.

- Install dependencies by typing: `npm install`
- Run the script by typing: `npm run buy` in terminal

You should see following output:
![output](output.png)

# Support

## Unsupported RPC node
- If you see following error in your log file:
`Error: 410 Gone:  {"jsonrpc":"2.0","error":{"code": 410, "message":"The RPC call or parameters have been disabled."}, "id": "986f3599-b2b7-47c4-b951-074c19842bad" }`
it means your RPC node doesn't support methods needed to execute script.
  - FIX: Change your RPC node. You can use Helius or Quicknode.


- If you see following error in your log file:
`Error: No SOL token account found in wallet: `
it means that wallet you provided doesn't have USDC/WSOL token account.
  - FIX: Go to dex and swap some SOL to USDC/WSOL. For example when you swap sol to wsol you should see it in wallet as shown below:

![wsol](wsol.png)