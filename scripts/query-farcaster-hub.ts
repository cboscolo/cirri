#!/usr/bin/env bun
/**
 * Query Farcaster Hub for casts, likes, recasts, follows, and identity events.
 *
 * Usage:
 *   bun scripts/query-farcaster-hub.ts --fid 1898
 *   bun scripts/query-farcaster-hub.ts --fid 1898 --type casts
 *   bun scripts/query-farcaster-hub.ts --fid 1898 --type likes --since 2025-01-01
 *   bun scripts/query-farcaster-hub.ts --fid 1898 --type casts --since 2025-01-01 --until 2025-06-01
 *   bun scripts/query-farcaster-hub.ts --fid 1898 --cast 0xabcdef...
 *   bun scripts/query-farcaster-hub.ts --fid 1898 --type all -o results.json
 *   bun scripts/query-farcaster-hub.ts --fid 1898 --type casts --limit 10
 */

const HUB_API = process.env.HUB_API_URL ?? "https://haatz.quilibrium.com/v1";

// Farcaster epoch: 2021-01-01T00:00:00Z
const FARCASTER_EPOCH = 1609459200;

const VALID_TYPES = ["casts", "likes", "recasts", "follows", "identity", "all"] as const;
type MessageType = (typeof VALID_TYPES)[number];

interface HubMessage {
	data: {
		type: string;
		fid: number;
		timestamp: number;
		network: string;
		castAddBody?: Record<string, unknown>;
		reactionBody?: Record<string, unknown>;
		linkBody?: Record<string, unknown>;
		userDataBody?: Record<string, unknown>;
	};
	hash: string;
	hashScheme: string;
	signature: string;
	signatureScheme: string;
	signer: string;
}

interface HubResponse {
	messages: HubMessage[];
	nextPageToken?: string;
}

interface Args {
	fid: string;
	type: MessageType;
	since?: Date;
	until?: Date;
	cast?: string;
	output?: string;
	limit: number;
	hub: string;
}

function parseArgs(): Args {
	const args = process.argv.slice(2);
	const result: Args = {
		fid: "",
		type: "all",
		limit: Infinity,
		hub: HUB_API,
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		const next = args[i + 1];

		switch (arg) {
			case "--fid":
				result.fid = next ?? "";
				i++;
				break;
			case "--type":
			case "-t":
				if (next && VALID_TYPES.includes(next as MessageType)) {
					result.type = next as MessageType;
				} else {
					fatal(`Invalid type: ${next}. Valid: ${VALID_TYPES.join(", ")}`);
				}
				i++;
				break;
			case "--since":
				result.since = parseDate(next ?? "");
				i++;
				break;
			case "--until":
				result.until = parseDate(next ?? "");
				i++;
				break;
			case "--cast":
				result.cast = next ?? "";
				i++;
				break;
			case "--output":
			case "-o":
				result.output = next ?? "";
				i++;
				break;
			case "--limit":
			case "-n":
				result.limit = parseInt(next ?? "", 10);
				if (isNaN(result.limit) || result.limit < 1) fatal("--limit must be a positive integer");
				i++;
				break;
			case "--hub":
				result.hub = next ?? HUB_API;
				i++;
				break;
			case "--help":
			case "-h":
				printUsage();
				process.exit(0);
			default:
				fatal(`Unknown argument: ${arg}. Use --help for usage.`);
		}
	}

	if (!result.fid && !result.cast) {
		fatal("--fid is required (or --cast for a single cast lookup)");
	}

	return result;
}

function parseDate(s: string): Date {
	const d = new Date(s);
	if (isNaN(d.getTime())) fatal(`Invalid date: ${s}`);
	return d;
}

function fatal(msg: string): never {
	process.stderr.write(`Error: ${msg}\n`);
	process.exit(1);
}

function printUsage() {
	process.stderr.write(`Usage: bun scripts/query-farcaster-hub.ts [options]

Options:
  --fid <fid>          Farcaster FID (required unless --cast)
  --type, -t <type>    Message type: casts, likes, recasts, follows, identity, all (default: all)
  --since <date>       Only messages after this date (ISO 8601 or YYYY-MM-DD)
  --until <date>       Only messages before this date
  --cast <hash>        Get a single cast by hash (requires --fid)
  --limit, -n <num>    Max number of messages to return
  --output, -o <file>  Write output to file instead of stdout
  --hub <url>          Hub API base URL (default: ${HUB_API})
  --help, -h           Show this help

Examples:
  bun scripts/query-farcaster-hub.ts --fid 1898
  bun scripts/query-farcaster-hub.ts --fid 1898 --type casts --since 2025-06-01
  bun scripts/query-farcaster-hub.ts --fid 1898 --type likes --limit 50
  bun scripts/query-farcaster-hub.ts --fid 1898 --cast 0x4f6fa4e0cedaba8b600a3a3ee42733cfec30e69a
  bun scripts/query-farcaster-hub.ts --fid 1898 --type all -o output.json
`);
}

function dateToFarcasterTimestamp(d: Date): number {
	return Math.floor(d.getTime() / 1000) - FARCASTER_EPOCH;
}

function farcasterTimestampToIso(ts: number): string {
	return new Date((ts + FARCASTER_EPOCH) * 1000).toISOString();
}

/** Add a human-readable date field to each message */
function annotateMessage(msg: HubMessage): HubMessage & { _date: string } {
	return { ...msg, _date: farcasterTimestampToIso(msg.data.timestamp) };
}

function inDateRange(msg: HubMessage, since?: Date, until?: Date): boolean {
	const ts = msg.data.timestamp;
	if (since && ts < dateToFarcasterTimestamp(since)) return false;
	if (until && ts >= dateToFarcasterTimestamp(until)) return false;
	return true;
}

async function hubFetch(url: string): Promise<unknown> {
	const res = await fetch(url);
	if (!res.ok) {
		const body = await res.text();
		fatal(`Hub API error: ${res.status} ${res.statusText}\n  URL: ${url}\n  Body: ${body}`);
	}
	return res.json();
}

async function fetchPaginated(
	baseUrl: string,
	args: Args,
): Promise<HubMessage[]> {
	const messages: HubMessage[] = [];
	let pageToken: string | undefined;
	const sinceTs = args.since ? dateToFarcasterTimestamp(args.since) : undefined;

	while (messages.length < args.limit) {
		const url = new URL(baseUrl);
		url.searchParams.set("fid", args.fid);
		url.searchParams.set("pageSize", String(Math.min(100, args.limit - messages.length)));
		url.searchParams.set("reverse", "true"); // newest first
		if (pageToken) url.searchParams.set("pageToken", pageToken);

		const data = (await hubFetch(url.toString())) as HubResponse;

		if (!data.messages || data.messages.length === 0) break;

		for (const msg of data.messages) {
			// Since we're fetching newest-first, if we hit a message older than
			// our --since date, we can stop entirely
			if (sinceTs !== undefined && msg.data.timestamp < sinceTs) {
				return messages;
			}
			if (inDateRange(msg, args.since, args.until)) {
				messages.push(msg);
				if (messages.length >= args.limit) break;
			}
		}

		pageToken = data.nextPageToken;
		if (!pageToken) break;
	}

	return messages;
}

async function fetchCasts(args: Args): Promise<HubMessage[]> {
	return fetchPaginated(`${args.hub}/castsByFid`, args);
}

async function fetchLikes(args: Args): Promise<HubMessage[]> {
	const url = new URL(`${args.hub}/reactionsByFid`);
	url.searchParams.set("reaction_type", "Like");
	return fetchPaginated(url.toString(), args);
}

async function fetchRecasts(args: Args): Promise<HubMessage[]> {
	const url = new URL(`${args.hub}/reactionsByFid`);
	url.searchParams.set("reaction_type", "Recast");
	return fetchPaginated(url.toString(), args);
}

async function fetchFollows(args: Args): Promise<HubMessage[]> {
	return fetchPaginated(`${args.hub}/linksByFid`, args);
}

async function fetchIdentity(args: Args): Promise<HubMessage[]> {
	// UserData doesn't paginate the same way and is typically small
	const url = new URL(`${args.hub}/userDataByFid`);
	url.searchParams.set("fid", args.fid);
	const data = (await hubFetch(url.toString())) as HubResponse;
	const messages = data.messages ?? [];

	return messages
		.filter((msg) => inDateRange(msg, args.since, args.until))
		.slice(0, args.limit);
}

async function fetchSingleCast(args: Args): Promise<HubMessage> {
	const url = new URL(`${args.hub}/castById`);
	url.searchParams.set("fid", args.fid);
	url.searchParams.set("hash", args.cast!);
	return (await hubFetch(url.toString())) as HubMessage;
}

async function main() {
	const args = parseArgs();

	// Single cast lookup
	if (args.cast) {
		if (!args.fid) fatal("--fid is required with --cast");
		const msg = await fetchSingleCast(args);
		const output = JSON.stringify(annotateMessage(msg));
		await writeOutput(output, args.output);
		return;
	}

	const typesToFetch: MessageType[] =
		args.type === "all"
			? ["casts", "likes", "recasts", "follows", "identity"]
			: [args.type];

	const fetchers: Record<string, (a: Args) => Promise<HubMessage[]>> = {
		casts: fetchCasts,
		likes: fetchLikes,
		recasts: fetchRecasts,
		follows: fetchFollows,
		identity: fetchIdentity,
	};

	const results: Record<string, unknown[]> = {};

	for (const type of typesToFetch) {
		const fetcher = fetchers[type];
		if (!fetcher) fatal(`Unknown type: ${type}`);
		process.stderr.write(`Fetching ${type} for FID ${args.fid}...\n`);
		const messages = await fetcher(args);
		results[type] = messages.map(annotateMessage);
		process.stderr.write(`  ${messages.length} ${type}\n`);
	}

	// If a single type was requested, output just the array
	const output =
		typesToFetch.length === 1
			? JSON.stringify(results[typesToFetch[0]!])
			: JSON.stringify(results);

	await writeOutput(output, args.output);
}

async function writeOutput(data: string, filePath?: string) {
	if (filePath) {
		await Bun.write(filePath, data + "\n");
		process.stderr.write(`Written to ${filePath}\n`);
	} else {
		process.stdout.write(data + "\n");
	}
}

main().catch((err) => {
	process.stderr.write(`Fatal: ${err}\n`);
	process.exit(1);
});
