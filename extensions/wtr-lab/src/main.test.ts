/** biome-ignore-all lint/style/noNonNullAssertion: These are tests so if they fail it is fine */
/** biome-ignore-all lint/suspicious/noEmptyBlockStatements: These are tests */
/// <reference types="@types/bun" />
import { beforeAll, describe, expect, it } from "bun:test";
import {
	assertValidEntries,
	assertValidEntry,
	assertValidSource,
	getTestExtension,
	MockManagerClient,
} from "@dion-js/extension-test-utils";
import type { Extension } from "@dion-js/runtime";
import type {
	Account,
	AuthCreds,
	Entry,
	EntryDetailedResult,
	Setting,
} from "@dion-js/runtime-types/runtime";

const DOMAIN = "wtr-lab.com";
const SESSION_COOKIE = process.env.WTRLAB_SESSION ?? "";

let extension: Extension;
let client: MockManagerClient;

let browseResult: Entry[];
let detailResult: EntryDetailedResult;

/** Build the Account+Creds used to inject the captured session cookie into the runtime. */
function authAccount(): Account {
	const creds: AuthCreds = {
		type: "Cookies",
		cookies: {
			"__Secure-better-auth.session_token": [SESSION_COOKIE],
		},
	};
	return {
		domain: DOMAIN,
		auth: {
			type: "Cookie",
			loginpage: "https://wtr-lab.com/en/auth/login?callbackUrl=%2Fen",
			logonpage: "https://wtr-lab.com/en",
		},
		creds,
	};
}

beforeAll(async () => {
	client = new MockManagerClient("./.dist");
	extension = await getTestExtension(client.client);

	// Inject the test session cookie so chapter 11+ (which require login) can be read.
	if (SESSION_COOKIE) {
		await extension.mergeAuth(authAccount());
	}

	browseResult = [];
});

describe("Extension", () => {
	it("should start", async () => {
		await extension.setEnabled(true);
		const data = await extension.getData();
		expect(data.compatible).toBe(true);
		expect(extension.enabled).toBe(true);
	});

	it("should be able to browse", async () => {
		if (!extension.enabled) throw new Error("Extension not enabled");
		const result = await extension.browse(0, {});
		expect(result).toBeDefined();
		expect(result.entries.content.length).toBeGreaterThan(0);
		await assertValidEntries(result.entries.content);
		browseResult = result.entries.content;
	});

	it("should be able to search", async () => {
		if (!extension.enabled) throw new Error("Extension not enabled");
		const result = await extension.search(0, "spiritual root", {});
		expect(result).toBeDefined();
		expect(result.entries.content.length).toBeGreaterThan(0);
		// Search must actually match the query, not return the default browse feed.
		const blob = JSON.stringify(result.entries.content).toLowerCase();
		expect(blob).toContain("spiritual");
		await assertValidEntries(result.entries.content);
	});

	it("should be able to detail", async () => {
		if (!extension.enabled) throw new Error("Extension not enabled");
		if (!browseResult?.length) throw new Error("No browse result");
		const result = await extension.detail(browseResult[0]!.id, {});
		expect(result).toBeDefined();
		expect(result.entry).toBeDefined();
		expect(result.entry.episodes.length).toBeGreaterThan(0);
		expect(result.entry.description.length).toBeGreaterThan(0);
		expect(result.entry.titles[0]).toBeTruthy();
		detailResult = result;
	});

	it("should be able to refresh", async () => {
		if (!extension.enabled) throw new Error("Extension not enabled");
		if (!detailResult?.entry) throw new Error("No detail result");
		const result = await extension.refresh(
			detailResult.entry,
			(detailResult.settings ?? {}) as Record<string, Setting>,
		);
		expect(result).toBeDefined();
		expect(result.entry).toBeDefined();
		expect(result.entry.episodes.length).toBeGreaterThan(0);
		expect(result.entry.titles[0]).toBeTruthy();
		// Refresh must keep episode ids stable so saved reading progress survives.
		expect(result.entry.episodes.map((e) => e.id.uid)).toEqual(
			detailResult.entry.episodes.map((e) => e.id.uid),
		);
		await assertValidEntry(result.entry);
	});

	it("should return a source for a free chapter (no login needed)", async () => {
		if (!extension.enabled) throw new Error("Extension not enabled");
		if (!detailResult?.entry.episodes.length)
			throw new Error("No detail result");
		// Chapter 1 is always free.
		const result = await extension.source(
			detailResult.entry.episodes[0]!.id,
			(detailResult.settings ?? {}) as Record<string, Setting>,
		);
		await assertValidSource(result.source);
		expect(result.source.type).toBe("Paragraphlist");
	});

	it("should read a chapter past the free limit when logged in", async () => {
		if (!extension.enabled) throw new Error("Extension not enabled");
		if (!SESSION_COOKIE) {
			// Skip when no test cookie is configured.
			return;
		}
		if (!detailResult?.entry.episodes.length)
			throw new Error("No detail result");
		// Pick a chapter well beyond the 10-chapter free preview.
		const episodes = detailResult.entry.episodes;
		const target = episodes[Math.min(20, episodes.length - 1)];
		if (!target) throw new Error("No target chapter");

		const result = await extension.source(
			target.id,
			(detailResult.settings ?? {}) as Record<string, Setting>,
		);
		expect(result.source.type).toBe("Paragraphlist");
		// The login-gated chapter must contain real translated text, not the
		// "requires login" notice.
		const text = JSON.stringify(result.source);
		expect(text).not.toContain("requires you to be logged in");
		expect(text.length).toBeGreaterThan(50);
	});
});
