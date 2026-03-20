/**
 * Signup Service — Headless API for Farcaster FID + AT Protocol account creation
 *
 * Endpoints:
 * - GET  /api/registration-params?address=0x... — EIP-712 typed data + pricing for agent to sign
 * - POST /api/create — x402-gated FID creation + fname registration + PDS account creation
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Address } from "viem";
import { x402PaymentMiddleware } from "./x402";
import {
	createChainClient,
	resolveContractConfig,
	getFidForAddress,
	getIdGatewayNonce,
	getKeyGatewayNonce,
	getRegistrationPrice,
	registerForFid,
	addSignerForFid,
} from "./farcaster-contracts";
import {
	buildRegisterTypedData,
	buildAddTypedData,
	buildSignedKeyRequestDomain,
	SIGNED_KEY_REQUEST_TYPES,
	FNAME_DOMAIN,
	FNAME_TYPES,
} from "./eip712";
import { registerFname } from "./fname";

export type Env = {
	Bindings: {
		/** Optimism RPC URL */
		OPTIMISM_RPC_URL: string;
		/** PDS base URL (e.g., https://fid.is) */
		PDS_URL: string;
		/** Matches PDS ACCOUNT_CREATION_KEY */
		PDS_API_KEY: string;
		/** x402 price in USD */
		X402_PRICE: string;
		/** x402 facilitator URL */
		X402_FACILITATOR_URL: string;
		/** Wallet address to receive x402 payments */
		X402_PAY_TO: string;
		/** x402 network (default: base) */
		X402_NETWORK?: string;
		/** x402 USDC asset address */
		X402_ASSET?: string;
		/** Privy app ID */
		PRIVY_APP_ID: string;
		/** Privy app secret */
		PRIVY_APP_SECRET: string;
		/** Privy server wallet ID */
		PRIVY_SERVER_WALLET_ID: string;
		/** Privy server wallet address (pays gas for FID registration) */
		PRIVY_SERVER_WALLET_ADDRESS: string;
		/** Recovery address for new FIDs (Privy-controlled) */
		RECOVERY_ADDRESS: string;
		/** Override IdRegistry address (default: OP mainnet) */
		ID_REGISTRY_ADDRESS?: string;
		/** Override IdGateway address (default: OP mainnet) */
		ID_GATEWAY_ADDRESS?: string;
		/** Override KeyGateway address (default: OP mainnet) */
		KEY_GATEWAY_ADDRESS?: string;
		/** Override SignedKeyRequestValidator address (default: OP mainnet) */
		SIGNED_KEY_REQUEST_VALIDATOR_ADDRESS?: string;
		/** Override chain ID for contract interactions (default: 10 = Optimism) */
		CHAIN_ID?: string;
		/** FID of the requesting app (fid.is miniapp) for SignedKeyRequest metadata */
		REQUEST_FID?: string;
		/** Private key of the REQUEST_FID owner for signing SignedKeyRequest metadata */
		REQUEST_FID_PRIVATE_KEY?: string;
		/** Sync service URL (e.g., https://sync.fid.is) */
		SYNC_SERVICE_URL: string;
		/** Sync service internal API key */
		SYNC_API_KEY: string;
	};
};

const app = new Hono<Env>();

app.onError((err, c) => {
	console.error("Unhandled error:", err);
	return c.json({ error: "ServerError", message: err.message }, 500);
});

app.use("*", cors({ origin: "*" }));

/**
 * Call the sync service to generate a signer keypair.
 * The private key is stored encrypted in the sync service — only the public key is returned.
 */
async function generateSignerViaSyncService(
	syncUrl: string,
	syncApiKey: string,
	address: string,
): Promise<{ signerPublicKey: string }> {
	const resp = await fetch(`${syncUrl}/generate-signer`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${syncApiKey}`,
		},
		body: JSON.stringify({ address }),
	});

	if (!resp.ok) {
		const err = await resp.text();
		throw new Error(`Sync service generate-signer failed (${resp.status}): ${err}`);
	}

	return resp.json() as Promise<{ signerPublicKey: string }>;
}

/**
 * Call the sync service to set up sync for a user.
 * Moves the pending signer key to the FID-keyed DO.
 */
async function setupSyncService(
	syncUrl: string,
	syncApiKey: string,
	params: { fid: number; did: string; pdsUrl: string; address: string; signerPublicKey: string },
): Promise<void> {
	const resp = await fetch(`${syncUrl}/setup`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${syncApiKey}`,
		},
		body: JSON.stringify(params),
	});

	if (!resp.ok) {
		const err = await resp.text();
		throw new Error(`Sync service setup failed (${resp.status}): ${err}`);
	}
}

/**
 * GET /api/registration-params?address=0x...
 *
 * Returns the EIP-712 typed data that the agent needs to sign,
 * plus pricing information and a deadline.
 */
app.get("/api/registration-params", async (c) => {
	const address = c.req.query("address");
	if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
		return c.json({ error: "InvalidRequest", message: "Missing or invalid address parameter" }, 400);
	}

	const contracts = resolveContractConfig(c.env);
	const client = createChainClient(c.env.OPTIMISM_RPC_URL, contracts.chainId);
	const addr = address as Address;

	// Fetch nonces, price, existing FID, and generate signer key in parallel
	const [registerNonce, keyGatewayNonce, priceWei, existingFid, signerResult] = await Promise.all([
		getIdGatewayNonce(client, addr, contracts),
		getKeyGatewayNonce(client, addr, contracts),
		getRegistrationPrice(client, contracts),
		getFidForAddress(client, addr, contracts),
		// Generate signer keypair in the sync service (private key stays there)
		c.env.REQUEST_FID && c.env.REQUEST_FID_PRIVATE_KEY
			? generateSignerViaSyncService(c.env.SYNC_SERVICE_URL, c.env.SYNC_API_KEY, address)
			: Promise.resolve(null),
	]);

	// Deadline: 1 hour from now
	const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
	const recovery = c.env.RECOVERY_ADDRESS as Address;

	const registerTypedData = buildRegisterTypedData({
		to: addr,
		recovery,
		nonce: registerNonce,
		deadline,
		idGateway: contracts.idGateway,
		chainId: contracts.chainId,
	});

	// Build Add typed data if signer was generated
	let addTypedData = null;
	let signerKeyInfo = null;

	if (signerResult && c.env.REQUEST_FID && c.env.REQUEST_FID_PRIVATE_KEY) {
		const { privateKeyToAccount } = await import("viem/accounts");
		const { encodeAbiParameters } = await import("viem");

		const signerPubKeyHex = `0x${signerResult.signerPublicKey}` as `0x${string}`;
		const requestFid = BigInt(c.env.REQUEST_FID);
		const requestAccount = privateKeyToAccount(c.env.REQUEST_FID_PRIVATE_KEY as `0x${string}`);

		// Sign the SignedKeyRequest EIP-712 message
		const signedKeyRequestDomain = buildSignedKeyRequestDomain(
			contracts.signedKeyRequestValidator,
			contracts.chainId,
		);

		const signedKeyRequestSig = await requestAccount.signTypedData({
			domain: signedKeyRequestDomain,
			types: SIGNED_KEY_REQUEST_TYPES,
			primaryType: "SignedKeyRequest",
			message: {
				requestFid,
				key: signerPubKeyHex,
				deadline,
			},
		});

		// ABI-encode the SignedKeyRequestMetadata struct
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
				requestFid,
				requestSigner: requestAccount.address,
				signature: signedKeyRequestSig,
				deadline,
			}],
		);

		addTypedData = buildAddTypedData({
			owner: addr,
			keyType: 1, // ed25519
			key: signerPubKeyHex,
			metadataType: 1, // SignedKeyRequest
			metadata,
			nonce: keyGatewayNonce,
			deadline,
			keyGateway: contracts.keyGateway,
			chainId: contracts.chainId,
		});

		signerKeyInfo = {
			signerPubKey: signerPubKeyHex,
			metadata,
		};
	}

	// For fname, we build a template — the agent fills in `name` and `timestamp`
	// before signing. We provide the domain and types so they know the format.
	const fnameTypedData = {
		domain: FNAME_DOMAIN,
		types: FNAME_TYPES,
		primaryType: "UserNameProof" as const,
	};

	// Price in ETH for display
	const priceEth = Number(priceWei) / 1e18;

	return c.json({
		price: {
			fidWei: priceWei.toString(),
			fidEth: priceEth,
		},
		existingFid: existingFid !== "0" ? existingFid : null,
		nonce: registerNonce.toString(),
		deadline: deadline.toString(),
		recoveryAddress: recovery,
		registerTypedData,
		fnameTypedData,
		// Signer key registration (null if REQUEST_FID not configured)
		addTypedData,
		signerKeyInfo,
	});
});

/**
 * POST /api/create
 *
 * x402-gated endpoint that:
 * 1. Verifies payment, extracts payer address
 * 2. Registers FID on-chain (if payer doesn't already have one)
 * 3. Registers signer key on-chain (if addSig provided)
 * 4. Registers fname (if provided)
 * 5. Creates PDS account via internal API key
 * 6. Sets up sync service (moves signer key to FID-keyed storage)
 * 7. Returns the complete account info
 */
app.post("/api/create", x402PaymentMiddleware(), async (c) => {
	const payerAddress = (c as any).get("x402Payer") as string;
	if (!payerAddress) {
		return c.json({ error: "ServerError", message: "No payer address from x402" }, 500);
	}

	const body = await c.req.json<{
		fname?: string;
		registerSig?: string;
		fnameSig?: string;
		fnameTimestamp?: number;
		deadline?: string;
		// Signer key registration fields
		addSig?: string;
		signerPubKey?: string;
		signerMetadata?: string;
	}>().catch(() => null);

	const contracts = resolveContractConfig(c.env);
	const client = createChainClient(c.env.OPTIMISM_RPC_URL, contracts.chainId);

	// Step 1: Check if payer already has an FID
	let fid = await getFidForAddress(client, payerAddress as Address, contracts);

	if (fid === "0") {
		// Step 2: Register new FID on-chain
		if (!body?.registerSig || !body?.deadline) {
			return c.json(
				{ error: "InvalidRequest", message: "registerSig and deadline required for new FID registration" },
				400,
			);
		}

		let result;
		try {
			result = await registerForFid({
				client,
				config: contracts,
				privyWalletAddress: c.env.PRIVY_SERVER_WALLET_ADDRESS as Address,
				to: payerAddress as Address,
				recovery: c.env.RECOVERY_ADDRESS as Address,
				deadline: BigInt(body.deadline),
				signature: body.registerSig as `0x${string}`,
				privyAppId: c.env.PRIVY_APP_ID,
				privyAppSecret: c.env.PRIVY_APP_SECRET,
				privyWalletId: c.env.PRIVY_SERVER_WALLET_ID,
				rpcUrl: c.env.OPTIMISM_RPC_URL,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : "Unknown error";
			const isInsufficientFunds = message.includes("insufficient funds");
			return c.json(
				{
					error: isInsufficientFunds ? "FidRegistrationUnderfunded" : "FidRegistrationFailed",
					message: isInsufficientFunds
						? "Server wallet has insufficient funds for FID registration. Please contact the operator."
						: `FID registration failed: ${message}`,
				},
				isInsufficientFunds ? 503 : 502,
			);
		}

		fid = result.fid;
	}

	// Step 3: Register signer key on-chain (if addSig provided)
	let signerPubKey: string | undefined;
	if (body?.addSig && body?.signerPubKey && body?.signerMetadata && body?.deadline) {
		try {
			await addSignerForFid({
				client,
				config: contracts,
				fidOwner: payerAddress as Address,
				keyType: 1, // ed25519
				key: body.signerPubKey as `0x${string}`,
				metadataType: 1, // SignedKeyRequest
				metadata: body.signerMetadata as `0x${string}`,
				deadline: BigInt(body.deadline),
				signature: body.addSig as `0x${string}`,
				privyAppId: c.env.PRIVY_APP_ID,
				privyAppSecret: c.env.PRIVY_APP_SECRET,
				privyWalletId: c.env.PRIVY_SERVER_WALLET_ID,
			});
			signerPubKey = body.signerPubKey;
		} catch (err) {
			const message = err instanceof Error ? err.message : "Unknown error";
			return c.json(
				{ error: "SignerRegistrationFailed", message: `Signer key registration failed: ${message}` },
				502,
			);
		}
	}

	// Step 4: Register fname (if provided)
	let handle: string | undefined;
	if (body?.fname && body?.fnameSig && body?.fnameTimestamp) {
		try {
			await registerFname(
				body.fname,
				fid,
				payerAddress,
				body.fnameTimestamp,
				body.fnameSig,
			);
			handle = `${body.fname}.farcaster.social`;
		} catch (err) {
			// Fname registration failed — continue with default handle
			console.error("Fname registration failed:", err);
		}
	}

	// Step 5: Create PDS account via internal API key
	const pdsBaseUrl = c.env.PDS_URL.replace(/\/$/, "");
	const accountUrl = `${pdsBaseUrl}/xrpc/is.fid.account.create`;

	const pdsResp = await fetch(accountUrl, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${c.env.PDS_API_KEY}`,
		},
		body: JSON.stringify({
			fid,
			handle,
			farcasterAddress: payerAddress,
		}),
	});

	if (!pdsResp.ok) {
		const errBody = await pdsResp.text();
		return c.json(
			{ error: "PdsAccountCreationFailed", message: errBody },
			502,
		);
	}

	const pdsResult = (await pdsResp.json()) as Record<string, unknown>;

	// Step 6: Set up sync service — move pending signer key to FID-keyed storage
	if (signerPubKey) {
		try {
			const did = pdsResult.did as string;
			const pdsUrl = `https://${fid}.${c.env.PDS_URL.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;

			await setupSyncService(c.env.SYNC_SERVICE_URL, c.env.SYNC_API_KEY, {
				fid: parseInt(fid, 10),
				did,
				pdsUrl,
				address: payerAddress,
				signerPublicKey: signerPubKey.startsWith("0x") ? signerPubKey.slice(2) : signerPubKey,
			});
		} catch (err) {
			// Log but don't fail — the account and signer are created, sync can be retried
			console.error("Sync service setup failed:", err);
		}

		pdsResult.signerPubKey = signerPubKey;
	}

	return c.json(pdsResult);
});

// Health check
app.get("/health", (c) => c.json({ status: "ok" }));

export default app;
