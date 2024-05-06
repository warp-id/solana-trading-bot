import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

export function getWallet(wallet: string): Keypair {
  // most likely someone pasted the private key in binary format
  if (wallet.startsWith('[')) {
    return Keypair.fromSecretKey(JSON.parse(wallet));
  }

  // most likely someone pasted base58 encoded private key
  return Keypair.fromSecretKey(bs58.decode(wallet));
}
