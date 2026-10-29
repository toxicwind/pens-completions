#!/usr/bin/env bun
/**
 * pens-completions — LOCAL completions gateway for the /home/toxic/pens ecosystem.
 *
 * The filesystem IS the model registry: `model` in an OpenAI-compatible
 * /v1/completions request is a pens route:
 *
 *   echo.pens.local    — zero-transport canary (no upstream, pure local)
 *   wtf.pens.local     — canary that FAILS on "fail" (audit path proof)
 *   router.pens.local  — routes to the estate mesh gateway (rhodochrosite
 *                        :25193, keyed) and serves nvidia nemotron flash
 *
 * Auth of upstream: RHODOCHROSITE_API_KEY env, falling back to the corral
 * client key on disk (digests SSOT at ~/.hodos-data/config.json client_auth).
 *
 * MCP surface: POST /mcp (JSON-RPC 2.0) exposing pens_complete / pens_models /
 * pens_health — register in thresher mcp_config.json exactly like flotilla.
 *
 * Port: PENS_COMPLETIONS_PORT (ports.env SSOT), default 25252.
 */
import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";

const PORT = Number(process.env.PENS_COMPLETIONS_PORT ?? 25252);
const PENS_ROOT = `${process.env.HOME}/pens`;
const RHO_ORIGIN = process.env.RHODOCHROSITE_ORIGIN ?? "http://127.0.0.1:25193";
const DEFAULT_MODEL = process.env.PENS_DEFAULT_MODEL ?? "nvidia/nemotron-3.5-super-vl-120b-a12b";
const AUDIT_LOG = process.env.PENS_COMPLETIONS_AUDIT ?? "/tmp/completions_audit_local.log";

function upstreamKey(): string {
	const env = process.env.RHODOCHROSITE_API_KEY?.trim();
	if (env) return env;
	const corral = `${process.env.HOME}/.hodos-data/client-key.corral`;
	if (existsSync(corral)) return readFileSync(corral, "utf-8").split("\n")[0].trim();
	return "";
}

type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E };
const Ok = <T,>(value: T): Result<T> => ({ ok: true, value });
const Err = <T,>(error: string): Result<T> => ({ ok: false, error });

type Completion = { text: string; finish: "stop" | "error"; model: string; auditedFail?: string };
type Agent = (prompt: string, kw: Record<string, unknown>) => Completion | Promise<Completion>;

const agentEcho: Agent = (prompt) => ({
	text: `[LOCAL echo.pens.local @ ${PENS_ROOT}] ${prompt.slice(0, 120)}`,
	finish: "stop",
	model: "echo.pens.local",
});

const agentWtf: Agent = (prompt) => {
	if (prompt.toLowerCase().includes("fail")) {
		return {
			text: "LOCAL FAIL AUDIT - WTF ARE WE DOING THESE ARENT POC AT ALL",
			finish: "error",
			model: "wtf.pens.local",
			auditedFail: "intentional canary failure",
		};
	}
	return { text: `LOCAL WTF agent says: ${prompt.toUpperCase()} from ${PENS_ROOT}`, finish: "stop", model: "wtf.pens.local" };
};

	async function upstreamComplete(prompt: string, model: string, maxTokens: number): Promise<Result<Completion>> {
	const key = upstreamKey();
	if (!key) return Err("no upstream key: RHODOCHROSITE_API_KEY unset and client-key.corral missing");
	// Reasoning-budget contract (AGENTS.md D-2026-10-23 #1): reasoning + content
	// share ONE ceiling. Floor at 2500 so reasoning models can emit content.
	const budget = Math.max(2500, maxTokens);
	const body = {
		model,
		messages: [{ role: "user", content: prompt }],
		max_tokens: budget,
		stream: false,
	};
	try {
		const res = await fetch(`${RHO_ORIGIN}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(Number(process.env.PENS_UPSTREAM_TIMEOUT_MS ?? 180000)),
		});
		const text = await res.text();
		if (!res.ok) return Err(`upstream ${res.status}: ${text.slice(0, 300)}`);
		const data = JSON.parse(text) as {
			choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
		};
		const choice = data.choices?.[0];
		if (!choice) return Err(`upstream returned no choices: ${text.slice(0, 200)}`);
		return Ok({ text: choice.message?.content ?? "", finish: "stop", model });
	} catch (e) {
		return Err(`upstream fetch failed: ${(e as Error).message}`);
	}
}

/** router.pens.local: pens-path routing. Last non-meta chain element picks the agent. */
async function routeComplete(prompt: string, modelName: string, maxTokens: number): Promise<Completion> {
	const chain = modelName.split(".").filter((p) => !["pens", "local", "v1", "completions", ""].includes(p));
	const target = chain.at(-1) ?? "echo";
	if (target === "echo") return agentEcho(prompt, {});
	if (target === "wtf") return agentWtf(prompt, {});
	// real upstream: default mesh model unless the chain names one we know
	const upstreamModel = target === "router" ? DEFAULT_MODEL : modelName;
	const res = await upstreamComplete(prompt, upstreamModel, maxTokens);
	if (res.ok) return res.value;
	audit({ time: Date.now() / 1000, model: modelName, err: res.error });
	return { text: `[LOCAL AUDITED FAIL] ${res.error}`, finish: "error", model: modelName, auditedFail: res.error };
}

function audit(row: Record<string, unknown>): void {
	try {
		mkdirSync(`${process.env.HOME}/.cache`, { recursive: true });
		appendFileSync(AUDIT_LOG, `${JSON.stringify(row)}\n`);
	} catch { /* audit is best-effort, never fatal */ }
}

const MODELS = [
	{ id: "echo.pens.local", object: "model", owned_by: "pens-local" },
	{ id: "wtf.pens.local", object: "model", owned_by: "pens-local" },
	{ id: "router.pens.local", object: "model", owned_by: "pens-mesh" },
];

async function complete(prompt: string, model: string, maxTokens: number): Promise<Completion> {
	const clean = model.replace("pens://", "");
	if (clean === "echo.pens.local") return agentEcho(prompt, {});
	if (clean === "wtf.pens.local") return agentWtf(prompt, {});
	return routeComplete(prompt, clean, maxTokens);
}

// ---------- HTTP ----------
type JsonRpcRequest = { jsonrpc: "2.0"; id?: unknown; method: string; params?: Record<string, unknown> };

function json(res: ServerResponse, code: number, body: unknown): void {
	res.writeHead(code, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

const TOOLS = [
	{
		name: "pens_complete",
		description: "Complete a prompt through a pens-registry model route (echo.pens.local | wtf.pens.local | router.pens.local -> nvidia nemotron flash via rhodochrosite)",
		inputSchema: {
			type: "object",
			properties: {
				prompt: { type: "string", description: "The prompt to complete" },
				model: { type: "string", description: "pens route id", default: "router.pens.local" },
				max_tokens: { type: "number", description: "max completion tokens", default: 256 },
			},
			required: ["prompt"],
		},
	},
	{
		name: "pens_models",
		description: "List pens-registry model routes (local canaries + mesh upstream)",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "pens_health",
		description: "Gateway + rhodochrosite upstream health",
		inputSchema: { type: "object", properties: {} },
	},
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
	if (name === "pens_complete") {
		const prompt = String(args.prompt ?? "");
		const model = String(args.model ?? "router.pens.local");
		const maxTokens = Number(args.max_tokens ?? 256);
		const out = await complete(prompt, model, maxTokens);
		if (out.finish === "error") return { isError: true, content: [{ type: "text", text: out.text }] };
		return { content: [{ type: "text", text: out.text }] };
	}
	if (name === "pens_models") {
		return { content: [{ type: "text", text: JSON.stringify(MODELS, null, 1) }] };
	}
	if (name === "pens_health") {
		const key = upstreamKey();
		let upstream = "unreachable";
		try {
			const r = await fetch(`${RHO_ORIGIN}/health`, { signal: AbortSignal.timeout(4000) });
			upstream = r.ok ? `healthy (${r.status})` : `status ${r.status}`;
		} catch (e) {
			upstream = `error: ${(e as Error).message}`;
		}
		return {
			content: [{
				type: "text",
				text: JSON.stringify({ gateway: "healthy", upstream, upstream_keyed: Boolean(key), port: PORT }, null, 1),
			}],
		};
	}
	throw new Error(`unknown tool: ${name}`);
}

function mcpResult(id: unknown, result: unknown): unknown {
	return { jsonrpc: "2.0", id, result };
}
function mcpError(id: unknown, code: number, message: string): unknown {
	return { jsonrpc: "2.0", id, error: { code, message } };
}

import type { ServerResponse } from "node:http";

async function handleMcp(req: JsonRpcRequest, res: ServerResponse): Promise<void> {
	const { id, method, params } = req;
	if (method === "initialize") {
		json(res, 200, mcpResult(id, {
			protocolVersion: "2024-11-05",
			capabilities: { tools: {} },
			serverInfo: { name: "pens-completions", version: "1.0.0" },
		}));
		return;
	}
	if (method === "tools/list") {
		json(res, 200, mcpResult(id, { tools: TOOLS }));
		return;
	}
	if (method === "tools/call") {
		const name = String(params?.name ?? "");
		const args = (params?.arguments as Record<string, unknown>) ?? {};
		try {
			json(res, 200, mcpResult(id, await callTool(name, args)));
		} catch (e) {
			json(res, 200, mcpError(id, -32602, String((e as Error).message)));
		}
		return;
	}
	if (method === "ping") {
		json(res, 200, mcpResult(id, {}));
		return;
	}
	json(res, 200, mcpError(id, -32601, `method not found: ${method}`));
}

async function handleCompletions(data: Record<string, unknown>, res: ServerResponse): Promise<void> {
	const model = String(data.model ?? "echo.pens.local");
	const prompt = String(data.prompt ?? "");
	const maxTokens = Number(data.max_tokens ?? 16);
	const out = await complete(prompt, model, maxTokens);
	if (out.auditedFail) audit({ time: Date.now() / 1000, model, err: out.auditedFail });
	json(res, 200, {
		id: `cmpl-local-${crypto.randomUUID().slice(0, 12)}`,
		object: "text_completion",
		created: Math.floor(Date.now() / 1000),
		model,
		choices: [{ text: out.text, index: 0, finish_reason: out.finish }],
		usage: {
			prompt_tokens: prompt.split(/\s+/).filter(Boolean).length,
			completion_tokens: out.text.split(/\s+/).filter(Boolean).length,
		},
		local_path: PENS_ROOT,
	});
}

const server = Bun.serve({
	port: PORT,
	hostname: "127.0.0.1",
	// monadic pipeline: parse -> route -> respond, no try/catch pyramids
	async fetch(req): Promise<Response> {
		const url = new URL(req.url);
		if (req.method === "GET" && url.pathname === "/health") {
			return Response.json({ status: "healthy", gateway: "pens-completions", port: PORT, upstream: RHO_ORIGIN });
		}
		if (req.method === "GET" && url.pathname === "/v1/models") {
			return Response.json({ object: "list", data: MODELS });
		}
		if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
		const raw = await req.text().catch(() => "{}");
		let data: Record<string, unknown> = {};
		try { data = JSON.parse(raw || "{}") as Record<string, unknown>; } catch { data = {}; }

		if (url.pathname === "/mcp") {
			const rpc = data as unknown as JsonRpcRequest;
			// adapt to the shared handler via a shim response collector
			let status = 200; let body: unknown = {};
			const shim = {
				writeHead: (c: number) => { status = c; },
				end: (b: string) => { try { body = JSON.parse(b); } catch { body = {}; } },
			} as unknown as ServerResponse;
			await handleMcp(rpc, shim);
			return Response.json(body as Record<string, unknown>, { status });
		}
		if (url.pathname === "/v1/completions") {
			let status = 200; let body: unknown = {};
			const shim = {
				writeHead: (c: number) => { status = c; },
				end: (b: string) => { try { body = JSON.parse(b); } catch { body = {}; } },
			} as unknown as ServerResponse;
			await handleCompletions(data, shim);
			return Response.json(body as Record<string, unknown>, { status });
		}
		return new Response("not found", { status: 404 });
	},
});

console.log(`pens-completions gateway on http://127.0.0.1:${PORT} (mesh upstream ${RHO_ORIGIN}, default model ${DEFAULT_MODEL})`);
export { server };
