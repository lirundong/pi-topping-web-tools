import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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

test("saveDownloads writes pending downloads to temp files with mode 0600", async () => {
	const fixture = await startFixtureServer();
	const browser = new BrowserManager();
	browser.setOriginChecker(() => true);
	try {
		await browser.navigate(fixture.url);
		await browser.click("#download-link");
		const result = await browser.saveDownloads({ timeoutMs: 5000 });

		assert.equal(result.saved.length, 1);
		assert.equal(result.failed.length, 0);
		const saved = result.saved[0];
		assert.equal(saved.filename, "fixture-download.txt");
		assert.equal(saved.path, join(result.directory, "fixture-download.txt"));
		assert.equal(saved.bytes, "fixture download payload\n".length);
		assert.match(saved.url, /^blob:/);

		const content = await readFile(saved.path, "utf-8");
		assert.equal(content, "fixture download payload\n");
		const mode = (await stat(saved.path)).mode & 0o777;
		assert.equal(mode, 0o600);

		// The queue was drained by saveDownloads.
		assert.equal(browser.downloadEntries().length, 0);
	} finally {
		await browser.close();
		await fixture.close();
	}
});

test("saveDownloads cancels downloads over maxBytes and deletes the partial copy", async () => {
	const fixture = await startFixtureServer();
	const browser = new BrowserManager();
	browser.setOriginChecker(() => true);
	try {
		await browser.navigate(fixture.url);
		await browser.click("#download-link");
		const result = await browser.saveDownloads({ maxBytes: 4, timeoutMs: 5000 });

		assert.equal(result.saved.length, 0);
		assert.equal(result.failed.length, 1);
		assert.match(result.failed[0].reason, /exceeds the maxBytes limit of 4 bytes/);
		assert.equal(result.failed[0].filename, "fixture-download.txt");

		const files = await readdir(result.directory);
		assert.deepEqual(files, []);
	} finally {
		await browser.close();
		await fixture.close();
	}
});

test("saveDownloads dedupes repeated filenames and saves every pending download", async () => {
	const fixture = await startFixtureServer();
	const browser = new BrowserManager();
	browser.setOriginChecker(() => true);
	try {
		await browser.navigate(fixture.url);
		await browser.click("#download-link");
		await browser.click("#download-link");
		const result = await browser.saveDownloads({ timeoutMs: 5000 });

		assert.equal(result.saved.length, 2);
		assert.equal(result.saved[0].filename, "fixture-download.txt");
		assert.equal(result.saved[1].filename, "fixture-download-2.txt");
	} finally {
		await browser.close();
		await fixture.close();
	}
});

test("saveDownloads rejects when no download appears within the timeout", async () => {
	const fixture = await startFixtureServer();
	const browser = new BrowserManager();
	browser.setOriginChecker(() => true);
	try {
		await browser.navigate(fixture.url);
		await assert.rejects(
			browser.saveDownloads({ timeoutMs: 250 }),
			/No download appeared within 250 ms/,
		);
	} finally {
		await browser.close();
		await fixture.close();
	}
});

test("saveDownloads sanitizes a crafted Content-Disposition filename from an http download", async () => {
	// A fixture server that serves a download link to an attachment with a
	// traversal-style Content-Disposition filename. Blob downloads carry the
	// <a download> name; http downloads carry the server-provided one, so both
	// sanitization paths are covered by the two tests.
	const server: Server = createServer((req, res) => {
		if (req.url === "/file") {
			res.writeHead(200, {
				"Content-Type": "application/octet-stream",
				"Content-Disposition": 'attachment; filename="../../../crafted-name.txt"',
			});
			res.end("http payload");
			return;
		}
		res.writeHead(200, { "Content-Type": "text/html" });
		res.end('<html><body><a id="dl" href="/file" download>download</a></body></html>');
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const addr = server.address();
	if (!addr || typeof addr === "string") {
		throw new Error("Failed to bind server");
	}
	const port = addr.port;
	const browser = new BrowserManager();
	browser.setOriginChecker(() => true);
	try {
		await browser.navigate(`http://127.0.0.1:${port}/`);
		await browser.click("#dl");
		const result = await browser.saveDownloads({ timeoutMs: 5000 });

		assert.equal(result.saved.length, 1);
		const saved = result.saved[0];
		assert.notEqual(saved.filename, "..");
		assert.notEqual(saved.filename, ".");
		assert.ok(dirname(saved.path) === result.directory, "no path traversal");
		assert.equal(await readFile(saved.path, "utf-8"), "http payload");
	} finally {
		await browser.close();
		server.close();
	}
});
