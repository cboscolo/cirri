/**
 * Farcaster contract interactions via viem.
 *
 * Handles on-chain FID registration via IdGateway registerFor(),
 * and reading IdRegistry state.
 *
 * Contract addresses and chain ID are configurable via env vars
 * to support both Optimism mainnet and OP Sepolia testnet.
 */

import {
	createPublicClient,
	http,
	type Address,
	type Chain,
	type PublicClient,
} from "viem";
import { optimism, optimismSepolia } from "viem/chains";

/** Default Farcaster contract addresses (Optimism mainnet) */
const DEFAULT_ID_REGISTRY = "0x00000000Fc6c5F01Fc30151999387Bb99A9f489b" as const;
const DEFAULT_ID_GATEWAY = "0x00000000fc25870c6ed6b6c7e41fb078b7656f69" as const;

/** Minimal ABI for IdRegistry reads */
const idRegistryAbi = [
	{
		name: "idOf",
		type: "function",
		stateMutability: "view",
		inputs: [{ name: "owner", type: "address" }],
		outputs: [{ name: "", type: "uint256" }],
	},
] as const;

/** Minimal ABI for IdGateway registerFor and price */
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

/** Contract configuration resolved from env vars */
export interface ContractConfig {
	idRegistry: Address;
	idGateway: Address;
	chainId: number;
}

/** Resolve contract addresses and chain ID from env vars, falling back to Optimism mainnet defaults */
export function resolveContractConfig(env: {
	ID_REGISTRY_ADDRESS?: string;
	ID_GATEWAY_ADDRESS?: string;
	CHAIN_ID?: string;
}): ContractConfig {
	return {
		idRegistry: (env.ID_REGISTRY_ADDRESS || DEFAULT_ID_REGISTRY) as Address,
		idGateway: (env.ID_GATEWAY_ADDRESS || DEFAULT_ID_GATEWAY) as Address,
		chainId: env.CHAIN_ID ? parseInt(env.CHAIN_ID, 10) : 10,
	};
}

const CHAINS: Record<number, Chain> = {
	10: optimism,
	11155420: optimismSepolia,
};

/** Create a public client for the configured chain */
export function createChainClient(rpcUrl: string, chainId: number = 10): PublicClient {
	const chain = CHAINS[chainId] || optimism;
	return createPublicClient({
		chain,
		transport: http(rpcUrl),
	}) as PublicClient;
}

/**
 * Get the FID for an address from the IdRegistry.
 * Returns "0" if the address has no FID.
 */
export async function getFidForAddress(
	client: PublicClient,
	address: Address,
	config: ContractConfig,
): Promise<string> {
	const fid = await client.readContract({
		address: config.idRegistry,
		abi: idRegistryAbi,
		functionName: "idOf",
		args: [address],
	});
	return (fid as bigint).toString();
}

/**
 * Get the IdGateway nonce for an address (used in registerFor EIP-712).
 */
export async function getIdGatewayNonce(
	client: PublicClient,
	address: Address,
	config: ContractConfig,
): Promise<bigint> {
	return client.readContract({
		address: config.idGateway,
		abi: idGatewayAbi,
		functionName: "nonces",
		args: [address],
	}) as Promise<bigint>;
}

/**
 * Get the current FID registration price from IdGateway.
 */
export async function getRegistrationPrice(
	client: PublicClient,
	config: ContractConfig,
): Promise<bigint> {
	return client.readContract({
		address: config.idGateway,
		abi: idGatewayAbi,
		functionName: "price",
	}) as Promise<bigint>;
}

/**
 * Register an FID via registerFor using a Privy server wallet.
 *
 * The Privy wallet pays the gas + registration fee, and the `to` address
 * (the agent) becomes the custody address for the new FID.
 *
 * @returns The new FID as a string
 */
export async function registerForFid(params: {
	client: PublicClient;
	config: ContractConfig;
	privyWalletAddress: Address;
	to: Address;
	recovery: Address;
	deadline: bigint;
	signature: `0x${string}`;
	privyAppId: string;
	privyAppSecret: string;
	privyWalletId: string;
	rpcUrl: string;
}): Promise<{ fid: string; txHash: string }> {
	const price = await getRegistrationPrice(params.client, params.config);

	// Use Privy server wallet to submit the transaction
	// Build the transaction data for IdGateway.registerFor
	const { encodeFunctionData } = await import("viem");
	const data = encodeFunctionData({
		abi: idGatewayAbi,
		functionName: "registerFor",
		args: [params.to, params.recovery, params.deadline, params.signature],
	});

	// Submit transaction via Privy server wallet API
	const txHash = await submitPrivyTransaction({
		appId: params.privyAppId,
		appSecret: params.privyAppSecret,
		walletId: params.privyWalletId,
		chainId: params.config.chainId,
		to: params.config.idGateway,
		data,
		value: `0x${price.toString(16)}`,
	});

	// Wait for receipt
	const receipt = await params.client.waitForTransactionReceipt({ hash: txHash as `0x${string}` });

	// Extract FID from Register event
	// Event: Register(address indexed to, uint256 indexed id, address recovery)
	const logs = receipt.logs.filter(
		(log) =>
			log.address.toLowerCase() === params.config.idRegistry.toLowerCase() &&
			log.topics.length >= 3,
	);

	if (logs.length === 0) {
		throw new Error("No Register event found in transaction receipt");
	}

	const fid = BigInt(logs[0]!.topics[2]!).toString();
	return { fid, txHash };
}

/**
 * Submit a transaction via Privy server wallet REST API.
 * Returns the transaction hash.
 */
async function submitPrivyTransaction(params: {
	appId: string;
	appSecret: string;
	walletId: string;
	chainId: number;
	to: string;
	data: string;
	value: string;
}): Promise<string> {
	const resp = await fetch(
		`https://auth.privy.io/api/v1/wallets/${params.walletId}/rpc`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"privy-app-id": params.appId,
				Authorization: `Basic ${btoa(`${params.appId}:${params.appSecret}`)}`,
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
