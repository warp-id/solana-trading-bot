// Import the required classes from the Solana web3.js library
import {
    Keypair
} from '@solana/web3.js';
import * as bs58 from 'bs58';

// Generate a new keypair
const keypair = Keypair.generate();

// Get the private key from the keypair
const privateKey = keypair.secretKey;

// Convert the private key to a hexadecimal string for display
const privateKeyBase58 = bs58.encode(privateKey);

console.log("Private Key:", privateKey);
console.log("Private Key Hex:", privateKeyBase58);

// Getting the public key
const publicKey = keypair.publicKey.toBase58(); // Base58 is commonly used in Solana

console.log("Public Key:", publicKey);
