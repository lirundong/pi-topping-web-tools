import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import fetchMarkdownExtension from "../src/fetch-markdown.ts";
import pdfExtractExtension from "../src/pdf-extract.ts";
import {
	_resetExposureNoticeForTests,
	attachExposureLoader,
	exposureLoaderToActivate,
	exposurePrerequisiteNotice,
	loadToolExposureMode,
	parseToolExposureMode,
	settingsPath,
	WEB_TOOLS_NAMESPACE,
	webToolPresentation,
} from "../src/tool-exposure.ts";
import webBrowserExtension from "../src/web-browser/index.ts";

function settingsFile(body: string): string {
	const dir = join(tmpdir(), `pi-web-tools-exposure-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "settings.json");
	writeFileSync(path, body);
	return path;
}

function withSettings(body: string, run: () => void): void {
	_resetExposureNoticeForTests();
	const previous = process.env.PI_WEB_TOOLS_SETTINGS_FILE;
	process.env.PI_WEB_TOOLS_SETTINGS_FILE = settingsFile(body);
	try {
		run();
	} finally {
		_resetExposureNoticeForTests();
		if (previous === undefined) delete process.env.PI_WEB_TOOLS_SETTINGS_FILE;
		else process.env.PI_WEB_TOOLS_SETTINGS_FILE = previous;
	}
}

/** A fake session whose setActiveTools(), like Pi's, ignores names that are not registered. */
function fakeSession(registered: string[], active: string[]) {
	const handlers: Array<(event: unknown, ctx: unknown) => void> = [];
	const notices: string[] = [];
	const setCalls: string[][] = [];
	let current = [...active];
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: unknown) => void) => {
			if (name === "session_start") handlers.push(handler);
		},
		registerCommand: () => {},
		registerTool: () => {},
		getActiveTools: () => [...current],
		getAllTools: () => registered.map((name) => ({ name })),
		setActiveTools: (names: string[]) => {
			setCalls.push(names);
			current = names.filter((name) => registered.includes(name));
		},
	} as unknown as ExtensionAPI;
	const start = () => {
		const ctx = { hasUI: true, ui: { notify: (message: string) => notices.push(message) } };
		for (const handler of handlers) handler({ type: "session_start", reason: "startup" }, ctx);
	};
	return { pi, start, notices, setCalls, activeTools: () => current };
}

function registeredTool(factory: ExtensionFactory): ToolDefinition {
	let tool: ToolDefinition | undefined;
	const fakePi = {
		on: () => {},
		registerCommand: () => {},
		registerTool: (candidate: ToolDefinition) => {
			tool = candidate;
		},
	} as unknown as ExtensionAPI;
	factory(fakePi);
	if (!tool) throw new Error("tool was not registered");
	return tool;
}

test("parseToolExposureMode accepts the three modes and falls back to direct", () => {
	assert.equal(parseToolExposureMode("direct"), "direct");
	assert.equal(parseToolExposureMode("codemode"), "codemode");
	assert.equal(parseToolExposureMode("deferred"), "deferred");
	assert.equal(parseToolExposureMode("hidden"), "direct");
	assert.equal(parseToolExposureMode(undefined), "direct");
	assert.equal(parseToolExposureMode({}), "direct");
});

test("loadToolExposureMode reads toolExposure and ignores a missing or invalid file", () => {
	assert.equal(loadToolExposureMode(settingsFile('{"toolExposure":"deferred"}')), "deferred");
	assert.equal(loadToolExposureMode(settingsFile('{"toolExposure":"codemode"}')), "codemode");
	assert.equal(loadToolExposureMode(settingsFile("{")), "direct");
	assert.equal(loadToolExposureMode(settingsFile("[]")), "direct");
	assert.equal(loadToolExposureMode(join(tmpdir(), "pi-web-tools-missing-settings.json")), "direct");
});

test("webToolPresentation maps each mode to Pi exposure and the shared namespace", () => {
	assert.deepEqual(webToolPresentation("direct"), {
		exposure: "direct",
		namespace: WEB_TOOLS_NAMESPACE,
	});
	assert.equal(webToolPresentation("codemode").exposure, "codemode");
	assert.equal(webToolPresentation("deferred").exposure, "deferred");
});

test("default registration keeps direct exposure and attaches the namespace", () => {
	const previous = process.env.PI_WEB_TOOLS_SETTINGS_FILE;
	process.env.PI_WEB_TOOLS_SETTINGS_FILE = settingsFile("{}");
	try {
		for (const factory of [fetchMarkdownExtension, pdfExtractExtension, webBrowserExtension]) {
			const tool = registeredTool(factory);
			assert.equal(tool.exposure, "direct");
			assert.deepEqual(tool.namespace, WEB_TOOLS_NAMESPACE);
		}
	} finally {
		if (previous === undefined) delete process.env.PI_WEB_TOOLS_SETTINGS_FILE;
		else process.env.PI_WEB_TOOLS_SETTINGS_FILE = previous;
	}
});

test("deferred settings file is applied at register time", () => {
	const previous = process.env.PI_WEB_TOOLS_SETTINGS_FILE;
	process.env.PI_WEB_TOOLS_SETTINGS_FILE = settingsFile('{"toolExposure":"deferred"}');
	try {
		assert.equal(registeredTool(fetchMarkdownExtension).exposure, "deferred");
		assert.equal(registeredTool(pdfExtractExtension).exposure, "deferred");
		assert.equal(registeredTool(webBrowserExtension).exposure, "deferred");
	} finally {
		if (previous === undefined) delete process.env.PI_WEB_TOOLS_SETTINGS_FILE;
		else process.env.PI_WEB_TOOLS_SETTINGS_FILE = previous;
	}
});

test("exposurePrerequisiteNotice matches each mode to the required loader", () => {
	assert.equal(exposurePrerequisiteNotice("direct", ["read"]), undefined);
	assert.equal(exposurePrerequisiteNotice("codemode", ["read", "codemode"]), undefined);
	assert.equal(exposurePrerequisiteNotice("deferred", ["read", "tool_search"]), undefined);
	assert.equal(exposurePrerequisiteNotice("deferred", ["read", "codemode"]), undefined);
	assert.match(exposurePrerequisiteNotice("codemode", ["read"]) ?? "", /codemode/);
	assert.match(exposurePrerequisiteNotice("deferred", ["read", "bash"]) ?? "", /tool_search/);
});

test("exposureLoaderToActivate picks the registered loader each mode needs", () => {
	const all = ["read", "codemode", "tool_search"];
	assert.equal(exposureLoaderToActivate("direct", ["read"], all), undefined);
	assert.equal(exposureLoaderToActivate("codemode", ["read"], all), "codemode");
	assert.equal(exposureLoaderToActivate("codemode", ["read", "codemode"], all), undefined);
	assert.equal(exposureLoaderToActivate("codemode", ["read", "tool_search"], all), "codemode");
	assert.equal(exposureLoaderToActivate("codemode", ["read"], ["read", "tool_search"]), undefined);
	assert.equal(exposureLoaderToActivate("deferred", ["read"], all), "tool_search");
	assert.equal(exposureLoaderToActivate("deferred", ["read"], ["read", "codemode"]), "codemode");
	assert.equal(exposureLoaderToActivate("deferred", ["read", "codemode"], all), undefined);
	assert.equal(exposureLoaderToActivate("deferred", ["read", "tool_search"], all), undefined);
	assert.equal(exposureLoaderToActivate("deferred", ["read"], ["read"]), undefined);
});

test("session_start activates codemode once for codemode exposure across entrypoints", () => {
	withSettings('{"toolExposure":"codemode"}', () => {
		const session = fakeSession(["read", "bash", "codemode", "tool_search"], ["read", "bash"]);
		fetchMarkdownExtension(session.pi);
		pdfExtractExtension(session.pi);
		session.start();
		assert.deepEqual(session.setCalls, [["read", "bash", "codemode"]]);
		assert.deepEqual(session.activeTools(), ["read", "bash", "codemode"]);
		assert.deepEqual(session.notices, []);
	});
});

test("session_start activates codemode again on the next session start", () => {
	withSettings('{"toolExposure":"codemode"}', () => {
		const session = fakeSession(["read", "codemode"], ["read"]);
		attachExposureLoader(session.pi);
		session.start();
		session.pi.setActiveTools(["read"]);
		session.start();
		assert.deepEqual(session.setCalls, [["read", "codemode"], ["read"], ["read", "codemode"]]);
		assert.deepEqual(session.activeTools(), ["read", "codemode"]);
	});
});

test("session_start activates tool_search for deferred exposure", () => {
	withSettings('{"toolExposure":"deferred"}', () => {
		const session = fakeSession(["read", "codemode", "tool_search"], ["read"]);
		attachExposureLoader(session.pi);
		session.start();
		assert.deepEqual(session.setCalls, [["read", "tool_search"]]);
		assert.deepEqual(session.notices, []);
	});
});

test("session_start notifies once when the codemode loader is not registered", () => {
	withSettings('{"toolExposure":"codemode"}', () => {
		const session = fakeSession(["read", "bash", "tool_search"], ["read", "bash"]);
		attachExposureLoader(session.pi);
		attachExposureLoader(session.pi);
		session.start();
		assert.deepEqual(session.setCalls, []);
		assert.equal(session.notices.length, 1);
		assert.match(session.notices[0] ?? "", /"codemode"/);
		assert.match(session.notices[0] ?? "", /--exclude-tools/);
	});
});

test("session_start notifies once when deferred tools lack a loader", () => {
	withSettings('{"toolExposure":"deferred"}', () => {
		const session = fakeSession(["read", "bash"], ["read", "bash"]);
		attachExposureLoader(session.pi);
		attachExposureLoader(session.pi);
		session.start();
		assert.deepEqual(session.setCalls, []);
		assert.equal(session.notices.length, 1);
		assert.match(session.notices[0] ?? "", /deferred/);
		assert.match(session.notices[0] ?? "", /tool_search/);
	});
});

test("session_start leaves tools and notices alone for default direct exposure", () => {
	withSettings('{"toolExposure":"direct"}', () => {
		const session = fakeSession(["read", "codemode", "tool_search"], ["read"]);
		attachExposureLoader(session.pi);
		session.start();
		assert.deepEqual(session.setCalls, []);
		assert.deepEqual(session.activeTools(), ["read"]);
		assert.deepEqual(session.notices, []);
	});
});

test("an empty PI_WEB_TOOLS_SETTINGS_FILE is treated as unset", () => {
	const previous = process.env.PI_WEB_TOOLS_SETTINGS_FILE;
	process.env.PI_WEB_TOOLS_SETTINGS_FILE = "";
	try {
		assert.notEqual(settingsPath(), "");
		assert.ok(settingsPath().endsWith(join("pi-topping-web-tools", "settings.json")));
	} finally {
		if (previous === undefined) delete process.env.PI_WEB_TOOLS_SETTINGS_FILE;
		else process.env.PI_WEB_TOOLS_SETTINGS_FILE = previous;
	}
});
