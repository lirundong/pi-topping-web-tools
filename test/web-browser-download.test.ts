import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	BrowserManager,
	closeBrowserManager,
	sanitizeDownloadFilename,
} from "../src/web-browser/browser-manager.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, "fixtures", "browser-fixture.html");

async function startFixtureServer(): Promise<{ url: string; close: () => Promise<void> }> {
	const html = await readFile(fixturePath, "utf-8");
	const server: Server = createServer((req, res) => {
		res.writeHead(200, { "Content-Type": "text/html" });
		res.end(html);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const addr = server.address();
	if (!addr || typeof addr === "string") {
		throw new Error("Failed to bind fixture server");
	}
	return {
		url: `http://127.0.0.1:${addr.port}/`,
		close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
	};
}

test("download events are captured with sanitized filenames", async () => {
	const fixture = await startFixtureServer();
	const browser = new BrowserManager();
	browser.setOriginChecker(() => true);
	try {
		await browser.navigate(fixture.url);
		await browser.click("#download-link");
		await browser.waitForDownload(5000);

		const entries = browser.downloadEntries();
		assert.equal(entries.length, 1);
		assert.equal(entries[0].filename, "fixture-download.txt");
		assert.match(entries[0].url, /^blob:/);
		assert.match(entries[0].pageUrl, /127\.0\.0\.1/);

		const info = await browser.getPageInfoAsync();
		assert.equal(info.downloadCount, 1);
	} finally {
		await browser.close();
		await fixture.close();
	}
});

test("waitForDownload rejects after the timeout when no download starts", async () => {
	const fixture = await startFixtureServer();
	const browser = new BrowserManager();
	browser.setOriginChecker(() => true);
	try {
		await browser.navigate(fixture.url);
		await assert.rejects(browser.waitForDownload(250), /No download appeared within 250 ms/);
		assert.equal(browser.downloadEntries().length, 0);
	} finally {
		await browser.close();
		await fixture.close();
	}
});

test("waitForDownload resolves for already-pending downloads without waiting", async () => {
	const fixture = await startFixtureServer();
	const browser = new BrowserManager();
	browser.setOriginChecker(() => true);
	try {
		await browser.navigate(fixture.url);
		await browser.click("#download-link");
		await browser.waitForDownload(5000);
		// The download is still pending in the buffer; a second wait must
		// resolve immediately rather than time out.
		await browser.waitForDownload(50);
		assert.equal(browser.downloadEntries().length, 1);
	} finally {
		await browser.close();
		await fixture.close();
	}
});

test("sanitizeDownloadFilename strips path components and falls back for empty names", () => {
	assert.equal(sanitizeDownloadFilename("../../evil.txt"), "evil.txt");
	assert.equal(sanitizeDownloadFilename("..\\..\\evil.txt"), "evil.txt");
	assert.equal(sanitizeDownloadFilename("plain.bin"), "plain.bin");
	assert.match(sanitizeDownloadFilename(""), /^download-\d+$/);
	assert.match(sanitizeDownloadFilename("../"), /^download-\d+$/);
	assert.match(sanitizeDownloadFilename("..."), /^download-\d+$/);
});

test("captured downloads are cleared when the manager closes", async () => {
	const fixture = await startFixtureServer();
	const browser = new BrowserManager();
	browser.setOriginChecker(() => true);
	await browser.navigate(fixture.url);
	await browser.click("#download-link");
	await browser.waitForDownload(5000);
	assert.equal(browser.downloadEntries().length, 1);
	await browser.close();
	await fixture.close();
	await closeBrowserManager();
	assert.equal(browser.downloadEntries().length, 0);
});
