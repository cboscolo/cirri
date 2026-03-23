/**
 * Farcaster CLI test tool for end-to-end testing against a real Hub.
 *
 * Quick start (Privy-funded, no ETH needed):
 *
 *   # Set Privy credentials (same as apps/signup/.dev.vars)
 *   export PRIVY_APP_ID=...
 *   export PRIVY_APP_SECRET=...
 *   export PRIVY_SERVER_WALLET_ID=...
 *   export PRIVY_SERVER_WALLET_ADDRESS=...
 *
 *   1. Register a fresh FID (Privy server wallet pays gas + registration fee):
 *        bun scripts/fc-test.ts register-fid
 *
 *   2. Generate a signer keypair:
 *        bun scripts/fc-test.ts keygen
 *
 *   3. Register the signer on-chain (uses custody key from step 1):
 *        bun scripts/fc-test.ts register-signer
 *      Wait 1-10 minutes for the Hub to pick up the on-chain event.
 *
 *   4. Check that the Hub sees your signer:
 *        bun scripts/fc-test.ts status
 *
 *   5. Send a cast:
 *        bun scripts/fc-test.ts cast "Hello from fid.is!"
 *
 *   6. Update profile fields:
 *        bun scripts/fc-test.ts profile --display "Test Name" --bio "Testing bio"
 *
 *   7. Verify on Hub + Warpcast/Supercast:
 *        bun scripts/fc-test.ts status
 *
 * Alternative (bring your own FID):
 *   If you already have an FID with a custody key, skip step 1 and pass
 *   --fid and --custody-key to register-signer directly.
 *
 * State is saved to scripts/.fc-test-state.json (gitignored — contains private keys).
 * To use a different Hub, edit the hubApiUrl field in the state file.
 *
 * All commands:
 *   register-fid [--sepolia]                   Register a fresh FID via Privy server wallet
 *   keygen                                    Generate ed25519 signer keypair
 *   register-signer [--sepolia] [--fid N --custody-key 0x]  Register signer on-chain
 *   cast "text" [--parent-fid N --parent-hash H]  Send a cast
 *   profile --display "Name" --bio "Bio" [--pfp URL] [--url URL] [--username NAME]
 *   status                                    Query Hub for signers, profile, casts
 *
 * Use --sepolia for on-chain commands to test on OP Sepolia (free testnet ETH).
 * Note: Sepolia FIDs are not indexed by mainnet Hubs, so cast/profile/status won't work.
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { hexToBytes, bytesToHex, generateEd25519Keypair } from "../apps/sync/src/crypto";
import {
	buildCastMessage,
	buildUserDataMessage,
} from "../apps/sync/src/farcaster-message";
import { submitMessage } from "../apps/sync/src/hub-client";
import {
	USER_DATA_TYPE_DISPLAY,
	USER_DATA_TYPE_BIO,
	USER_DATA_TYPE_PFP,
	USER_DATA_TYPE_URL,
	USER_DATA_TYPE_USERNAME,
	type UserDataType,
} from "../apps/sync/src/types";

// --- Network config ---

const USE_SEPOLIA = process.argv.includes("--sepolia");

interface NetworkConfig {
	name: string;
	chainId: number;
	idRegistry: string;
	idGateway: string;
	keyGateway: string;
	signedKeyRequestValidator: string;
	rpcUrl: string;
}

const MAINNET: NetworkConfig = {
	name: "OP Mainnet",
	chainId: 10,
	idRegistry: "0x00000000Fc6c5F01Fc30151999387Bb99A9f489b",
	idGateway: "0x00000000fc25870c6ed6b6c7e41fb078b7656f69",
	keyGateway: "0x00000000fc56947c7e7183f8ca4b62398caadf0b",
	signedKeyRequestValidator: "0x00000000FC700472606ED4fA22623Acf62c60553",
	rpcUrl: "https://mainnet.optimism.io",
};

const SEPOLIA: NetworkConfig = {
	name: "OP Sepolia",
	chainId: 11155420,
	idRegistry: "0x0acc54228887f9717633aD107FC683B4d66C6164",
	idGateway: "0x967e224796487113c9F268E3c73874eDBE8b73C5",
	keyGateway: "0x5d760D4AEDd8d65462b7974a1b0Df4cA07725464",
	signedKeyRequestValidator: "0x974e9c52C307879ee67ceBb2F40Ba21AFd291529",
	rpcUrl: "https://sepolia.optimism.io",
};

const NET = USE_SEPOLIA ? SEPOLIA : MAINNET;

// --- State file ---

const STATE_PATH = join(import.meta.dirname!, ".fc-test-state.json");

interface State {
	fid?: number;
	signerPrivateKey?: string;
	signerPublicKey?: string;
	custodyPrivateKey?: string;
	custodyAddress?: string;
	hubApiUrl?: string;
	network?: "mainnet" | "sepolia";
}

function loadState(): State {
	try {
		return JSON.parse(readFileSync(STATE_PATH, "utf-8"));
	} catch {
		return {};
	}
}

function saveState(state: State): void {
	writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

function getHubUrl(state: State): string {
	return state.hubApiUrl || "https://haatz.quilibrium.com/v1";
}

// --- Arg parsing helpers ---

function getArg(flag: string): string | undefined {
	const idx = process.argv.indexOf(flag);
	return idx !== -1 ? process.argv[idx + 1] : undefined;
}

function getPositional(offset: number): string | undefined {
	// args after the command name
	const cmdIdx = 2; // process.argv[0]=bun, [1]=script, [2]=command
	return process.argv[cmdIdx + offset];
}

// --- Commands ---

async function keygen() {
	const { privateKey, publicKey } = generateEd25519Keypair();

	const state = loadState();
	state.signerPrivateKey = privateKey;
	state.signerPublicKey = publicKey;
	saveState(state);

	const publicKeyHex = publicKey;

	console.log("Generated ed25519 signer keypair");
	console.log(`  Public key:  ${publicKeyHex}`);
	console.log(`  Saved to:    ${STATE_PATH}`);
}

// --- Privy server wallet ---

function requireEnv(name: string): string {
	const val = process.env[name];
	if (!val) {
		console.error(`Missing env var: ${name}`);
		console.error("Set Privy credentials via env vars or source apps/signup/.dev.vars");
		process.exit(1);
	}
	return val;
}

async function submitPrivyTransaction(params: {
	chainId: number;
	to: string;
	data: string;
	value: string;
}): Promise<string> {
	const appId = requireEnv("PRIVY_APP_ID");
	const appSecret = requireEnv("PRIVY_APP_SECRET");
	const walletId = requireEnv("PRIVY_SERVER_WALLET_ID");

	const resp = await fetch(
		`https://auth.privy.io/api/v1/wallets/${walletId}/rpc`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"privy-app-id": appId,
				Authorization: `Basic ${btoa(`${appId}:${appSecret}`)}`,
			},
			body: JSON.stringify({
				method: "eth_sendTransaction",
				caip2: `eip155:${params.chainId}`,
				params: {
					transaction: {
						to: params.to,
						data: params.data,
						value: params.value,
					},
				},
			}),
		},
	);

	if (!resp.ok) {
		const text = await resp.text();
		throw new Error(`Privy transaction failed (${resp.status}): ${text}`);
	}

	const result = (await resp.json()) as { data?: { hash?: string } };
	if (!result.data?.hash) {
		throw new Error("No transaction hash in Privy response");
	}

	return result.data.hash;
}

// --- Commands ---

const idGatewayAbi = [
	{
		name: "registerFor",
		type: "function",
		stateMutability: "payable",
		inputs: [
			{ name: "to", type: "address" },
			{ name: "recovery", type: "address" },
			{ name: "deadline", type: "uint256" },
			{ name: "sig", type: "bytes" },
		],
		outputs: [
			{ name: "fid", type: "uint256" },
			{ name: "overpayment", type: "uint256" },
		],
	},
	{
		name: "price",
		type: "function",
		stateMutability: "view",
		inputs: [],
		outputs: [{ name: "", type: "uint256" }],
	},
	{
		name: "nonces",
		type: "function",
		stateMutability: "view",
		inputs: [{ name: "owner", type: "address" }],
		outputs: [{ name: "", type: "uint256" }],
	},
] as const;

async function registerFid() {
	const {
		createPublicClient,
		http,
		encodeFunctionData,
	} = await import("viem");
	const { optimismSepolia, optimism } = await import("viem/chains");
	const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");

	console.log(`Network: ${NET.name}`);

	// Generate a fresh custody wallet (or reuse from state)
	const state = loadState();
	let custodyKey: `0x${string}`;

	if (state.custodyPrivateKey) {
		custodyKey = state.custodyPrivateKey as `0x${string}`;
		console.log("Reusing custody key from state file");
	} else {
		custodyKey = generatePrivateKey();
		console.log("Generated fresh custody wallet");
	}

	const account = privateKeyToAccount(custodyKey);
	console.log(`  Custody address: ${account.address}`);

	const recoveryAddress = process.env.RECOVERY_ADDRESS || account.address;
	const chain = USE_SEPOLIA ? optimismSepolia : optimism;

	const publicClient = createPublicClient({
		chain,
		transport: http(NET.rpcUrl),
	});

	// Fetch nonce + price in parallel
	const [nonce, priceWei] = await Promise.all([
		publicClient.readContract({
			address: NET.idGateway as `0x${string}`,
			abi: idGatewayAbi,
			functionName: "nonces",
			args: [account.address],
		}) as Promise<bigint>,
		publicClient.readContract({
			address: NET.idGateway as `0x${string}`,
			abi: idGatewayAbi,
			functionName: "price",
		}) as Promise<bigint>,
	]);

	console.log(`  Registration price: ${Number(priceWei) / 1e18} ETH`);

	// Sign EIP-712 Register message
	const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour

	console.log("Signing EIP-712 Register message...");
	const signature = await account.signTypedData({
		domain: {
			name: "Farcaster IdGateway",
			version: "1",
			chainId: NET.chainId,
			verifyingContract: NET.idGateway as `0x${string}`,
		},
		types: {
			Register: [
				{ name: "to", type: "address" },
				{ name: "recovery", type: "address" },
				{ name: "nonce", type: "uint256" },
				{ name: "deadline", type: "uint256" },
			],
		},
		primaryType: "Register",
		message: {
			to: account.address,
			recovery: recoveryAddress as `0x${string}`,
			nonce,
			deadline,
		},
	});

	// Encode registerFor call data
	const callData = encodeFunctionData({
		abi: idGatewayAbi,
		functionName: "registerFor",
		args: [account.address, recoveryAddress as `0x${string}`, deadline, signature],
	});

	// Submit via Privy server wallet
	console.log("Submitting registerFor via Privy server wallet...");
	const txHash = await submitPrivyTransaction({
		chainId: NET.chainId,
		to: NET.idGateway,
		data: callData,
		value: `0x${priceWei.toString(16)}`,
	});

	console.log(`  Transaction: ${txHash}`);
	console.log("Waiting for confirmation...");

	const receipt = await publicClient.waitForTransactionReceipt({
		hash: txHash as `0x${string}`,
	});
	console.log(`  Confirmed in block ${receipt.blockNumber} (status: ${receipt.status})`);

	// Extract FID from Register event in IdRegistry
	const registerLogs = receipt.logs.filter(
		(log) =>
			log.address.toLowerCase() === NET.idRegistry.toLowerCase() &&
			log.topics.length >= 3,
	);

	if (registerLogs.length === 0) {
		throw new Error("No Register event found in transaction receipt");
	}

	const fid = Number(BigInt(registerLogs[0]!.topics[2]!));

	// Save state
	state.fid = fid;
	state.custodyPrivateKey = custodyKey;
	state.custodyAddress = account.address;
	state.network = USE_SEPOLIA ? "sepolia" : "mainnet";
	saveState(state);

	console.log(`\nFID registered: ${fid}`);
	console.log(`Custody address: ${account.address}`);
	console.log(`Saved to: ${STATE_PATH}`);
	if (USE_SEPOLIA) {
		console.log("\nNote: Sepolia FIDs are not indexed by mainnet Hubs.");
		console.log("cast/profile/status commands won't work with this FID.");
	}
	console.log("\nNext: run 'keygen' then 'register-signer' to add a signer key.");
}

async function registerSigner() {
	const state = loadState();

	const fidStr = getArg("--fid") || (state.fid ? String(state.fid) : undefined);
	const custodyKey = getArg("--custody-key") || state.custodyPrivateKey;

	if (!fidStr || !custodyKey) {
		console.error("Usage: bun scripts/fc-test.ts register-signer --fid <FID> --custody-key <0x...>");
		console.error("  (or run 'register-fid' first to populate state automatically)");
		process.exit(1);
	}

	const fid = parseInt(fidStr, 10);

	if (!state.signerPublicKey || !state.signerPrivateKey) {
		console.error("No signer keypair found. Run 'keygen' first.");
		process.exit(1);
	}

	const {
		createPublicClient,
		http,
		encodeAbiParameters,
		encodeFunctionData,
	} = await import("viem");
	const { optimism, optimismSepolia } = await import("viem/chains");
	const { privateKeyToAccount } = await import("viem/accounts");

	console.log(`Network: ${NET.name}`);

	const account = privateKeyToAccount(custodyKey as `0x${string}`);
	console.log(`Custody address: ${account.address}`);
	console.log(`FID: ${fid}`);
	console.log(`Signer public key: ${state.signerPublicKey}`);

	const chain = USE_SEPOLIA ? optimismSepolia : optimism;

	const publicClient = createPublicClient({
		chain,
		transport: http(NET.rpcUrl),
	});

	// Verify FID ownership before doing anything else
	const idRegistryAbi = [
		{
			name: "idOf",
			type: "function",
			stateMutability: "view",
			inputs: [{ name: "owner", type: "address" }],
			outputs: [{ name: "", type: "uint256" }],
		},
	] as const;

	const onChainFid = await publicClient.readContract({
		address: NET.idRegistry as `0x${string}`,
		abi: idRegistryAbi,
		functionName: "idOf",
		args: [account.address],
	}) as bigint;

	if (Number(onChainFid) === 0) {
		console.error(`  ERROR: ${account.address} does not own any FID on ${NET.name}`);
		process.exit(1);
	}
	if (Number(onChainFid) !== fid) {
		console.error(`  ERROR: ${account.address} owns FID ${onChainFid}, not ${fid}`);
		process.exit(1);
	}
	console.log(`  FID ownership verified on-chain`);

	const deadline = BigInt(Math.floor(Date.now() / 1000) + 86400); // 24h from now
	const signerPubKeyHex = `0x${state.signerPublicKey}` as `0x${string}`;

	// 1. Sign the SignedKeyRequest metadata (FID owner vouches for their own key as "app")
	console.log("Signing SignedKeyRequest metadata...");
	const metadataSignature = await account.signTypedData({
		domain: {
			name: "Farcaster SignedKeyRequestValidator",
			version: "1",
			chainId: NET.chainId,
			verifyingContract: NET.signedKeyRequestValidator as `0x${string}`,
		},
		types: {
			SignedKeyRequest: [
				{ name: "requestFid", type: "uint256" },
				{ name: "key", type: "bytes" },
				{ name: "deadline", type: "uint256" },
			],
		},
		primaryType: "SignedKeyRequest",
		message: {
			requestFid: BigInt(fid),
			key: signerPubKeyHex,
			deadline,
		},
	});

	// 2. ABI-encode the SignedKeyRequestMetadata (tuple form, matching signup service)
	const metadata = encodeAbiParameters(
		[{
			type: "tuple",
			components: [
				{ name: "requestFid", type: "uint256" },
				{ name: "requestSigner", type: "address" },
				{ name: "signature", type: "bytes" },
				{ name: "deadline", type: "uint256" },
			],
		}],
		[{
			requestFid: BigInt(fid),
			requestSigner: account.address,
			signature: metadataSignature,
			deadline,
		}],
	);

	// 3. Fetch KeyGateway nonce for the custody address
	const keyGatewayAbi = [
		{
			name: "addFor",
			type: "function",
			stateMutability: "nonpayable",
			inputs: [
				{ name: "fidOwner", type: "address" },
				{ name: "keyType", type: "uint32" },
				{ name: "key", type: "bytes" },
				{ name: "metadataType", type: "uint8" },
				{ name: "metadata", type: "bytes" },
				{ name: "deadline", type: "uint256" },
				{ name: "sig", type: "bytes" },
			],
			outputs: [],
		},
		{
			name: "nonces",
			type: "function",
			stateMutability: "view",
			inputs: [{ name: "owner", type: "address" }],
			outputs: [{ name: "", type: "uint256" }],
		},
	] as const;

	const nonce = await publicClient.readContract({
		address: NET.keyGateway as `0x${string}`,
		abi: keyGatewayAbi,
		functionName: "nonces",
		args: [account.address],
	}) as bigint;
	console.log(`  KeyGateway nonce: ${nonce}`);

	// 4. Sign the EIP-712 Add message (authorizes Privy to call addFor on behalf of custody)
	console.log("Signing EIP-712 Add message...");
	const addSignature = await account.signTypedData({
		domain: {
			name: "Farcaster KeyGateway",
			version: "1",
			chainId: NET.chainId,
			verifyingContract: NET.keyGateway as `0x${string}`,
		},
		types: {
			Add: [
				{ name: "owner", type: "address" },
				{ name: "keyType", type: "uint32" },
				{ name: "key", type: "bytes" },
				{ name: "metadataType", type: "uint8" },
				{ name: "metadata", type: "bytes" },
				{ name: "nonce", type: "uint256" },
				{ name: "deadline", type: "uint256" },
			],
		},
		primaryType: "Add",
		message: {
			owner: account.address,
			keyType: 1,
			key: signerPubKeyHex,
			metadataType: 1,
			metadata,
			nonce,
			deadline,
		},
	});

	// 5. Simulate addFor locally to catch revert reasons before sending to Privy
	const addForArgs = [account.address, 1, signerPubKeyHex, 1, metadata, deadline, addSignature] as const;

	console.log("Simulating addFor call...");
	try {
		await publicClient.simulateContract({
			address: NET.keyGateway as `0x${string}`,
			abi: keyGatewayAbi,
			functionName: "addFor",
			args: addForArgs,
			account: requireEnv("PRIVY_SERVER_WALLET_ADDRESS") as `0x${string}`,
		});
		console.log("  Simulation OK");
	} catch (simErr) {
		console.error("  Simulation failed:", (simErr as Error).message);
		process.exit(1);
	}

	// 6. Submit addFor via Privy server wallet
	const callData = encodeFunctionData({
		abi: keyGatewayAbi,
		functionName: "addFor",
		args: addForArgs,
	});

	console.log("Submitting KeyGateway.addFor() via Privy server wallet...");
	const txHash = await submitPrivyTransaction({
		chainId: NET.chainId,
		to: NET.keyGateway,
		data: callData,
		value: "0x0",
	});

	console.log(`  Transaction: ${txHash}`);
	console.log("Waiting for confirmation...");

	const receipt = await publicClient.waitForTransactionReceipt({
		hash: txHash as `0x${string}`,
	});
	console.log(`  Confirmed in block ${receipt.blockNumber} (status: ${receipt.status})`);

	// Save state
	state.fid = fid;
	state.custodyAddress = account.address;
	saveState(state);

	console.log("\nSigner registered! Hub may take 1-10 minutes to pick up the on-chain event.");
	console.log("Run 'status' to check when it's ready.");
}

async function registerFname() {
	const fname = getPositional(1);
	if (!fname) {
		console.error("Usage: bun scripts/fc-test.ts register-fname <username>");
		process.exit(1);
	}

	const state = loadState();
	if (!state.fid || !state.custodyPrivateKey) {
		console.error("Missing fid or custody key. Run 'register-fid' first.");
		process.exit(1);
	}

	const { privateKeyToAccount } = await import("viem/accounts");
	const account = privateKeyToAccount(state.custodyPrivateKey as `0x${string}`);

	const timestamp = Math.floor(Date.now() / 1000);

	// Sign EIP-712 UserNameProof
	console.log(`Registering fname "${fname}" for FID ${state.fid}...`);
	const signature = await account.signTypedData({
		domain: {
			name: "Farcaster name verification",
			version: "1",
			chainId: 1,
			verifyingContract: "0xe3be01d99baa8db9905b33a3ca391238234b79d1" as `0x${string}`,
		},
		types: {
			UserNameProof: [
				{ name: "name", type: "string" },
				{ name: "timestamp", type: "uint256" },
				{ name: "owner", type: "address" },
			],
		},
		primaryType: "UserNameProof",
		message: {
			name: fname,
			timestamp: BigInt(timestamp),
			owner: account.address,
		},
	});

	// POST to fname server
	const resp = await fetch("https://fnames.farcaster.xyz/transfers", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			name: fname,
			from: 0,
			to: state.fid,
			fid: state.fid,
			owner: account.address,
			timestamp,
			signature,
		}),
	});

	if (!resp.ok) {
		const text = await resp.text();
		console.error(`Failed (${resp.status}): ${text}`);
		process.exit(1);
	}

	const result = (await resp.json()) as { transfer: { username: string } };
	console.log(`Fname registered: ${result.transfer.username}`);
	console.log("\nNext: set USERNAME on the Hub with:");
	console.log(`  bun scripts/fc-test.ts profile --username ${fname}`);
}

async function cast() {
	const text = getPositional(1);
	if (!text) {
		console.error("Usage: bun scripts/fc-test.ts cast \"Hello!\" [--parent-fid N --parent-hash H]");
		process.exit(1);
	}

	const state = loadState();
	if (!state.fid || !state.signerPrivateKey) {
		console.error("Missing fid or signer key. Run 'keygen' and 'register-signer' first.");
		process.exit(1);
	}

	const parentFidStr = getArg("--parent-fid");
	const parentHash = getArg("--parent-hash");
	const parentFid = parentFidStr ? parseInt(parentFidStr, 10) : undefined;

	const { messageBytes, hash } = buildCastMessage(
		state.fid,
		text,
		state.signerPrivateKey,
		{ parentFid, parentHash },
	);

	const hubUrl = getHubUrl(state);
	console.log(`Hub: ${hubUrl}`);
	console.log(`FID: ${state.fid}`);
	console.log(`Submitting cast: "${text}"`);
	if (parentFid && parentHash) {
		console.log(`  Reply to fid=${parentFid} hash=${parentHash}`);
	}
	console.log(`  Message bytes: ${messageBytes.length}`);

	const result = await submitMessage(hubUrl, messageBytes, hash);

	if (result.ok) {
		console.log(`Cast submitted! Hash: ${result.hash}`);
	} else {
		console.error(`Failed: ${result.errCode} — ${result.message}`);
		process.exit(1);
	}
}

async function profile() {
	const state = loadState();
	if (!state.fid || !state.signerPrivateKey) {
		console.error("Missing fid or signer key. Run 'keygen' and 'register-signer' first.");
		process.exit(1);
	}

	const updates: Array<{ type: UserDataType; value: string; label: string }> = [];

	const display = getArg("--display");
	if (display !== undefined) {
		updates.push({ type: USER_DATA_TYPE_DISPLAY, value: display, label: "displayName" });
	}

	const bio = getArg("--bio");
	if (bio !== undefined) {
		updates.push({ type: USER_DATA_TYPE_BIO, value: bio, label: "bio" });
	}

	const pfp = getArg("--pfp");
	if (pfp !== undefined) {
		updates.push({ type: USER_DATA_TYPE_PFP, value: pfp, label: "pfp" });
	}

	const url = getArg("--url");
	if (url !== undefined) {
		updates.push({ type: USER_DATA_TYPE_URL, value: url, label: "url" });
	}

	const username = getArg("--username");
	if (username !== undefined) {
		updates.push({ type: USER_DATA_TYPE_USERNAME, value: username, label: "username" });
	}

	if (updates.length === 0) {
		console.error("Usage: bun scripts/fc-test.ts profile --display \"Name\" --bio \"Bio\" [--pfp URL] [--url URL] [--username NAME]");
		process.exit(1);
	}

	const hubUrl = getHubUrl(state);

	for (const update of updates) {
		const { messageBytes, hash } = buildUserDataMessage(
			state.fid,
			update.type,
			update.value,
			state.signerPrivateKey,
		);

		console.log(`Setting ${update.label}: "${update.value}"`);
		const result = await submitMessage(hubUrl, messageBytes, hash);

		if (result.ok) {
			console.log(`  OK — hash: ${result.hash}`);
		} else {
			console.error(`  Failed: ${result.errCode} — ${result.message}`);
		}
	}
}

async function status() {
	const state = loadState();
	if (!state.fid) {
		console.error("No FID in state. Run 'register-signer' first.");
		process.exit(1);
	}

	const hubUrl = getHubUrl(state);
	console.log(`Hub: ${hubUrl}`);
	console.log(`FID: ${state.fid}`);
	console.log();

	// Signers
	try {
		const signersResp = await fetch(`${hubUrl}/onChainSignersByFid?fid=${state.fid}`);
		if (signersResp.ok) {
			const signers = (await signersResp.json()) as { events?: Array<Record<string, unknown>> };
			const events = signers.events || [];
			console.log(`Signers: ${events.length} registered`);
			for (const event of events) {
				const body = event.signerEventBody as Record<string, unknown> | undefined;
				if (body) {
					console.log(`  key: ${(body.key as string[] | undefined)?.join("") || "?"}`);
				}
			}
		} else {
			console.log(`Signers: error ${signersResp.status}`);
		}
	} catch (e) {
		console.log(`Signers: fetch error — ${(e as Error).message}`);
	}

	console.log();

	// User data
	try {
		const dataResp = await fetch(`${hubUrl}/userDataByFid?fid=${state.fid}`);
		if (dataResp.ok) {
			const data = (await dataResp.json()) as { messages?: Array<Record<string, unknown>> };
			const messages = data.messages || [];
			console.log(`Profile data: ${messages.length} fields`);
			for (const msg of messages) {
				const msgData = msg.data as Record<string, unknown> | undefined;
				const body = msgData?.userDataBody as Record<string, unknown> | undefined;
				if (body) {
					console.log(`  type=${body.type}: "${body.value}"`);
				}
			}
		} else {
			console.log(`Profile data: error ${dataResp.status}`);
		}
	} catch (e) {
		console.log(`Profile data: fetch error — ${(e as Error).message}`);
	}

	console.log();

	// Recent casts
	try {
		const castsResp = await fetch(`${hubUrl}/castsByFid?fid=${state.fid}&pageSize=5&reverse=true`);
		if (castsResp.ok) {
			const casts = (await castsResp.json()) as { messages?: Array<Record<string, unknown>> };
			const messages = casts.messages || [];
			console.log(`Recent casts: ${messages.length}`);
			for (const msg of messages) {
				const msgData = msg.data as Record<string, unknown> | undefined;
				const body = msgData?.castAddBody as Record<string, unknown> | undefined;
				if (body) {
					const text = (body.text as string) || "";
					const preview = text.length > 80 ? text.slice(0, 80) + "..." : text;
					console.log(`  "${preview}"`);
				}
			}
		} else {
			console.log(`Recent casts: error ${castsResp.status}`);
		}
	} catch (e) {
		console.log(`Recent casts: fetch error — ${(e as Error).message}`);
	}
}

// --- Main ---

const command = process.argv[2];

switch (command) {
	case "register-fid":
		await registerFid();
		break;
	case "keygen":
		await keygen();
		break;
	case "register-signer":
		await registerSigner();
		break;
	case "register-fname":
		await registerFname();
		break;
	case "cast":
		await cast();
		break;
	case "profile":
		await profile();
		break;
	case "status":
		await status();
		break;
	default:
		console.log(`Farcaster CLI Test Tool

Usage: bun scripts/fc-test.ts <command>

Commands:
  register-fid                                Register fresh FID (Privy pays gas)
  keygen                                      Generate ed25519 signer keypair
  register-signer [--fid N --custody-key 0x]  Register signer on-chain
  register-fname <username>                   Register an fname (off-chain)
  cast "text" [--parent-fid N --parent-hash H]  Send a cast
  profile --display "Name" --bio "Bio"        Update profile fields
  status                                      Query Hub for signers, profile, casts

Options:
  --sepolia    Use OP Sepolia testnet (default: OP Mainnet)

Env vars for register-fid (Privy server wallet):
  PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_SERVER_WALLET_ID, PRIVY_SERVER_WALLET_ADDRESS

State is stored in scripts/.fc-test-state.json`);
		if (command) {
			console.error(`\nUnknown command: ${command}`);
			process.exit(1);
		}
}
