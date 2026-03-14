/**
 * Test script for getRegistrationPrice() and registerFid() from farcaster-contracts.ts.
 *
 * Prerequisites:
 *   1. Install Foundry: https://book.getfoundry.sh/getting-started/installation
 *   2. Start Anvil fork:  anvil --fork-url https://mainnet.optimism.io --port 8545
 *
 * Usage:
 *   npx tsx scripts/test-fid-registration.ts
 */

import { createPublicClient, createWalletClient, http } from "viem";
import { optimism } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import {
	getRegistrationPrice,
	registerFid,
	getFidForAddress,
	getCustodyAddress,
} from "../packages/pds/src/farcaster-contracts";

const ANVIL_RPC = process.env.ANVIL_RPC || "http://localhost:8545";

// Generate a random wallet so we don't collide with addresses that already
// have a FID on mainnet (Anvil forks include existing onchain state).
const account = privateKeyToAccount(
	`0x${[...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`,
);

console.log("=== FID Registration Test ===\n");
console.log(`Anvil:   ${ANVIL_RPC}`);
console.log(`Wallet:  ${account.address}\n`);

// Fund the random wallet via Anvil's cheat code
await fetch(ANVIL_RPC, {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({
		jsonrpc: "2.0",
		method: "anvil_setBalance",
		params: [account.address, "0x56BC75E2D63100000"], // 100 ETH
		id: 1,
	}),
});

// --- Test 1: getRegistrationPrice ---
console.log("--- Test 1: getRegistrationPrice() ---");
const price = await getRegistrationPrice(ANVIL_RPC);
console.log(`Price: ${price} wei (${Number(price) / 1e18} ETH)`);

if (price <= 0n) {
	console.error("FAIL: price should be > 0");
	process.exit(1);
}
console.log("PASS\n");

// --- Test 2: registerFid ---
console.log("--- Test 2: registerFid() ---");

const walletClient = createWalletClient({
	account,
	chain: optimism,
	transport: http(ANVIL_RPC),
});

const publicClient = createPublicClient({
	chain: optimism,
	transport: http(ANVIL_RPC),
});

const recoveryAddress = "0x000000000000000000000000000000000000dEaD";

const { fid, txHash } = await registerFid(
	walletClient,
	publicClient,
	recoveryAddress,
);

console.log(`FID:     ${fid}`);
console.log(`Tx hash: ${txHash}`);

if (!fid || fid === "0") {
	console.error("FAIL: fid should be a non-zero string");
	process.exit(1);
}
console.log("PASS\n");

// --- Test 3: Verify with existing read functions ---
console.log("--- Test 3: Verify registration ---");

const custody = await getCustodyAddress(fid, ANVIL_RPC);
console.log(`Custody: ${custody}`);
console.log(`Wallet:  ${account.address}`);
const custodyMatch =
	custody.toLowerCase() === account.address.toLowerCase();
console.log(`Match:   ${custodyMatch}`);

if (!custodyMatch) {
	console.error("FAIL: custody address should match wallet");
	process.exit(1);
}

const lookedUpFid = await getFidForAddress(account.address, ANVIL_RPC);
console.log(`idOf():  ${lookedUpFid}`);

if (lookedUpFid !== fid) {
	console.error("FAIL: idOf() should return the registered FID");
	process.exit(1);
}
console.log("PASS\n");

console.log("=== All tests passed ===");
