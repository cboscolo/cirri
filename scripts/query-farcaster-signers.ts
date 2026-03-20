/**
 * Query Farcaster signers and decode SignedKeyRequest metadata for an FID.
 *
 * Usage:
 *   npx tsx scripts/query-farcaster-signers.ts [fid]
 *
 * Defaults to FID 1898 if no argument provided.
 */

import { decodeAbiParameters } from "viem";

const HUB_API = "https://haatz.quilibrium.com/v1";

const fid = process.argv[2] || "1898";

interface SignerEvent {
	type: string;
	chainId: number;
	blockNumber: number;
	blockTimestamp: number;
	transactionHash: string;
	fid: number;
	signerEventBody: {
		key: string;
		keyType: number;
		eventType: string;
		metadata: string;
		metadataType: number;
	};
}

interface SignedKeyRequestMetadata {
	requestFid: bigint;
	requestSigner: string;
	signature: string;
	deadline: bigint;
}

function decodeSignedKeyRequestMetadata(
	base64Metadata: string,
): SignedKeyRequestMetadata | null {
	try {
		const bytes = Buffer.from(base64Metadata, "base64");
		const hex = `0x${bytes.toString("hex")}` as `0x${string}`;

		const [decoded] = decodeAbiParameters(
			[
				{
					type: "tuple",
					components: [
						{ name: "requestFid", type: "uint256" },
						{ name: "requestSigner", type: "address" },
						{ name: "signature", type: "bytes" },
						{ name: "deadline", type: "uint256" },
					],
				},
			],
			hex,
		);

		return {
			requestFid: decoded.requestFid,
			requestSigner: decoded.requestSigner,
			signature: decoded.signature,
			deadline: decoded.deadline,
		};
	} catch (e) {
		console.error("  Failed to decode metadata:", (e as Error).message);
		return null;
	}
}

async function lookupFname(fid: string | bigint): Promise<string | null> {
	try {
		const res = await fetch(
			`https://fnames.farcaster.xyz/transfers?fid=${fid}`,
		);
		if (!res.ok) return null;
		const data = (await res.json()) as {
			transfers: { username: string }[];
		};
		const last = data.transfers[data.transfers.length - 1];
		return last?.username ?? null;
	} catch {
		return null;
	}
}

async function main() {
	console.log(`\n=== Farcaster Signers for FID ${fid} ===\n`);

	const res = await fetch(`${HUB_API}/onChainSignersByFid?fid=${fid}`);
	if (!res.ok) {
		console.error(`Hub API error: ${res.status} ${res.statusText}`);
		process.exit(1);
	}

	const data = (await res.json()) as { events: SignerEvent[] };
	const events = data.events;

	console.log(`Found ${events.length} signer event(s)\n`);

	for (const event of events) {
		const body = event.signerEventBody;
		const date = new Date(event.blockTimestamp * 1000).toISOString();

		console.log(`--- Signer ---`);
		console.log(`  Event:     ${body.eventType}`);
		console.log(`  Key:       ${body.key}`);
		console.log(`  Key Type:  ${body.keyType} (${body.keyType === 1 ? "ed25519" : "unknown"})`);
		console.log(`  Block:     ${event.blockNumber}`);
		console.log(`  Date:      ${date}`);
		console.log(`  Tx:        ${event.transactionHash}`);

		if (body.metadataType === 1 && body.metadata) {
			const meta = decodeSignedKeyRequestMetadata(body.metadata);
			if (meta) {
				const fname = await lookupFname(meta.requestFid.toString());
				const deadlineDate = new Date(
					Number(meta.deadline) * 1000,
				).toISOString();
				console.log(`  Metadata (SignedKeyRequest):`);
				console.log(
					`    requestFid:    ${meta.requestFid}${fname ? ` (@${fname})` : ""}`,
				);
				console.log(`    requestSigner: ${meta.requestSigner}`);
				console.log(`    deadline:      ${deadlineDate}`);
			}
		} else {
			console.log(`  Metadata:  type=${body.metadataType} (not SignedKeyRequest)`);
		}
		console.log();
	}
}

main().catch(console.error);
