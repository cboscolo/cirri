/**
 * FID Passkey Endpoints
 *
 * Custom XRPC endpoints for managing passkeys (WebAuthn credentials).
 * Allows authenticated users to register, list, and delete passkeys.
 */

import type { Context } from "hono";
import type { AppEnv } from "../types";
import type { AccountDurableObject } from "../account-do";
import {
	generateRegistrationOptions,
	verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";

/** Token TTL in milliseconds (10 minutes) */
const TOKEN_TTL_MS = 10 * 60 * 1000;

/**
 * Generate a secure random token
 */
function generateToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=/g, "");
}

/**
 * Get passkey registration options.
 *
 * POST /xrpc/is.fid.passkey.registrationOptions
 * Auth: Required (Bearer token)
 *
 * Returns WebAuthn registration options and a token for the verification step.
 */
export async function registrationOptions(
	c: Context<AppEnv>,
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<Response> {
	const did = c.get("did");
	const rpID = c.env.WEBFID_DOMAIN;

	// Get existing passkeys to exclude them
	const existingPasskeys = await accountDO.rpcListPasskeys();

	const options = await generateRegistrationOptions({
		rpName: "fid.is",
		rpID,
		userName: did,
		userDisplayName: did,
		authenticatorSelection: {
			residentKey: "required",
			userVerification: "preferred",
		},
		attestationType: "none",
		excludeCredentials: existingPasskeys.map((pk) => ({
			id: pk.credentialId,
		})),
	});

	// Store the challenge with a token for later verification
	const token = generateToken();
	const expiresAt = Date.now() + TOKEN_TTL_MS;
	await accountDO.rpcSavePasskeyToken(token, options.challenge, expiresAt);

	return c.json({ options, token });
}

/**
 * Complete passkey registration.
 *
 * POST /xrpc/is.fid.passkey.register
 * Auth: Required (Bearer token)
 * Body: { token, response: RegistrationResponseJSON, name? }
 *
 * Verifies the registration response and stores the new passkey.
 */
export async function register(
	c: Context<AppEnv>,
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<Response> {
	const body = await c.req
		.json<{
			token: string;
			response: RegistrationResponseJSON;
			name?: string;
		}>()
		.catch(() => null);

	if (!body?.token || !body?.response) {
		return c.json(
			{
				error: "InvalidRequest",
				message: "Request body must contain token and response fields",
			},
			400,
		);
	}

	const rpID = c.env.WEBFID_DOMAIN;

	// Consume the token to get the challenge
	const tokenData = await accountDO.rpcConsumePasskeyToken(body.token);
	if (!tokenData) {
		return c.json(
			{ error: "InvalidToken", message: "Invalid or expired token" },
			400,
		);
	}

	// Validate the origin: must be under *.{WEBFID_DOMAIN} or the domain itself
	const origin = c.req.header("Origin");
	if (!origin) {
		return c.json(
			{ error: "InvalidRequest", message: "Missing Origin header" },
			400,
		);
	}

	try {
		const originHost = new URL(origin).hostname;
		if (originHost !== rpID && !originHost.endsWith(`.${rpID}`)) {
			return c.json(
				{ error: "InvalidOrigin", message: "Origin does not match RP ID" },
				400,
			);
		}
	} catch {
		return c.json(
			{ error: "InvalidOrigin", message: "Invalid Origin header" },
			400,
		);
	}

	try {
		const verification = await verifyRegistrationResponse({
			response: body.response,
			expectedChallenge: tokenData.challenge,
			expectedOrigin: origin,
			expectedRPID: rpID,
		});

		if (!verification.verified || !verification.registrationInfo) {
			return c.json(
				{ error: "VerificationFailed", message: "Verification failed" },
				400,
			);
		}

		const { credential } = verification.registrationInfo;

		await accountDO.rpcSavePasskey(
			credential.id,
			credential.publicKey,
			credential.counter,
			body.name,
		);

		return c.json({ success: true });
	} catch (err) {
		return c.json(
			{
				error: "VerificationFailed",
				message:
					err instanceof Error ? err.message : "Registration failed",
			},
			400,
		);
	}
}

/**
 * List registered passkeys.
 *
 * GET /xrpc/is.fid.passkey.list
 * Auth: Required (Bearer token)
 *
 * Returns all passkeys for the authenticated user.
 */
export async function list(
	c: Context<AppEnv>,
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<Response> {
	const passkeys = await accountDO.rpcListPasskeys();
	return c.json({
		passkeys: passkeys.map((pk) => ({
			id: pk.credentialId,
			name: pk.name,
			createdAt: pk.createdAt,
			lastUsedAt: pk.lastUsedAt,
		})),
	});
}

/**
 * Rename a passkey.
 *
 * POST /xrpc/is.fid.passkey.rename
 * Auth: Required (Bearer token)
 * Body: { credentialId, name }
 */
export async function rename(
	c: Context<AppEnv>,
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<Response> {
	const body = await c.req
		.json<{ credentialId: string; name: string }>()
		.catch(() => null);

	if (!body?.credentialId || typeof body?.name !== "string") {
		return c.json(
			{
				error: "InvalidRequest",
				message: "Request body must contain credentialId and name fields",
			},
			400,
		);
	}

	const name = body.name.trim();
	if (name.length === 0 || name.length > 100) {
		return c.json(
			{
				error: "InvalidRequest",
				message: "Name must be between 1 and 100 characters",
			},
			400,
		);
	}

	const renamed = await accountDO.rpcRenamePasskey(body.credentialId, name);

	if (!renamed) {
		return c.json(
			{ error: "NotFound", message: "Passkey not found" },
			404,
		);
	}

	return c.json({ success: true });
}

/**
 * Delete a passkey.
 *
 * POST /xrpc/is.fid.passkey.delete
 * Auth: Required (Bearer token)
 * Body: { credentialId }
 *
 * Removes a passkey by credential ID.
 */
export async function remove(
	c: Context<AppEnv>,
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<Response> {
	const body = await c.req
		.json<{ credentialId: string }>()
		.catch(() => null);

	if (!body?.credentialId) {
		return c.json(
			{
				error: "InvalidRequest",
				message: "Request body must contain credentialId field",
			},
			400,
		);
	}

	const deleted = await accountDO.rpcDeletePasskey(body.credentialId);

	if (!deleted) {
		return c.json(
			{ error: "NotFound", message: "Passkey not found" },
			404,
		);
	}

	return c.json({ success: true });
}
