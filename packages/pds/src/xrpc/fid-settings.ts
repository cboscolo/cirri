/**
 * FID Settings Endpoints
 *
 * Custom XRPC endpoints for managing account settings,
 * including custom PDS URL configuration.
 */

import type { Context } from "hono";
import type { PDSEnv, AppEnv } from "../types";
import type { AccountDurableObject } from "../account-do";

/** Function type for getting Account DO by DID */
type GetAccountDO = (
	env: PDSEnv,
	did: string,
) => DurableObjectStub<AccountDurableObject>;

export interface PdsUrlResponse {
	pdsUrl: string | null;
	isCustom: boolean;
	defaultUrl: string;
	verificationKey: string | null;
	defaultVerificationKey: string;
}

/**
 * Get the PDS URL configuration for the authenticated user.
 *
 * GET /xrpc/is.fid.settings.getPdsUrl
 * Auth: Required (Bearer token)
 *
 * Returns:
 * - pdsUrl: The current PDS URL (custom or default)
 * - isCustom: Whether a custom URL is configured
 * - defaultUrl: The default fid.is URL for this account
 */
export async function getPdsUrl(
	c: Context<AppEnv>,
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<Response> {
	const did = c.get("did");

	// Get identity to derive default URL
	const identity = await accountDO.rpcGetAtprotoIdentity();
	if (!identity) {
		return c.json(
			{ error: "AccountNotFound", message: "Account not found" },
			404,
		);
	}

	const [customPdsUrl, customVerificationKey] = await Promise.all([
		accountDO.rpcGetCustomPdsUrl(),
		accountDO.rpcGetCustomVerificationKey(),
	]);
	const defaultUrl = `https://pds-${identity.handle}`;

	return c.json({
		pdsUrl: customPdsUrl || defaultUrl,
		isCustom: customPdsUrl !== null,
		defaultUrl,
		verificationKey: customVerificationKey,
		defaultVerificationKey: identity.signingKeyPublic,
	} satisfies PdsUrlResponse);
}

/**
 * Set or clear the custom PDS URL for the authenticated user.
 *
 * POST /xrpc/is.fid.settings.setPdsUrl
 * Auth: Required (Bearer token)
 * Input: { pdsUrl: string | null }
 *
 * When pdsUrl is set:
 * - Must be a valid HTTPS URL
 * - DID document will point to this URL
 * - PDS endpoints on fid.is continue working
 *
 * When pdsUrl is null:
 * - Resets to default fid.is behavior
 * - DID document points back to NNN.fid.is
 *
 * Returns:
 * - success: true
 * - pdsUrl: The current PDS URL after the change
 * - isCustom: Whether a custom URL is now configured
 */
export async function setPdsUrl(
	c: Context<AppEnv>,
	accountDO: DurableObjectStub<AccountDurableObject>,
): Promise<Response> {
	const body = await c.req
		.json<{ pdsUrl: string | null; verificationKey?: string | null }>()
		.catch(() => null);

	if (body === null || !("pdsUrl" in body)) {
		return c.json(
			{
				error: "InvalidRequest",
				message: "Request body must contain pdsUrl field",
			},
			400,
		);
	}

	const { pdsUrl, verificationKey } = body;

	// Validate URL if provided
	if (pdsUrl !== null) {
		try {
			const parsed = new URL(pdsUrl);
			if (parsed.protocol !== "https:") {
				return c.json(
					{
						error: "InvalidRequest",
						message: "Custom PDS URL must use HTTPS",
					},
					400,
				);
			}
		} catch {
			return c.json(
				{
					error: "InvalidRequest",
					message: "Invalid URL format",
				},
				400,
			);
		}
	}

	// Get identity for default URL
	const identity = await accountDO.rpcGetAtprotoIdentity();
	if (!identity) {
		return c.json(
			{ error: "AccountNotFound", message: "Account not found" },
			404,
		);
	}

	// Validate verification key if provided
	if (verificationKey !== undefined && verificationKey !== null) {
		if (!verificationKey.startsWith("z") || verificationKey.length < 2) {
			return c.json(
				{
					error: "InvalidRequest",
					message: "Verification key must be a multibase base58btc string (starting with 'z')",
				},
				400,
			);
		}
	}

	try {
		await accountDO.rpcSetCustomPdsUrl(pdsUrl);

		// When resetting PDS URL to default, also clear custom verification key
		if (pdsUrl === null) {
			await accountDO.rpcSetCustomVerificationKey(null);
		} else if (verificationKey !== undefined) {
			await accountDO.rpcSetCustomVerificationKey(verificationKey);
		}
	} catch (err) {
		return c.json(
			{
				error: "InternalError",
				message:
					err instanceof Error ? err.message : "Failed to update PDS URL",
			},
			500,
		);
	}

	const defaultUrl = `https://pds-${identity.handle}`;

	return c.json({
		success: true,
		pdsUrl: pdsUrl || defaultUrl,
		isCustom: pdsUrl !== null,
	});
}
