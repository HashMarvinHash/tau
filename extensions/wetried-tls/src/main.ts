// Dion extension for wetriedtls.com — translated Korean web novels.
//
// The site is a Next.js frontend over a JSON API at api.wetriedtls.com:
//   GET /query?page=N&perPage=N&query_string=Q&orderBy=..&order=..&adult=false
//       -> { meta: { last_page, ... }, data: [series...] }   (browse + search)
//   GET /series/{slug}
//       -> full metadata (tags, author, year, status, rating, description)
//   GET /chapters/{slug}?page=N&perPage=N&query=&order=asc|desc
//       -> the FREE chapters of a series, paginated. Premium chapters are not
//          in this list at all, so limiting ourselves to it keeps the
//          extension free-only by construction.
//   GET /chapter/{slug}/{chapter_slug}
//       -> { chapter: { chapter_content: "<p>...</p>...", ... } }
//
// Auth is intentionally not implemented: everything we serve is free.

import { DionExtension } from "@dion-js/runtime-lib";
import {
	Dropdown,
	type SettingStore,
	defineStoreSetting,
} from "@dion-js/runtime-lib/settings";
import { Divider, Image } from "@dion-js/runtime-lib/ui";
import { SourceProvider } from "@dion-js/runtime-types/extension";
import type {
	Entry,
	EntryDetailed,
	EntryDetailedResult,
	EntryId,
	EntryList,
	EntryListResult,
	Episode,
	EpisodeId,
	Link,
	Paragraph,
	ReleaseStatus,
	Setting,
	SourceResult,
	TextStyle,
} from "@dion-js/runtime-types/runtime";
import { fetch } from "network";
import { parseHtmlFragment } from "parse";
import type { DionElement } from "parse";

const BASE = "https://wetriedtls.com";
const API = "https://api.wetriedtls.com";
const BROWSE_PER_PAGE = 20;
// The free-chapter endpoint paginates; 200 keeps a long series (800+ chapters)
// at ~5 requests in detail.
const CHAPTERS_PER_PAGE = 200;

interface QueryMeta {
	total: number;
	current_page: number;
	last_page: number;
}

interface QuerySeries {
	id: number;
	title: string;
	description: string;
	alternative_names: string | null;
	series_type: string;
	series_slug: string;
	thumbnail: string;
	status: string;
	rating: number;
	meta?: { chapters_count?: string | number } | null;
}

interface ApiTag {
	name: string;
}

interface SeriesDetail {
	id: number;
	title: string;
	series_slug: string;
	thumbnail: string;
	description: string;
	series_type: string;
	tags: ApiTag[];
	status: string;
	alternative_names: string | null;
	author: string | null;
	release_year: number | null;
	rating: number;
}

interface ApiChapter {
	id: number;
	chapter_slug: string;
	chapter_name: string;
	chapter_title: string | null;
	price: number;
	public: boolean;
	created_at: string;
}

interface ChapterContentResponse {
	chapter?: {
		chapter_slug: string;
		chapter_name: string;
		chapter_title: string | null;
		chapter_content: string | null;
		price: number;
	} | null;
}

const ORDERS = [
	{ value: "latest", label: "Recently updated" },
	{ value: "created_at", label: "Recently added" },
	{ value: "total_views", label: "Most viewed" },
	{ value: "title", label: "Title" },
];

const STATUSES = [
	{ value: "All", label: "All" },
	{ value: "Ongoing", label: "Ongoing" },
	{ value: "Completed", label: "Completed" },
	{ value: "Hiatus", label: "Hiatus" },
	{ value: "Dropped", label: "Dropped" },
];

function link(url: string): Link {
	return { url, header: null };
}

function toStatus(raw: string | null | undefined): ReleaseStatus {
	const v = (raw ?? "").trim().toLowerCase();
	if (v.startsWith("complete")) return "Complete";
	if (v.startsWith("ongo")) return "Releasing";
	return "Unknown";
}

/** "/series/slug/chapter-1" -> ["series", "slug", "chapter-1"] */
function pathParts(url: string): string[] {
	const proto = url.indexOf("://");
	let rest = proto >= 0 ? url.slice(proto + 3) : url;
	const slash = rest.indexOf("/");
	if (slash >= 0) rest = rest.slice(slash);
	else rest = "";
	const q = rest.search("[?#]");
	if (q >= 0) rest = rest.slice(0, q);
	return rest.split("/").filter(Boolean);
}

/** Split the API's "한국어 | 汉语 | ..." alternative-names field. */
function splitAltNames(raw: string | null | undefined): string[] {
	if (!raw) return [];
	return raw
		.split("|")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/** Strip HTML down to readable text, one API "<p>" per block. */
function htmlToText(html: string): string {
	if (!html) return "";
	try {
		const frag = parseHtmlFragment(html);
		const ps = frag.select("p");
		if (ps.length > 0) {
			const lines: string[] = [];
			for (let i = 0; i < ps.length; i++) {
				const t = ps.get(i)?.text?.trim() ?? "";
				if (t) lines.push(t);
			}
			if (lines.length > 0) return lines.join("\n\n");
		}
		return frag.text?.trim() ?? "";
	} catch {
		return html
			.replace(/<[^>]+>/g, " ")
			.replace(/\s+/g, " ")
			.trim();
	}
}

/**
 * Convert a chapter's HTML body into paragraphs, preserving document order.
 * Text blocks become Text paragraphs, headings become bold text, scene-break
 * rules become Dividers, and illustrations become CustomUI Image nodes.
 */
function chapterToParagraphs(html: string): Paragraph[] {
	const paragraphs: Paragraph[] = [];
	const pushText = (t: string, style: TextStyle | null = null) => {
		const clean = t.replace(/\s+/g, " ").trim();
		if (clean) paragraphs.push({ type: "Text", content: clean, style });
	};

	let root: DionElement;
	try {
		root = parseHtmlFragment(html);
	} catch {
		return [{ type: "Text", content: html, style: null }];
	}

	// Media lives in wrapper elements (e.g. <p><div class="image"><img/></div></p>).
	// A subtree without media renders as a single text block; a subtree with
	// media is walked so images keep their position relative to the text.
	const hasMedia = (node: DionElement): boolean => {
		const name = (node.name ?? "").toLowerCase();
		if (name === "img") return true;
		if (name === "hr" || node.attr("data-type") === "horizontalRule") {
			return true;
		}
		for (let i = 0; i < node.children.length; i++) {
			const child = node.children.get(i);
			if (child && hasMedia(child)) return true;
		}
		return false;
	};

	const walk = (node: DionElement): void => {
		const name = (node.name ?? "").toLowerCase();
		if (name === "img") {
			const src = node.attr("src");
			if (/^https?:\/\//i.test(src)) {
				paragraphs.push({ type: "CustomUI", ui: Image(link(src)) });
			}
			return;
		}
		if (name === "hr" || node.attr("data-type") === "horizontalRule") {
			paragraphs.push({ type: "CustomUI", ui: Divider() });
			return;
		}
		if (/^h[1-6]$/.test(name)) {
			pushText(node.text, { bold: true });
			return;
		}
		if (hasMedia(node)) {
			for (let i = 0; i < node.children.length; i++) {
				const child = node.children.get(i);
				if (child) walk(child);
			}
			return;
		}
		pushText(node.text);
	};

	for (let i = 0; i < root.children.length; i++) {
		const node = root.children.get(i);
		if (node) walk(node);
	}
	return paragraphs;
}

function noticeSource(
	message: string,
	settings: Record<string, Setting>,
): SourceResult {
	return {
		source: {
			type: "Paragraphlist",
			paragraphs: [{ type: "Text", content: message, style: null }],
			audio: null,
		},
		settings,
	};
}

function toEntry(s: QuerySeries): Entry {
	return {
		id: { uid: s.series_slug },
		url: `${BASE}/series/${s.series_slug}`,
		title: s.title,
		media_type: "Book",
		cover: s.thumbnail ? link(s.thumbnail) : null,
		author: null,
		rating: null,
		views: null,
		length: null,
	};
}

export default class extends DionExtension implements SourceProvider {
	settings = {};
	searchSettings = {
		order: defineStoreSetting<string>("order", {
			default: "latest",
			label: "Browse order",
			ui: new Dropdown(ORDERS),
		}),
		status: defineStoreSetting<string>("status", {
			default: "All",
			label: "Status",
			ui: new Dropdown(STATUSES),
		}),
	};

	accounts = {};

	entrySettings = {};

	async onEvent(): Promise<undefined> {
		return undefined;
	}

	// --- Network helpers -----------------------------------------------------

	private async getJson<T>(path: string): Promise<T> {
		const res = await fetch(`${API}${path}`);
		if (!res.ok) {
			throw new Error(`wetried-tls: GET ${path} failed (${res.status})`);
		}
		return res.json as T;
	}

	/** Listing call shared by browse and search; page is 0-indexed. */
	private async querySeries(
		page: number,
		queryString: string,
		orderBy: string,
		store: SettingStore,
	): Promise<EntryList> {
		// "title" reads naturally ascending; the recency/view orders descending.
		const order = orderBy === "title" ? "asc" : "desc";
		let path =
			`/query?page=${page + 1}&perPage=${BROWSE_PER_PAGE}` +
			`&query_string=${encodeURIComponent(queryString)}` +
			`&orderBy=${orderBy}&order=${order}&adult=false`;
		if (queryString === "") {
			const status = this.searchSettings.status.get(store);
			if (status !== "All") path += `&status=${encodeURIComponent(status)}`;
		}
		const json = await this.getJson<{ meta: QueryMeta; data: QuerySeries[] }>(
			path,
		);
		const data = (json.data ?? []).filter(
			(s) => !s.series_type || s.series_type === "Novel",
		);
		const hasnext = !!json.meta && json.meta.current_page < json.meta.last_page;
		return { content: data.map(toEntry), hasnext, length: data.length };
	}

	// --- Browse / search -----------------------------------------------------

	async browse(
		page: number,
		settings: Record<string, Setting>,
	): Promise<EntryListResult> {
		const store = this.convertSettingStore(settings);
		const order = this.searchSettings.order.get(store);
		return {
			entries: await this.querySeries(page, "", order, store),
			settings: store.toMap(),
		};
	}

	async search(
		page: number,
		filter: string,
		settings: Record<string, Setting>,
	): Promise<EntryListResult> {
		const store = this.convertSettingStore(settings);
		return {
			entries: await this.querySeries(page, filter, "latest", store),
			settings: store.toMap(),
		};
	}

	// --- Detail --------------------------------------------------------------

	async detail(
		entryid: EntryId,
		settings: Record<string, Setting>,
	): Promise<EntryDetailedResult> {
		const slug = entryid.uid;
		const series = await this.getJson<SeriesDetail>(`/series/${slug}`);
		const chapters = await this.fetchAllFreeChapters(slug);

		const episodes = chapters.map((c) => this.chapterToEpisode(slug, c));
		const titles = [series.title, ...splitAltNames(series.alternative_names)];

		return {
			entry: {
				id: entryid,
				url: `${BASE}/series/${series.series_slug}`,
				titles,
				media_type: "Book",
				status: toStatus(series.status),
				description: htmlToText(series.description ?? ""),
				language: "en",
				author: series.author ? [series.author] : null,
				cover: series.thumbnail ? link(series.thumbnail) : null,
				genres:
					Array.isArray(series.tags) && series.tags.length > 0
						? series.tags.map((t) => t.name)
						: null,
				episodes,
				length: episodes.length,
				rating: null,
				views: null,
				poster: null,
				ui: null,
				meta: null,
			},
			settings,
		};
	}

	/**
	 * Cheap refresh: the free-chapter list is the only thing that changes
	 * meaningfully. Page 1 (newest first) tells us the free total and the
	 * newest slug; if both match the cached episodes, nothing to do.
	 */
	async refresh(
		entry: EntryDetailed,
		settings: Record<string, Setting>,
	): Promise<EntryDetailedResult> {
		const slug = entry.id.uid;
		try {
			const page = await this.getJson<{ meta: QueryMeta; data: ApiChapter[] }>(
				`/chapters/${slug}?page=1&perPage=1&query=&order=desc`,
			);
			const newest = page.data?.[0]?.chapter_slug;
			const cachedNewest = entry.episodes.at(-1)?.id.uid.split(":")[1];
			if (
				page.meta?.total === entry.episodes.length &&
				newest === cachedNewest
			) {
				return { entry, settings };
			}
		} catch {
			// Fall through to a full rebuild rather than erroring the refresh.
		}
		return this.detail(entry.id, settings);
	}

	// --- Source --------------------------------------------------------------

	async source(
		epid: EpisodeId,
		settings: Record<string, Setting>,
	): Promise<SourceResult> {
		const idx = epid.uid.indexOf(":");
		const slug = idx >= 0 ? epid.uid.slice(0, idx) : epid.uid;
		const chapterSlug = idx >= 0 ? epid.uid.slice(idx + 1) : "";

		let json: ChapterContentResponse;
		try {
			json = await this.getJson<ChapterContentResponse>(
				`/chapter/${slug}/${chapterSlug}`,
			);
		} catch {
			return noticeSource(
				"Failed to load this chapter. It may have been removed, or it is a " +
					"premium chapter (premium chapters are not available in this " +
					"extension).",
				settings,
			);
		}

		const content = json.chapter?.chapter_content;
		if (!content || content.trim().length === 0) {
			return noticeSource(
				json.chapter && json.chapter.price > 0
					? "This chapter is premium and cannot be read with this extension."
					: "No content found for this chapter.",
				settings,
			);
		}

		const paragraphs = chapterToParagraphs(content);
		return {
			source: {
				type: "Paragraphlist",
				paragraphs:
					paragraphs.length > 0
						? paragraphs
						: [{ type: "Text", content: "No content found.", style: null }],
				audio: null,
			},
			settings,
		};
	}

	async handleUrl(url: string): Promise<boolean> {
		const parts = pathParts(url);
		return parts[0] === "series" && parts.length >= 2;
	}

	// --- Data fetch helpers --------------------------------------------------

	private chapterToEpisode(slug: string, c: ApiChapter): Episode {
		const name = c.chapter_title
			? `${c.chapter_name} — ${c.chapter_title}`
			: c.chapter_name;
		return {
			id: { uid: `${slug}:${c.chapter_slug}` },
			name,
			url: `${BASE}/series/${slug}/${c.chapter_slug}`,
			description: null,
			cover: null,
			timestamp: c.created_at ?? null,
		};
	}

	/** Walk the free-chapter pagination in reading order (oldest first). */
	private async fetchAllFreeChapters(slug: string): Promise<ApiChapter[]> {
		const all: ApiChapter[] = [];
		let page = 1;
		for (;;) {
			const json = await this.getJson<{ meta: QueryMeta; data: ApiChapter[] }>(
				`/chapters/${slug}?page=${page}&perPage=${CHAPTERS_PER_PAGE}&query=&order=asc`,
			);
			const data = json.data ?? [];
			// Defensive: the endpoint only lists free chapters, but skip anything
			// priced or not yet public in case that ever changes.
			for (const c of data) {
				if (c.price === 0 && c.public !== false) all.push(c);
			}
			const last = json.meta?.last_page ?? page;
			if (page >= last || data.length === 0) break;
			page++;
		}
		return all;
	}
}
