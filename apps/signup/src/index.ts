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
	getRegistrationPrice,
	registerForFid,
} from "./farcaster-contracts";
import {
	buildRegisterTypedData,
	buildRegisterDomain,
	REGISTER_TYPES,
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
		/** Override chain ID for contract interactions (default: 10 = Optimism) */
		CHAIN_ID?: string;
	};
};

const app = new Hono<Env>();

app.onError((err, c) => {
	console.error("Unhandled error:", err);
	return c.json({ error: "ServerError", message: err.message }, 500);
});

app.use("*", cors({ origin: "*" }));

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

	// Fetch nonce and price in parallel
	const [nonce, priceWei, existingFid] = await Promise.all([
		getIdGatewayNonce(client, addr, contracts),
		getRegistrationPrice(client, contracts),
		getFidForAddress(client, addr, contracts),
	]);

	// Deadline: 1 hour from now
	const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
	const recovery = c.env.RECOVERY_ADDRESS as Address;

	const registerTypedData = buildRegisterTypedData({
		to: addr,
		recovery,
		nonce,
		deadline,
		idGateway: contracts.idGateway,
		chainId: contracts.chainId,
	});

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
		nonce: nonce.toString(),
		deadline: deadline.toString(),
		recoveryAddress: recovery,
		registerTypedData,
		fnameTypedData,
	});
});

/**
 * POST /api/create
 *
 * x402-gated endpoint that:
 * 1. Verifies payment, extracts payer address
 * 2. Registers FID on-chain (if payer doesn't already have one)
 * 3. Registers fname (if provided)
 * 4. Creates PDS account via internal API key
 * 5. Returns the complete account info
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

	// Step 3: Register fname (if provided)
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

	// Step 4: Create PDS account via internal API key
	// The create endpoint reads FID from the request body, so we don't need subdomain routing.
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

	const pdsResult = await pdsResp.json();

	return c.json(pdsResult);
});

// Health check
app.get("/health", (c) => c.json({ status: "ok" }));

export default app;
