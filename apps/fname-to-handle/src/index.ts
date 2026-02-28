/**
 * FNAME-to-Handle Worker
 *
 * Serves /.well-known/atproto-did on *.farcaster.social subdomains.
 * Resolves FNAME → FID via the Farcaster FNAME registry,
 * then returns did:web:FID.fid.is as plain text.
 */

const corsHeaders = {
	"Access-Control-Allow-Origin": "*",
};

export default {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		// Handle CORS preflight
		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: corsHeaders });
		}

		if (url.pathname !== "/.well-known/atproto-did") {
			return new Response("Not Found", { status: 404, headers: corsHeaders });
		}

		// Extract FNAME from subdomain
		const hostname = url.hostname;
		const fname = hostname.split(".")[0];
		if (!fname || fname === hostname) {
			return new Response("Invalid hostname", { status: 400, headers: corsHeaders });
		}

		// Look up FID from FNAME registry
		const res = await fetch(
			`https://fnames.farcaster.xyz/transfers/current?name=${encodeURIComponent(fname)}`,
			{ signal: AbortSignal.timeout(5000) },
		);

		if (!res.ok) {
			return new Response("FNAME not found", { status: 404, headers: corsHeaders });
		}

		const data = (await res.json()) as { transfer?: { to: number } };
		const fid = data.transfer?.to;

		if (!fid) {
			return new Response("FNAME not found", { status: 404, headers: corsHeaders });
		}

		return new Response(`did:web:${fid}.fid.is`, {
			headers: {
				...corsHeaders,
				"Content-Type": "text/plain",
				"Cache-Control": "public, max-age=300",
			},
		});
	},
} satisfies ExportedHandler;
