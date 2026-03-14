/**
 * Fname registration via the Farcaster fname server.
 *
 * Registers a username at fnames.farcaster.xyz using a signed UserNameProof.
 */

const FNAME_API = "https://fnames.farcaster.xyz";

interface FnameTransferResponse {
	transfer: {
		id: number;
		timestamp: number;
		username: string;
		owner: string;
		from: number;
		to: number;
		user_signature: string;
		server_signature: string;
	};
}

/**
 * Register an fname for a given FID.
 *
 * @param fname - The username to register (without domain suffix)
 * @param fid - The FID that will own the fname
 * @param owner - The custody address of the FID
 * @param timestamp - The timestamp used in the EIP-712 signature
 * @param signature - The EIP-712 UserNameProof signature from the owner
 * @returns The registered fname transfer data
 */
export async function registerFname(
	fname: string,
	fid: string,
	owner: string,
	timestamp: number,
	signature: string,
): Promise<FnameTransferResponse> {
	const resp = await fetch(`${FNAME_API}/transfers`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			name: fname,
			from: 0,
			to: Number(fid),
			fid: Number(fid),
			owner,
			timestamp,
			signature,
		}),
	});

	if (!resp.ok) {
		const text = await resp.text();
		throw new Error(`Fname registration failed (${resp.status}): ${text}`);
	}

	return resp.json() as Promise<FnameTransferResponse>;
}
