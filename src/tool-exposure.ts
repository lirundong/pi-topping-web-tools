/**
 * Shared ToolExposure + namespace for fetch_markdown, pdf_extract, and web_browser.
 * Default remains Pi's direct registration. Other modes are opt-in via settings.json.
 */

import type { ExtensionAPI, ToolDefinition, ToolExposure, ToolNamespace } from "@earendil-works/pi-coding-agent";
import { createSettingsStore, sanitize, toppingSettingsPath } from "@underactive/pi-topping-primitives/settings";

export type WebToolsExposureMode = "direct" | "codemode" | "deferred";

export const WEB_TOOLS_NAMESPACE: ToolNamespace = {
	name: "pi-topping-web-tools",
	description: "Keyless fetch_markdown, pdf_extract, and headless web_browser.",
	instructions: [
		"Use fetch_markdown for public HTML documentation, READMEs, and articles when you want turndown markdown and a 15-minute cache.",
		"Use pdf_extract for a remote or local PDF. fetch_markdown and web_fetch cannot read PDF text.",
		"Use web_browser for JavaScript-rendered pages, local servers, screenshots, and interaction.",
		"Host allowlist and permission prompts still apply. Exposure only changes how the model sees the tools, not what they may execute.",
		"See the package README sections for fetch_markdown, pdf_extract, and web_browser.",
	].join("\n"),
};

const MAX_SETTINGS_BYTES = 64 * 1024;

const defaultSettingsPath = toppingSettingsPath("pi-topping-web-tools");
const SETTINGS_PATH_ENV = "PI_WEB_TOOLS_SETTINGS_FILE";

/** `PI_WEB_TOOLS_SETTINGS_FILE` wins when non-empty; otherwise the agent-dir default. */
export function settingsPath(): string {
	const override = process.env[SETTINGS_PATH_ENV];
	return override ? override : defaultSettingsPath();
}

export function parseToolExposureMode(value: unknown): WebToolsExposureMode {
	if (value === "codemode" || value === "deferred" || value === "direct") {
		return value;
	}
	return "direct";
}

function exposureStore(path?: string) {
	return createSettingsStore<WebToolsExposureMode>({
		path: path === undefined ? defaultSettingsPath : () => path,
		...(path === undefined ? { pathEnv: SETTINGS_PATH_ENV } : {}),
		maxBytes: MAX_SETTINGS_BYTES,
		codec: {
			sanitize: (raw) => (sanitize.isRecord(raw) ? parseToolExposureMode(raw.toolExposure) : "direct"),
		},
	});
}

/** A missing, oversized, corrupt or unrecognised file means Pi's direct registration. */
export function loadToolExposureMode(path?: string): WebToolsExposureMode {
	return exposureStore(path).read();
}

export function webToolPresentation(mode: WebToolsExposureMode = loadToolExposureMode()): {
	exposure: ToolExposure;
	namespace: ToolNamespace;
} {
	return {
		exposure: mode,
		namespace: WEB_TOOLS_NAMESPACE,
	};
}

export function registerWebTool(pi: ExtensionAPI, tool: ToolDefinition): void {
	pi.registerTool({ ...tool, ...webToolPresentation() });
}

let didNotifyPrerequisites = false;

export function _resetExposureNoticeForTests(): void {
	didNotifyPrerequisites = false;
}

/** Loader tools that reach tools with this exposure, in the order to activate them. */
function exposureLoaders(mode: WebToolsExposureMode): readonly string[] {
	if (mode === "codemode") return ["codemode"];
	if (mode === "deferred") return ["tool_search", "codemode"];
	return [];
}

/**
 * The registered loader tool to activate so the model can reach the web tools, or undefined when a
 * loader is already active or none is registered. `--tools` and `--exclude-tools` unregister tools,
 * so an excluded loader is never activated.
 */
export function exposureLoaderToActivate(
	mode: WebToolsExposureMode,
	activeTools: readonly string[],
	registeredTools: readonly string[],
): string | undefined {
	const loaders = exposureLoaders(mode);
	if (loaders.some((name) => activeTools.includes(name))) return undefined;
	return loaders.find((name) => registeredTools.includes(name));
}

export function exposurePrerequisiteNotice(
	mode: WebToolsExposureMode,
	activeTools: readonly string[],
): string | undefined {
	if (mode === "direct") return undefined;
	if (exposureLoaders(mode).some((name) => activeTools.includes(name))) return undefined;
	if (mode === "codemode") {
		return 'pi-topping-web-tools toolExposure is "codemode", but the codemode tool is not available, so the model cannot reach the tools. Check --tools and --exclude-tools, or set toolExposure to "direct".';
	}
	return 'pi-topping-web-tools toolExposure is "deferred", but neither tool_search nor codemode is available, so the model cannot reach the tools. Check --tools and --exclude-tools, or set toolExposure to "direct".';
}

/**
 * On every session start, activate the loader tool the configured exposure needs, as Pi's MCP support
 * does for MCP servers. Notify once when no loader can be activated.
 */
export function attachExposureLoader(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		const mode = loadToolExposureMode();
		if (mode === "direct") return;
		if (typeof pi.getActiveTools !== "function") return;
		const active = pi.getActiveTools();
		const loader = exposureLoaderToActivate(mode, active, pi.getAllTools().map((tool) => tool.name));
		if (loader) pi.setActiveTools([...active, loader]);
		if (didNotifyPrerequisites) return;
		const message = exposurePrerequisiteNotice(mode, pi.getActiveTools());
		if (!message) return;
		didNotifyPrerequisites = true;
		if (ctx.hasUI) {
			ctx.ui.notify(message, "warning");
		}
	});
}
