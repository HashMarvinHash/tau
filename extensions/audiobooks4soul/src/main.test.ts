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
	Entry,
	EntryDetailedResult,
	Setting,
} from "@dion-js/runtime-types/runtime";
import { join } from "node:path";

let extension: Extension;
let client: MockManagerClient;

let browseResult: Entry[];
let detailResult: EntryDetailedResult;

beforeAll(async () => {
	client = new MockManagerClient(join(import.meta.path, "../../.dist"));
	extension = await getTestExtension(client.client);
	browseResult = [];
});

describe("Extension", () => {
	it("should start", async () => {
		await extension!.setEnabled(true);
		const data = await extension!.getData();
		expect(data.compatible).toBe(true);
		expect(extension.enabled).toBe(true);
	});
	it(
		"should be able to browse",
		async () => {
			if (extension.enabled === false) throw new Error("Extension not enabled");
			const result = await extension!.browse(0, {});
			expect(result).toBeDefined();
			expect(result.entries.content.length).toBeGreaterThan(0);
			await assertValidEntries(result.entries.content);
			browseResult = result.entries.content;
		},
		{ timeout: 60_000 },
	);
	it(
		"should be able to browse the next page",
		async () => {
			if (extension.enabled === false) throw new Error("Extension not enabled");
			const page1 = await extension!.browse(0, {});
			expect(page1.entries.hasnext).toBe(true);
			const result = await extension!.browse(1, page1.settings);
			expect(result).toBeDefined();
			expect(result.entries.content.length).toBeGreaterThan(0);
			// Page 2 must not repeat page 1.
			const seen = new Set(page1.entries.content.map((e) => e.id.uid));
			expect(seen.has(result.entries.content[0]!.id.uid)).toBe(false);
		},
		{ timeout: 60_000 },
	);
	it(
		"should be able to search",
		async () => {
			if (extension.enabled === false) throw new Error("Extension not enabled");
			const result = await extension!.search(0, "dragon", {});
			expect(result).toBeDefined();
			expect(result.entries.content.length).toBeGreaterThan(0);
			await assertValidEntries(result.entries.content);
		},
		{ timeout: 60_000 },
	);
	it(
		"should be able to detail",
		async () => {
			if (extension.enabled === false) throw new Error("Extension not enabled");
			if (browseResult === undefined || (browseResult?.length ?? 0) <= 0)
				throw new Error("No browse result");
			const result = await extension!.detail(browseResult[0]!.id, {});
			expect(result).toBeDefined();
			detailResult = result;
			await assertValidEntry(result.entry);
			expect(result.entry.titles[0]).toBeTruthy();
			expect(result.entry.episodes.length).toBeGreaterThan(0);
		},
		{ timeout: 60_000 },
	);
	it(
		"should be able to source",
		async () => {
			if (extension.enabled === false) throw new Error("Extension not enabled");
			if (
				detailResult === undefined ||
				detailResult?.entry.episodes.length <= 0
			)
				throw new Error("No detail result");
			const result = await extension!.source(
				detailResult!.entry.episodes[0]!.id,
				(detailResult?.settings ?? {}) as { [key: string]: Setting },
			);
			await assertValidSource(result.source);
			expect(result).toBeDefined();
			if (result.source.type === "Audio") {
				expect(result.source.sources.length).toBeGreaterThan(0);
				expect(result.source.sources[0]!.url.url).toMatch(/^https?:/);
			} else {
				throw new Error("Expected an Audio source");
			}
		},
		{ timeout: 60_000 },
	);
});
