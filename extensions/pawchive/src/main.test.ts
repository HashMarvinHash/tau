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

let extension: Extension;
let client: MockManagerClient;

let browseResult: Entry[];
let detailResult: EntryDetailedResult;

beforeAll(async () => {
	client = new MockManagerClient("./.dist");
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

	it("should be able to browse", async () => {
		if (extension.enabled === false) throw new Error("Extension not enabled");
		const result = await extension!.browse(0, {});
		expect(result).toBeDefined();
		expect(result.entries.content.length).toBeGreaterThan(0);
		await assertValidEntries(result.entries.content);
		browseResult = result.entries.content;
	});

	it("should be able to search", async () => {
		if (extension.enabled === false) throw new Error("Extension not enabled");
		const result = await extension!.search(0, "art", {});
		expect(result).toBeDefined();
		expect(result.entries.content.length).toBeGreaterThan(0);
		await assertValidEntries(result.entries.content);
	});

	it("should be able to detail", async () => {
		if (extension.enabled === false) throw new Error("Extension not enabled");
		if (browseResult === undefined || (browseResult?.length ?? 0) <= 0)
			throw new Error("No browse result");
		const result = await extension!.detail(browseResult[0]!.id, {});
		expect(result).toBeDefined();
		expect(result.entry).toBeDefined();
		expect(result.entry.episodes.length).toBeGreaterThan(0);
		expect(result.entry.description.length).toBeGreaterThan(0);
		expect(result.entry.titles[0]).toBeTruthy();
		await assertValidEntry(result.entry);
		detailResult = result;
	});

	it("should be able to refresh", async () => {
		if (extension.enabled === false) throw new Error("Extension not enabled");
		if (detailResult === undefined) throw new Error("No detail result");
		const result = await extension!.refresh(
			detailResult.entry,
			detailResult.settings as { [key: string]: Setting },
		);
		expect(result).toBeDefined();
		expect(result.entry).toBeDefined();
		expect(result.entry.episodes.length).toBeGreaterThan(0);
		expect(result.entry.episodes.map((e) => e.id.uid)).toEqual(
			detailResult.entry.episodes.map((e) => e.id.uid),
		);
		await assertValidEntry(result.entry);
	});

	it("should skip the rebuild on refresh when nothing changed", async () => {
		if (extension.enabled === false) throw new Error("Extension not enabled");
		if (detailResult === undefined) throw new Error("No detail result");
		// meta survives the round trip only if refresh returns the cached entry as-is.
		const probe = { ...detailResult.entry, meta: { probe: "fastpath" } };
		const result = await extension!.refresh(
			probe,
			detailResult.settings as { [key: string]: Setting },
		);
		expect(result.entry.meta?.probe).toBe("fastpath");
	});

	it("should rebuild on refresh when the newest episode drifted", async () => {
		if (extension.enabled === false) throw new Error("Extension not enabled");
		if (detailResult === undefined) throw new Error("No detail result");
		const last = detailResult.entry.episodes.length - 1;
		const drifted = {
			...detailResult.entry,
			meta: { probe: "fastpath" },
			episodes: detailResult.entry.episodes.map((e, i) =>
				i === last ? { ...e, name: "DRIFT" } : e,
			),
		};
		const result = await extension!.refresh(
			drifted,
			detailResult.settings as { [key: string]: Setting },
		);
		expect(result.entry.meta?.probe).toBeFalsy();
		expect(result.entry.episodes.at(-1)?.name).not.toBe("DRIFT");
		await assertValidEntry(result.entry);
	});

	it("should be able to source", async () => {
		if (extension.enabled === false) throw new Error("Extension not enabled");
		if (detailResult === undefined || detailResult?.entry.episodes.length <= 0)
			throw new Error("No detail result");
		const result = await extension!.source(
			detailResult!.entry.episodes[0]!.id,
			(detailResult?.settings ?? {}) as { [key: string]: Setting },
		);
		expect(result).toBeDefined();
		expect(result.source.type).toBe("Paragraphlist");
		await assertValidSource(result.source);
	});
});
