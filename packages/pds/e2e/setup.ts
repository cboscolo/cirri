import type { ChildProcess } from "node:child_process";
import { mkdtemp, cp, readFile, writeFile, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

/** File used to pass the server port from global setup to test workers */
export const PORT_FILE = join(
	dirname(fileURLToPath(import.meta.url)),
	".e2e-port",
);

const __dirname = dirname(fileURLToPath(import.meta.url));

let serverProcess: ChildProcess;
let tempDir: string;

function runCommand(
	cmd: string,
	args: string[],
	cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const proc = spawn(cmd, args, { cwd });
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (data) => (stdout += data));
		proc.stderr.on("data", (data) => (stderr += data));
		proc.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
	});
}

export async function setup() {
	// Create temp directory
	tempDir = await mkdtemp(join(tmpdir(), "pds-e2e-"));

	// Copy fixture to temp directory
	const fixturePath = resolve(__dirname, "fixture");
	await cp(fixturePath, tempDir, { recursive: true });

	// Update package.json with actual path to pds package
	const pdsPackagePath = resolve(__dirname, "..");
	const packageJsonPath = join(tempDir, "package.json");
	const packageJson = await readFile(packageJsonPath, "utf-8");
	await writeFile(
		packageJsonPath,
		packageJson.replace("{{PDS_PACKAGE_PATH}}", `file:${pdsPackagePath}`),
	);

	// Install dependencies
	console.log("Installing dependencies...");
	const installResult = await runCommand("npm", ["install"], tempDir);
	if (installResult.code !== 0) {
		console.error("npm install failed:", installResult.stderr);
		throw new Error(`npm install failed with code ${installResult.code}`);
	}

	// Start Vite dev server
	const port = await startViteServer(tempDir);

	// Wait for the Cloudflare Worker to be ready inside Vite.
	// Vite's HTTP server starts before the Worker environment loads,
	// so we poll the /__test/ping endpoint until the Worker responds.
	await waitForWorkerReady(port);
	console.log(`E2E test server started on port ${port}`);

	// Write port to a file so test workers can read it
	// (globalSetup runs in a separate process from test workers)
	await writeFile(PORT_FILE, port.toString());

	(globalThis as Record<string, unknown>).__e2e_port__ = port;
	(globalThis as Record<string, unknown>).__e2e_tempDir__ = tempDir;
}

async function waitForWorkerReady(
	port: number,
	timeoutMs = 30000,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const res = await fetch(`http://localhost:${port}/__test/ping`);
			const text = await res.text();
			if (text === "pong") return;
		} catch {
			// Server not ready yet
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(
		`Worker not ready after ${timeoutMs}ms on port ${port}`,
	);
}

function startViteServer(cwd: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const proc = spawn("npm", ["run", "dev"], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});

		serverProcess = proc;

		let output = "";
		const timeout = setTimeout(() => {
			proc.kill();
			reject(
				new Error(
					`Vite server startup timeout after 60s. Output:\n${output}`,
				),
			);
		}, 60000);

		proc.stdout?.on("data", (data: Buffer) => {
			const chunk = data.toString();
			output += chunk;

			// Strip ANSI escape codes and look for localhost:port
			const cleanOutput = output.replace(/\x1b\[[0-9;]*m/g, "");
			const match = cleanOutput.match(/localhost:(\d+)/);
			if (match?.[1]) {
				clearTimeout(timeout);
				resolve(parseInt(match[1], 10));
			}
		});

		proc.stderr?.on("data", (data: Buffer) => {
			output += data.toString();
		});

		proc.on("error", (err) => {
			clearTimeout(timeout);
			reject(err);
		});

		proc.on("close", (code) => {
			if (code !== 0) {
				clearTimeout(timeout);
				reject(new Error(`Vite exited with code ${code}. Output:\n${output}`));
			}
		});
	});
}

export async function teardown() {
	if (serverProcess) {
		serverProcess.kill();
		console.log("E2E test server stopped");
	}

	// Clean up port file
	try {
		await rm(PORT_FILE);
	} catch {
		// Ignore if already removed
	}

	// Clean up temp directory
	if (tempDir) {
		try {
			await rm(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	}
}
