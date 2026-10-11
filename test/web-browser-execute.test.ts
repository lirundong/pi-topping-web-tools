import assert from "node:assert/strict";
import { rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import webBrowserExtension from "../src/web-browser/index.ts";
import { closeBrowserManager, getBrowserManager } from "../src/web-browser/browser-manager.ts";

type WebBrowserTool = {
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: () => void,
		ctx: ExtensionContext,
	) => Promise<{
		content: Array<{ type: string; text: string }>;
		details?: { action?: string; error?: string; fullOutputPath?: string };
		isError?: boolean;
	}>;
};

function registerTool(): WebBrowserTool {
	let tool: WebBrowserTool | undefined;
	const fakePi = {
		registerTool: (candidate: unknown) => {
			tool = candidate as WebBrowserTool;
		},
		on: () => {},
		registerCommand: () => {},
	} as unknown as ExtensionAPI;
	webBrowserExtension(fakePi);
	if (!tool) throw new Error("web_browser tool was not registered");
	return tool;
}

function mockCtx(): ExtensionContext {
	return {
		hasUI: false,
		ui: {
			select: async () => "Deny",
		},
	} as unknown as ExtensionContext;
}

const tool = registerTool();

test("execute validates missing parameters per action", async () => {
	const navigate = await tool.execute("1", { action: "navigate" }, undefined, () => {}, mockCtx());
	assert.equal(navigate.isError, true);
	assert.equal(navigate.content[0]?.text, "url is required for navigate.");
	assert.equal(navigate.details?.error, "missing url");

	const click = await tool.execute("1", { action: "click" }, undefined, () => {}, mockCtx());
	assert.equal(click.isError, true);
	assert.equal(click.content[0]?.text, "selector is required for click.");
	assert.equal(click.details?.error, "missing selector");

	const type = await tool.execute("1", { action: "type" }, undefined, () => {}, mockCtx());
	assert.equal(type.isError, true);
	assert.equal(type.content[0]?.text, "selector and text are required for type.");
	assert.equal(type.details?.error, "missing selector or text");
});

test("execute falls through to an isError result for unknown actions", async () => {
	const result = await tool.execute("1", { action: "frobnicate" }, undefined, () => {}, mockCtx());
	assert.equal(result.isError, true);
	assert.equal(result.content[0]?.text, "Unknown action: frobnicate");
	assert.equal(result.details?.error, "unknown action");
});

test("execute reports Operation aborted for abort errors", async () => {
	const controller = new AbortController();
	controller.abort();
	try {
		const result = await tool.execute(
			"1",
			{ action: "navigate", url: "https://example.com/aborted" },
			controller.signal,
			() => {},
			mockCtx(),
		);
		assert.equal(result.isError, true);
		assert.equal(result.content[0]?.text, "Operation aborted.");
		assert.equal(result.details?.error, "aborted");
	} finally {
		await closeBrowserManager();
	}
});

test("set_cookies to a non-preapproved domain is blocked before reaching the browser", async () => {
	const result = await tool.execute(
		"1",
		{ action: "set_cookies", cookies: [{ name: "a", value: "b", domain: "evil.example" }] },
		undefined,
		() => {},
		mockCtx(),
	);
	assert.equal(result.isError, true);
	assert.match(result.content[0]?.text ?? "", /blocked \(no UI for confirmation\)/);
	assert.equal(getBrowserManager().isOpen, false);
});

test("set_cookies for a preapproved domain passes", async () => {
	try {
		const result = await tool.execute(
			"1",
			{ action: "set_cookies", cookies: [{ name: "a", value: "b", domain: "react.dev", path: "/" }] },
			undefined,
			() => {},
			mockCtx(),
		);
		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /Set 1 cookie\(s\)\./);
	} finally {
		await closeBrowserManager();
	}
});

test("toFile screenshots are written with mode 0600", async () => {
	const manager = getBrowserManager();
	manager.screenshot = async () => ({ data: "iVBORw0KGgo=", width: 1, height: 1, fullPage: false });
	manager.getPageInfoAsync = async () => ({
		url: "about:blank",
		title: "",
		isOpen: true,
		consoleCount: 0,
		networkCount: 0,
		dialogCount: 0,
		tabCount: 1,
	});
	const ctx = {
		hasUI: true,
		ui: {
			setStatus: () => {},
			theme: { fg: (_tone: string, text: string) => text },
		},
	} as unknown as ExtensionContext;
	let tempFile: string | undefined;

	try {
		const result = await tool.execute("1", { action: "screenshot", toFile: true }, undefined, () => {}, ctx);
		tempFile = result.details?.fullOutputPath;
		assert.ok(tempFile);
		assert.equal((await stat(tempFile)).mode & 0o777, 0o600);
	} finally {
		await closeBrowserManager();
		if (tempFile) await rm(dirname(tempFile), { recursive: true, force: true });
	}
});

test("truncated text output is written with mode 0600", async () => {
	const manager = getBrowserManager();
	manager.getText = async () => "x".repeat(100_000);
	manager.getPageInfoAsync = async () => ({
		url: "about:blank",
		title: "",
		isOpen: true,
		consoleCount: 0,
		networkCount: 0,
		dialogCount: 0,
		tabCount: 1,
	});
	const ctx = {
		hasUI: true,
		ui: {
			setStatus: () => {},
			theme: { fg: (_tone: string, text: string) => text },
		},
	} as unknown as ExtensionContext;
	let tempFile: string | undefined;

	try {
		const result = await tool.execute("1", { action: "get_text" }, undefined, () => {}, ctx);
		tempFile = result.details?.fullOutputPath;
		assert.ok(tempFile);
		assert.equal((await stat(tempFile)).mode & 0o777, 0o600);
	} finally {
		await closeBrowserManager();
		if (tempFile) await rm(dirname(tempFile), { recursive: true, force: true });
	}
});
