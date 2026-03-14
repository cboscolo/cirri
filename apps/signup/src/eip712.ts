/**
 * EIP-712 typed data builders for Farcaster contracts.
 *
 * Two EIP-712 message types:
 * 1. IdGateway `registerFor` — allows a relayer to register an FID on behalf of the signer
 * 2. Fname `UserNameProof` — proves ownership for fname registration
 */

import type { Address } from "viem";

/** Fname verifier contract address on Ethereum mainnet */
const FNAME_VERIFIER = "0xe3be01d99baa8db9905b33a3ca391238234b79d1" as const;

/** EIP-712 types for IdGateway registerFor */
export const REGISTER_TYPES = {
	Register: [
		{ name: "to", type: "address" },
		{ name: "recovery", type: "address" },
		{ name: "nonce", type: "uint256" },
		{ name: "deadline", type: "uint256" },
	],
} as const;

/** EIP-712 domain for fname UserNameProof */
export const FNAME_DOMAIN = {
	name: "Farcaster name verification",
	version: "1",
	chainId: 1,
	verifyingContract: FNAME_VERIFIER as Address,
} as const;

/** EIP-712 types for fname UserNameProof */
export const FNAME_TYPES = {
	UserNameProof: [
		{ name: "name", type: "string" },
		{ name: "timestamp", type: "uint256" },
		{ name: "owner", type: "address" },
	],
} as const;

/** Build the EIP-712 domain for a specific IdGateway address and chain */
export function buildRegisterDomain(idGateway: Address, chainId: number) {
	return {
		name: "Farcaster IdGateway",
		version: "1",
		chainId,
		verifyingContract: idGateway,
	} as const;
}

/**
 * Build the EIP-712 typed data for IdGateway registerFor.
 * The agent signs this to authorize the relayer wallet to register an FID on their behalf.
 */
export function buildRegisterTypedData(params: {
	to: Address;
	recovery: Address;
	nonce: bigint;
	deadline: bigint;
	idGateway: Address;
	chainId: number;
}) {
	return {
		domain: buildRegisterDomain(params.idGateway, params.chainId),
		types: REGISTER_TYPES,
		primaryType: "Register" as const,
		message: {
			to: params.to,
			recovery: params.recovery,
			nonce: params.nonce.toString(),
			deadline: params.deadline.toString(),
		},
	};
}

/**
 * Build the EIP-712 typed data for fname UserNameProof.
 * The agent signs this to prove they own the address for fname registration.
 */
export function buildFnameTypedData(params: {
	name: string;
	timestamp: bigint;
	owner: Address;
}) {
	return {
		domain: FNAME_DOMAIN,
		types: FNAME_TYPES,
		primaryType: "UserNameProof" as const,
		message: {
			name: params.name,
			timestamp: params.timestamp,
			owner: params.owner,
		},
	};
}
