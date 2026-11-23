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
	it("should be able to browse", async () => {
		if (extension.enabled === false) throw new Error("Extension not enabled");
		const result = await extension!.browse(0, {});
		expect(result).toBeDefined();
		expect(result.entries.content.length).toBeGreaterThan(0);
		await assertValidEntries(result.entries.content);
		browseResult = result.entries.content;
	});
	it("should paginate browse", async () => {
		if (extension.enabled === false) throw new Error("Extension not enabled");
		const result = await extension!.browse(1, {});
		expect(result.entries.content.length).toBeGreaterThan(0);
		const seen = new Set(browseResult.map((e) => e.id.uid));
		for (const entry of result.entries.content) {
			expect(seen.has(entry.id.uid)).toBe(false);
		}
	});
	it("should be able to search", async () => {
		if (extension.enabled === false) throw new Error("Extension not enabled");
		const result = await extension!.search(0, "regression", {});
		await assertValidEntries(result.entries.content);
		expect(result.entries.content.length).toBeGreaterThan(0);
		// Search must actually match the query, not return the browse feed.
		const blob = JSON.stringify(result.entries.content).toLowerCase();
		expect(blob).toContain("regression");
	});
	it("should be able to detail", async () => {
		if (extension.enabled === false) throw new Error("Extension not enabled");
		if (browseResult === undefined || (browseResult?.length ?? 0) <= 0)
			throw new Error("No browse result");
		const result = await extension!.detail(browseResult[0]!.id, {});
		expect(result).toBeDefined();
		expect(result.entry.episodes.length).toBeGreaterThan(0);
		expect(result.entry.description.length).toBeGreaterThan(0);
		expect(result.entry.titles[0]).toBeTruthy();
		detailResult = result;
		await assertValidEntry(result.entry);
	});
	it("should expose only non-premium chapters", async () => {
		if (extension.enabled === false) throw new Error("Extension not enabled");
		// "Regression is Too Much" sells some chapters. Compare against the
		// site's live paid list so the test survives chapters being freed.
		const paid = (await (
			await fetch(
				"https://api.wetriedtls.com/chapters/regression-is-too-much/paid?query=&order=desc",
			)
		).json()) as { meta: { total: number }; data: [{ chapter_slug: string }] };
		expect(paid.meta.total).toBeGreaterThan(0);

		const result = await extension!.detail(
			{ uid: "regression-is-too-much" },
			{},
		);
		const episodes = result.entry.episodes;
		expect(episodes.length).toBeGreaterThan(0);
		// Free chapters + paid chapters must add up to the site's chapter count.
		const series = (await (
			await fetch("https://api.wetriedtls.com/series/regression-is-too-much")
		).json()) as { meta: { chapters_count: string } };
		expect(episodes.length + paid.meta.total).toBe(
			Number(series.meta.chapters_count),
		);
		const uids = new Set(episodes.map((e) => e.id.uid));
		for (const ch of paid.data) {
			expect(uids.has(`regression-is-too-much:${ch.chapter_slug}`)).toBe(false);
		}
	});
	it("should keep episode ids stable on refresh", async () => {
		if (extension.enabled === false) throw new Error("Extension not enabled");
		if (detailResult === undefined) throw new Error("No detail result");
		const result = await extension!.refresh(
			detailResult.entry,
			(detailResult.settings ?? {}) as Record<string, Setting>,
		);
		expect(result.entry.titles[0]).toBeTruthy();
		expect(result.entry.episodes.map((e) => e.id.uid)).toEqual(
			detailResult.entry.episodes.map((e) => e.id.uid),
		);
	});
	it("should be able to source", async () => {
		if (extension.enabled === false) throw new Error("Extension not enabled");
		if (detailResult === undefined || detailResult?.entry.episodes.length <= 0)
			throw new Error("No detail result");
		const result = await extension!.source(
			detailResult!.entry.episodes[0]!.id,
			(detailResult?.settings ?? {}) as { [key: string]: Setting },
		);
		await assertValidSource(result.source);
		expect(result.source.type).toBe("Paragraphlist");
		const paragraphs =
			result.source.type === "Paragraphlist" ? result.source.paragraphs : [];
		expect(paragraphs.length).toBeGreaterThan(3);
		const text = paragraphs
			.map((p) => (p.type === "Text" ? p.content : ""))
			.join(" ");
		// Real chapter text, not the premium/error notice.
		expect(text.toLowerCase()).not.toContain("premium");
		expect(text.length).toBeGreaterThan(200);
	});
	it("should source the newest free chapter of a premium series", async () => {
		if (extension.enabled === false) throw new Error("Extension not enabled");
		const result = await extension!.detail(
			{ uid: "regression-is-too-much" },
			{},
		);
		const newest = result.entry.episodes.at(-1)!;
		const source = await extension!.source(
			newest.id,
			(result.settings ?? {}) as Record<string, Setting>,
		);
		await assertValidSource(source.source);
		const text = JSON.stringify(source.source).toLowerCase();
		expect(text).not.toContain("cannot be read");
		expect(text.length).toBeGreaterThan(500);
	});
	it("should inline images embedded in chapter content", async () => {
		if (extension.enabled === false) throw new Error("Extension not enabled");
		// The site removed the dedicated "illustrations" chapters; images now
		// appear inline inside regular chapters. This one embeds a single
		// illustration between its paragraphs.
		const result = await extension!.detail(
			{ uid: "i-became-the-second-in-command-in-a-romance-fantasy-novel" },
			{},
		);
		const episode = result.entry.episodes.find(
			(e) =>
				e.id.uid ===
				"i-became-the-second-in-command-in-a-romance-fantasy-novel:chapter-108",
		);
		expect(episode).toBeDefined();
		const source = await extension!.source(
			episode!.id,
			(result.settings ?? {}) as Record<string, Setting>,
		);
		await assertValidSource(source.source);
		expect(source.source.type).toBe("Paragraphlist");
		const paragraphs =
			source.source.type === "Paragraphlist" ? source.source.paragraphs : [];
		const images = paragraphs.filter(
			(p) => p.type === "CustomUI" && p.ui.type === "Image",
		);
		expect(images.length).toBeGreaterThanOrEqual(1);
		// The chapter's text must survive alongside the image.
		expect(paragraphs.some((p) => p.type === "Text")).toBe(true);
	});
});
