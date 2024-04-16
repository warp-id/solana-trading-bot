import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { mnemonicToSeedSync } from 'bip39';
import { derivePath } from 'ed25519-hd-key';

export function getWallet(wallet: string): Keypair {
  // most likely someone pasted the private key in binary format
  if (wallet.startsWith('[')) {
    return Keypair.fromSecretKey(JSON.parse(wallet));
  }

  // most likely someone pasted mnemonic
  if (wallet.split(' ').length > 1) {
    const seed = mnemonicToSeedSync(wallet, '');
    const path = `m/44'/501'/0'/0'`; // we assume it's first path
    return Keypair.fromSeed(derivePath(path, seed.toString('hex')).key);
  }

  // most likely someone pasted base58 encoded private key
  return Keypair.fromSecretKey(bs58.decode(wallet));
}
