# Solana Sniper Bot (Poc)

This code is written as proof of concept to demonstrate how we can buy new tokens immediately after the liquidity pool is open for trading.

The script listens to new Raydium USDC or SOL pools and buys tokens for a fixed amount in USDC/SOL. Depending on the speed of the RPC node, the purchase usually happens before the token is available on Raydium UI for swapping.

This is provided as is, for learning purposes.

## Setup
To run the script you need to:
- Create a new empty Solana wallet.
- Transfer some SOL to it.
- Convert some SOL to USDC or WSOL, depending on the configuration set below.
- Configure the script by updating the `.env.copy` file (remove the `.copy` from the file name when done). Update the file with your specific settings:
  - `PRIVATE_KEY`: Your wallet's private key.
  - `RPC_ENDPOINT`: HTTPS RPC endpoint for interacting with the Solana network.
  - `RPC_WEBSOCKET_ENDPOINT`: WebSocket RPC endpoint for real-time updates from the Solana network.
  - `QUOTE_MINT`: Specify the quote currency for pools to snipe (USDC or WSOL).
  - `QUOTE_AMOUNT`: Amount of quote currency used to buy each new token.
  - `COMMITMENT_LEVEL`: The commitment level of transactions (e.g., "finalized" for the highest level of security).
  - `USE_SNIPE_LIST`: Set to `true` to enable buying only tokens listed in `snipe-list.txt`.
  - `SNIPE_LIST_REFRESH_INTERVAL`: Interval in milliseconds to refresh the snipe list.
  - `CHECK_IF_MINT_IS_RENOUNCED`: Set to `true` to buy tokens only if their mint is renounced.
  - `MIN_POOL_SIZE`: The script will buy only if the pool size is greater than the specified amount (set to 0 to disable this check).
  - `MAX_POOL_SIZE`: Maximum pool size to target for buying tokens.
  - `ONE_TOKEN_AT_A_TIME`: Set to `true` to process buying one token at a time.
  - `RUG_CHECK`: Set to `true` to enable rug pull checks before buying.
  - `RUG_CHECK_WAIT_TIMEOUT_SECONDS`: Time in seconds to wait for rug pull check results.
  - `CHECK_PRICE_INTERVAL_SECONDS`: Interval in seconds for checking the token price when managing auto-sell conditions.
  - `BIRDEYE_API_KEY`: API key for accessing price check services.
  - `TAKE_PROFIT`: Percentage profit at which to take profit.
  - `STOP_LOSS`: Percentage loss at which to stop the loss.
  - `AUTO_SELL`: Set to `true` to enable automatic selling of tokens.
  - `MAX_SELL_RETRIES`: Maximum number of retries for selling a token.
  - `AUTO_SELL_DELAY`: Delay in milliseconds before auto-selling a token.
  - `MAX_BUY_RETRIES`: Maximum number of buy retries for each token.
  - `LOG_LEVEL`: Set logging level, e.g., "info", "debug", etc.
- Install dependencies by typing `npm install`.
- Run the script by typing `npm run buy` in the terminal.

You should see the following output:  
![output](readme/output.png)

## Snipe list
By default, script buys each token which has a new liquidity pool created and open for trading.
There are scenarios when you want to buy one specific token as soon as possible during the launch event.
To achieve this, you'll have to use snipe list.
- Change variable `USE_SNIPE_LIST` to `true`
- Add token mint addresses you wish to buy in `snipe-list.txt` file
  - Add each address as a new line

This will prevent script from buying everything, and instead it will buy just listed tokens.
You can update the list while script is running. Script will check for new values in specified interval (`SNIPE_LIST_REFRESH_INTERVAL`).

Pool must not exist before the script starts.
It will buy only when new pool is open for trading. If you want to buy token that will be launched in the future, make sure that script is running before the launch.

### Auto Sell
By default, auto sell is enabled. This feature sells the token immediately after it is bought if set to 0 delay. Configure it with:
- `AUTO_SELL_DELAY`: Number of milliseconds to wait before selling the token.
- `MAX_SELL_RETRIES`: Maximum number of attempts to sell the token.
- `TAKE_PROFIT` and `STOP_LOSS`: Percentage levels for taking profit and stopping losses.

### Advanced Trading Strategies
- `RUG_CHECK`: Enables rug pull check before buying. Set to `true` to activate.
- `RUG_CHECK_WAIT_TIMEOUT_SECONDS`: Time to wait for rug pull results.
- `CHECK_PRICE_INTERVAL_SECONDS`: Interval for checking the token price for auto sell conditions.

There is no guarantee that the token will be sold at a profit or even sold at all. The developer is not responsible for any losses incurred by using this feature.

## Common issues
If you have an error which is not listed here, please create a new issue in this repository.
To collect more information on an issue, please change `LOG_LEVEL` to `debug`.

### Empty transaction
- If you see empty transactions on SolScan most likely fix is to change commitment level to `finalized`.

### Unsupported RPC node
- If you see following error in your log file:  
  `Error: 410 Gone:  {"jsonrpc":"2.0","error":{"code": 410, "message":"The RPC call or parameters have been disabled."}, "id": "986f3599-b2b7-47c4-b951-074c19842bad" }`  
  it means your RPC node doesn't support methods needed to execute script.
  - FIX: Change your RPC node. You can use Helius or Quicknode.

### No token account
- If you see following error in your log file:  
  `Error: No SOL token account found in wallet: `  
  it means that wallet you provided doesn't have USDC/WSOL token account.
  - FIX: Go to dex and swap some SOL to USDC/WSOL. For example when you swap sol to wsol you should see it in wallet as shown below:

![wsol](readme/wsol.png)

## Contact
[![](https://img.shields.io/discord/1201826085655023616?color=5865F2&logo=Discord&style=flat-square)](https://discord.gg/xYUETCA2aP)

## Disclaimer

Use this script at your own risk.
