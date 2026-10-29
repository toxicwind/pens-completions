#!/usr/bin/env bun
/**
 * pens-completions — contract tests for the gateway.
 *
 * Unit level: stripScheme / filterChain / pickTarget / budgetFloor / normalizeModel
 * Integration level: full gateway on an ephemeral port against a stub upstream
 * (Bun.serve(port: 0)). No port collisions, no external servers.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
	stripScheme,
	filterChain,
	pickTarget,
	budgetFloor,
	normalizeModel,
} from "./routes.ts";
import { createGateway } from "./server.ts";

describe("pens route parsing", () => {
	test("strips pens:// scheme", () => {
		expect(stripScheme("pens://echo.pens.local")).toBe("echo.pens.local");
		expect(stripScheme("echo.pens.local")).toBe("echo.pens.local");
		expect(stripScheme("router.pens.local")).toBe("router.pens.local");
	});
	test("meta segments filtered from chain", () => {
		expect(filterChain("router.pens.local.v1.completions")).toEqual(["router"]);
		expect(filterChain("a.b.c.pens.local")).toEqual(["a", "b", "c"]);
		expect(filterChain("echo.pens.local")).toEqual(["echo"]);
	});
	test("last chain element picks agent", () => {
		expect(pickTarget(filterChain("echo.pens.local"))).toBe("echo");
		expect(pickTarget(filterChain("x.wtf.pens.local"))).toBe("wtf");
		expect(pickTarget([])).toBe("echo");
	});
	test("normalizeModel keeps unknown chains as upstream model id", () => {
		expect(normalizeModel("z-ai/glm-5.3-flash.pens.local")).toBe("z-ai/glm-5.3-flash.pens.local");
		expect(normalizeModel("router.pens.local")).toBe("router.pens.local");
	});
});

describe("reasoning-budget contract", () => {
	test("floor at 2500 (AGENTS.md D-2026-10-23 #1)", () => {
		expect(budgetFloor(16)).toBe(2500);
		expect(budgetFloor(2499)).toBe(2500);
		expect(budgetFloor(2500)).toBe(2500);
		expect(budgetFloor(4000)).toBe(4000);
	});
});

describe("gateway HTTP surface (ephemeral port + stub upstream)", () => {
	let server: { server: import("bun").Bun.Serve; port: number };
	let stubUrl = "";
	let stubCalls: Array<{ path: string; body: any }> = [];

	beforeAll(async () => {
		const stub = Bun.serve({
			port: 0,
			async fetch(req) {
				const url = new URL(req.url);
				const body = await req.text().catch(() => "{}");
				stubCalls.push({ path: url.pathname, body: JSON.parse(rawBody(body)) });
				if (url.pathname === "/v1/models") {
					return Response.json({ object: "list", data: [{ id: "stub.model", object: "model" }] });
				}
				return Response.json({ object: "chat.completion", choices: [{ message: { content: `stub:${prompt(url.pathname)}` } }] });
			},
		});
		stubUrl = stub.url;
		server = createGateway({ port: 0, origin: stubUrl });
	});

	afterAll(() => {
		server.server.stop();
	});

	test("health responds", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/health`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.status).toBe("healthy");
		expect(body.gateway).toBe("pens-completions");
		expect(body.upstream).toBe(stubUrl);
	});

	test("models lists registry ids", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/v1/models`);
		const body = await res.json();
		const ids = body.data.map((m: any) => m.id);
		expect(ids).toContain("echo.pens.local");
		expect(ids).toContain("wtf.pens.local");
		expect(ids).toContain("router.pens.local");
	});

	test("echo route completes locally (zero transport)", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/v1/completions`, {
			method: "POST",
			body: JSON.stringify({ model: "echo.pens.local", prompt: "ping" }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.choices[0].text).toContain("ping");
		expect(body.finish_reason).toBe("stop");
		expect(body.local_path).toBe(`${process.env.HOME}/pens`);
	});

	test("wtf route fails audit path on 'fail'", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/v1/completions`, {
			method: "POST",
			body: JSON.stringify({ model: "wtf.pens.local", prompt: "fail this" }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.finish_reason).toBe("error");
		expect(body.choices[0].text).toContain("LOCAL FAIL AUDIT");
	});



	test("router route proxies to stub upstream", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/v1/completions`, {
			method: "POST",
			body: JSON.stringify({ model: "router.pens.local", prompt: "hello mesh" }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.finish_reason).toBe("stop");
		expect(body.choices[0].text).toContain("stub:/v1/completions");
		expect(stubCalls.some((c) => c.path === "/v1/chat/completions")).toBe(true);
	});

	test("chat/completions alias works", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
			method: "POST",
			body: JSON.stringify({ model: "echo.pens.local", messages: [{ role: "user", content: "hi" }] }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.choices[0].text).toContain("hi");
	});

	test("mcp initialize/tools/list", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
			method: "POST",
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } }),
		});
		expect(res.status).toBe(200);
		const init = await res.json();
		expect(init.jsonrpc).toBe("2.0");
		expect(init.id).toBe(1);
		expect(init.result.serverInfo.name).toBe("pens-completions");

		const list = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
			method: "POST",
			body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
		});
		const listBody = await list.json();
		expect(listBody.result.tools.some((t: any) => t.name === "pens_complete")).toBe(true);
		expect(listBody.result.tools.some((t: any) => t.name === "pens_models")).toBe(true);
		expect(listBody.result.tools.some((t: any) => t.name === "pens_health")).toBe(true);
	});

	test("mcp tools/call pens_complete via stub", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
			method: "POST",
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "pens_complete", arguments: { model: "echo.pens.local", prompt: "mcp echo" } },
			}),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.result.content[0].text).toContain("mcp echo");
		expect(stubCalls.some((c) => c.path === "/v1/chat/completions")).toBe(true);
	});
});

function rawBody(input: string): any {
	try {
		return JSON.parse(input || "{}");
	} catch {
		return input;
	}
}

function prompt(path: string): string {
	if (path === "/v1/chat/completions") return "gateway prompt";
	return path;
}
