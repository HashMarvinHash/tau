// Dion extension for WTR-Lab.com — English machine-translated web novels.
//
// The site is a Next.js app. Public data comes from a handful of JSON APIs:
//   GET  /api/chapters/<raw_id>            -> { chapters: [{ id, order, title, name, ... }] }
//   POST /api/novel/get-by-raw-id {raw_id} -> { novel: { raw_id, slug, title, image } }
//   POST /api/search { q, page }           -> { data: [{ id, slug, data:{title,...}, ... }] }
//   POST /api/reader/get { raw_id, chapter_id, language, translate, chapter_no }
//        -> { content_url } (a signed, short-lived relative path)
//   GET  <content_url>
//        -> { data: { data: { body: [...paragraphs], glossary_data: { terms } } } }
//
// Chapter bodies are AI-translated to English and returned as a JSON array of paragraph
// strings. Proper-noun terms are emitted as placeholder tokens (※<index>ॱ / ※<index>〓)
// that map into the chapter's glossary `terms` array (terms[index] = [english, chinese]).
//
// Auth: chapters 1–10 are free; chapter 11+ requires a logged-in session
// (__Secure-better-auth.session_token cookie). Login is cookie-based via the site's
// /en/auth/login page. The runtime does not attach cookies to fetch automatically,
// so `getCookieHeader()` reads the captured session via `AuthAccount.getAuthSecret()`
// and injects it as a `Cookie` header on every request.
//
// Refresh: the chapter list API is the only thing that changes often and it is a
// single ~200 bytes/chapter JSON request, whereas `detail` also loads the novel-info
// API and the ~100KB server-rendered novel page. `refresh` therefore re-fetches just
// the chapters, returns the cached entry untouched when they are identical, and only
// re-reads the HTML page (for status/description) when new chapters appeared.

import { DionExtension } from "@dion-js/runtime-lib";
import { AuthAccount } from "@dion-js/runtime-lib/auth";
import { Dropdown, defineStoreSetting } from "@dion-js/runtime-lib/settings";
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
	ReleaseStatus,
	Setting,
	SourceResult,
} from "@dion-js/runtime-types/runtime";
import { fetch } from "network";
import { parseHtml } from "parse";
import type { DionElement } from "parse";

const BASE = "https://wtr-lab.com";
const DOMAIN = "wtr-lab.com";

// Glossary token: ※ (U+203B) + digits + a terminator char (U+26EC ॱ or U+3013 〓).
const TOKEN_RE = /\u203B(\d+)[\u26EC\u3013]/g;

// Browse listings. The site exposes a few listing pages that all share the same card
// markup and paginate with ?page=<n> (1-indexed).
const BROWSES: { value: string; label: string }[] = [
	{ value: "novel-list", label: "All Novels" },
	{ value: "ranking/daily", label: "Daily Ranking" },
	{ value: "ranking/weekly", label: "Weekly Ranking" },
	{ value: "ranking/monthly", label: "Monthly Ranking" },
	{ value: "ranking/all_time", label: "All-Time Ranking" },
];

interface ChapterInfo {
	id: number;
	order: number;
	title: string;
	name: string;
}

interface NovellaApi {
	id: number;
	slug: string;
	raw_id: number;
	title: string;
	image: string;
}

interface SearchHit {
	raw_id: number;
	slug: string;
	rating: number;
	chapter_count: number;
	view: number;
	data: { title: string; author: string; description: string };
}

/** Response of POST /api/reader/get (v2: the body moved behind `content_url`). */
interface ReaderSlotResponse {
	success: boolean;
	code?: number;
	error?: string;
	/** Non-empty while an AI translation task is still queued. */
	tasks?: unknown[];
	/** Signed relative path served by /api/v2/reader/content/...; short-lived. */
	content_url?: string;
}

/** Chapter translation payload shared by the reader/get (legacy) and content APIs. */
interface ReaderPayload {
	body?: string[] | string;
	glossary_data?: { terms?: Array<[string, string]> };
}

/** Response of GET <content_url>: same inner shape the reader/get API used to return. */
interface ReaderContentResponse {
	success: boolean;
	error?: string;
	data?: {
		data?: ReaderPayload;
	};
}

function abs(href: string): string {
	if (!href) return href;
	if (href.startsWith("http")) return href;
	return BASE + (href.startsWith("/") ? href : `/${href}`);
}

function link(url: string, header?: Record<string, string> | null): Link {
	return { url, header: header ?? null };
}

/** Strip query/hash and return the path segments. */
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

/** Decode HTML entities present in the server-rendered pages. */
function decodeEntities(s: string): string {
	if (!s) return s;
	return s
		.replace(/&amp;/g, "&")
		.replace(/&#x27;/g, "'")
		.replace(/&#39;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&nbsp;/g, " ");
}

function toStatus(raw: string | null | undefined): ReleaseStatus {
	const v = (raw ?? "").trim().toLowerCase();
	if (v.startsWith("complete")) return "Complete";
	if (v.startsWith("ongo")) return "Releasing";
	return "Unknown";
}

/**
 * Resolve glossary placeholder tokens (※<index>ॱ/〓) in a paragraph using the chapter's
 * glossary terms. terms[index] = [english, chinese]; the English term is terms[index][0].
 */
function resolveGlossary(
	text: string,
	terms: Array<[string, string]> | undefined,
): string {
	if (!terms || terms.length === 0 || !text) return text;
	return text.replace(TOKEN_RE, (match, indexStr) => {
		const idx = Number.parseInt(indexStr, 10);
		const term = terms[idx];
		// term[0] is the English gloss; strip underscore placeholders the MT inserts.
		return term && term[0] ? term[0].replace(/_/g, "") : match;
	});
}

export default class extends DionExtension implements SourceProvider {
	settings = {};
	searchSettings = {
		browse: defineStoreSetting<string>("browse", {
			default: "novel-list",
			label: "Browse",
			ui: new Dropdown(BROWSES),
		}),
	};

	accounts = {
		wtrlab: new AuthAccount(
			DOMAIN,
			{
				type: "Cookie",
				loginpage: `${BASE}/en/auth/login?callbackUrl=%2Fen`,
				logonpage: `${BASE}/en`,
			},
			async () => {
				// Validate by checking whether the session cookie is present.
				try {
					const loggedIn = await this.accounts.wtrlab.isLoggedIn();
					if (!loggedIn) return {};
					const res = await this.request(`${BASE}/api/profile/usage`);
					const json = res.json as { success?: boolean };
					return json?.success ? { userName: "WTR-Lab user" } : {};
				} catch {
					return {};
				}
			},
		),
	};

	entrySettings = {};

	// --- Network helpers -----------------------------------------------------

	/**
	 * Build a `Cookie` header from the captured session cookies (if logged in).
	 * The runtime does not attach cookies to `fetch` automatically, so we read the
	 * auth secret and format it as an HTTP Cookie header value.
	 */
	private async getCookieHeader(): Promise<string | null> {
		const creds = await this.accounts.wtrlab.getAuthSecret();
		if (!creds || creds.type !== "Cookies" || !creds.cookies) return null;
		const parts: string[] = [];
		for (const name of Object.keys(creds.cookies)) {
			const values = creds.cookies[name];
			if (!values) continue;
			for (const v of values) {
				if (v) parts.push(`${name}=${v}`);
			}
		}
		return parts.length > 0 ? parts.join("; ") : null;
	}

	/** `fetch` wrapper that injects the session cookie header when available. */
	private async request(
		url: string,
		option?: {
			method?:
				| "GET"
				| "HEAD"
				| "POST"
				| "PUT"
				| "DELETE"
				| "CONNECT"
				| "TRACE"
				| "PATCH";
			headers?: Record<string, string>;
			body?: string;
		},
	) {
		const cookie = await this.getCookieHeader();
		const headers = { ...(option?.headers ?? {}) };
		if (cookie) headers.Cookie = cookie;
		return fetch(url, { ...option, headers });
	}

	private async postJson<T>(url: string, body: unknown): Promise<T> {
		const res = await this.request(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		return res.json as T;
	}

	private async getJson<T>(url: string): Promise<T> {
		const res = await this.request(url);
		return res.json as T;
	}

	// --- Browse --------------------------------------------------------------

	async browse(
		page: number,
		settings: Record<string, Setting>,
	): Promise<EntryListResult> {
		const store = this.convertSettingStore(settings);
		const path = this.searchSettings.browse.get(store);
		// The site is 1-indexed; the host passes a 0-indexed page.
		const url = `${BASE}/en/${path}?page=${page + 1}`;
		const res = await this.request(url);
		const doc = parseHtml(res.body);
		const content = parseListCards(doc);
		const hasNext = detectNextPage(doc, page + 1);
		return {
			entries: { content, hasnext: hasNext, length: content.length },
			settings: store.toMap(),
		};
	}

	async search(
		page: number,
		filter: string,
		settings: Record<string, Setting>,
	): Promise<EntryListResult> {
		const store = this.convertSettingStore(settings);
		// The search endpoint debounces and returns a single page of up to ~10 hits;
		// it does not paginate, so only the first page returns results.
		if (page > 0)
			return {
				entries: { content: [], hasnext: false },
				settings: store.toMap(),
			};
		const json = await this.postJson<{ success: boolean; data: SearchHit[] }>(
			`${BASE}/api/search`,
			{ text: filter },
		);
		if (!json?.success || !json.data)
			return {
				entries: { content: [], hasnext: false },
				settings: store.toMap(),
			};
		const content = json.data.map((hit) => searchHitToEntry(hit));
		return {
			entries: { content, hasnext: false, length: content.length },
			settings: store.toMap(),
		};
	}

	// --- Detail --------------------------------------------------------------

	async detail(
		entryid: EntryId,
		settings: Record<string, Setting>,
	): Promise<EntryDetailedResult> {
		const rawId = entryid.uid;

		// Chapter list and basic novel info come from JSON APIs.
		const chapters = await this.fetchChapters(rawId);
		const novel = await this.fetchNovelInfo(rawId);

		// Richer metadata (description, genres, status, author) lives on the HTML page.
		const meta = await this.fetchHtmlMeta(rawId, novel?.slug ?? "");

		const title = novel?.title ?? meta.title ?? rawId;
		const cover = novel?.image ?? meta.cover;
		const episodes = chaptersToEpisodes(rawId, chapters);

		return {
			entry: {
				id: entryid,
				url: `${BASE}/en/novel/${rawId}/${novel?.slug ?? ""}`,
				titles: [title],
				media_type: "Book",
				status: toStatus(meta.status),
				description: meta.description || "",
				language: "en",
				author: meta.author ? [meta.author] : null,
				cover: cover ? link(cover) : null,
				genres: meta.genres,
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

	async refresh(
		entry: EntryDetailed,
		settings: Record<string, Setting>,
	): Promise<EntryDetailedResult> {
		const rawId = entry.id.uid;
		const chapters = await this.fetchChapters(rawId);
		// An empty list means the API call failed; keep what we have rather than
		// wiping the cached chapters.
		if (chapters.length === 0) return { entry, settings };

		const episodes = chaptersToEpisodes(rawId, chapters);
		const unchanged =
			episodes.length === entry.episodes.length &&
			episodes.every((ep, i) => {
				const cached = entry.episodes[i];
				return (
					cached !== undefined &&
					cached.id.uid === ep.id.uid &&
					cached.name === ep.name
				);
			});
		if (unchanged) return { entry, settings };

		// Slug, title and cover are stable, so only the HTML page is re-read to
		// pick up a status/description change alongside the new chapters.
		const slug = pathParts(entry.url).pop() ?? "";
		const meta = await this.fetchHtmlMeta(rawId, slug);

		return {
			entry: {
				...entry,
				status: toStatus(meta.status),
				description: meta.description || entry.description,
				author: meta.author ? [meta.author] : entry.author,
				cover: entry.cover ?? (meta.cover ? link(meta.cover) : null),
				genres: meta.genres ?? entry.genres,
				episodes,
				length: episodes.length,
			},
			settings,
		};
	}

	// --- Source --------------------------------------------------------------

	async source(
		epid: EpisodeId,
		settings: Record<string, Setting>,
	): Promise<SourceResult> {
		// epid.uid is "<rawId>:<chapterId>" (see chaptersToEpisodes).
		const { rawId, chapterId } = parseEpisodeUid(epid.uid);
		const chapter = await this.findChapter(rawId, chapterId);

		// Step 1: claim the chapter slot. The API no longer embeds the translation;
		// it answers with a signed `content_url` (or a queued task list).
		const json = await this.postJson<ReaderSlotResponse>(
			`${BASE}/api/reader/get`,
			{
				raw_id: Number(rawId),
				chapter_id: Number(chapterId),
				language: "en",
				translate: "ai",
				chapter_no: chapter?.order ?? 1,
			},
		);

		if (!json?.success) {
			const err = json?.error || "Failed to load chapter.";
			// code 1401 == "You are not logged in!" — guide the user to log in.
			if (json?.code === 1401) {
				return notLoggedInSource(err, settings);
			}
			return errorSource(err, settings);
		}

		if (!json.content_url) {
			return errorSource(
				(json.tasks?.length ?? 0) > 0
					? "This chapter is still being translated. Try again later."
					: "Failed to load chapter.",
				settings,
			);
		}

		// Step 2: fetch the signed content URL for the actual paragraphs.
		const inner = await this.fetchChapterContent(json.content_url);
		if (!inner) {
			return errorSource("Failed to load chapter content.", settings);
		}

		const paragraphs = bodyToParagraphs(inner.body, inner.glossary_data?.terms);

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
		// /en/novel/<raw_id>/<slug>[/chapter-<n>]
		if (parts.length < 3) return false;
		const hostIdx = parts.indexOf("en");
		return hostIdx >= 0 && parts[hostIdx + 1] === "novel";
	}

	// --- Data fetch helpers --------------------------------------------------

	private async fetchChapters(rawId: string): Promise<ChapterInfo[]> {
		try {
			const json = await this.getJson<{ chapters: ChapterInfo[] }>(
				`${BASE}/api/chapters/${rawId}`,
			);
			return json?.chapters ?? [];
		} catch {
			return [];
		}
	}

	private async fetchNovelInfo(rawId: string): Promise<NovellaApi | null> {
		try {
			const json = await this.postJson<{
				success: boolean;
				novel?: NovellaApi;
			}>(`${BASE}/api/novel/get-by-raw-id`, { raw_id: Number(rawId) });
			return json?.success ? (json.novel ?? null) : null;
		} catch {
			return null;
		}
	}

	private async fetchHtmlMeta(rawId: string, slug: string): Promise<NovelMeta> {
		try {
			const res = await this.request(`${BASE}/en/novel/${rawId}/${slug}`);
			const doc = parseHtml(res.body);
			return parseNovelMeta(doc);
		} catch {
			return EMPTY_META;
		}
	}

	private async findChapter(
		rawId: string,
		chapterId: string,
	): Promise<ChapterInfo | undefined> {
		const chapters = await this.fetchChapters(rawId);
		return chapters.find((c) => String(c.id) === chapterId);
	}

	/**
	 * Fetch a signed reader content URL and return its inner `data.data` payload.
	 *
	 * The signature check is occasionally flaky right after the URL is minted
	 * (observed 403 "Invalid or expired signature" that succeeds on retry), so a
	 * failed first attempt is retried once before giving up.
	 */
	private async fetchChapterContent(
		contentUrl: string,
	): Promise<ReaderPayload | undefined> {
		const url = contentUrl.startsWith("http") ? contentUrl : BASE + contentUrl;
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const res = await this.request(url);
				const json = res.json as ReaderContentResponse;
				if (json?.success && json.data?.data) return json.data.data;
			} catch {
				// fall through to the retry
			}
		}
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

interface NovelMeta {
	title: string | null;
	description: string;
	author: string | null;
	genres: string[] | null;
	status: string | null;
	cover: string | null;
}

const EMPTY_META: NovelMeta = {
	title: null,
	description: "",
	author: null,
	genres: null,
	status: null,
	cover: null,
};

/** Parse the server-rendered novel-list / ranking cards into Entry[]. */
function parseListCards(doc: DionElement): Entry[] {
	// Each novel title link looks like:
	//   <a class="group ..." title="Title" href="/en/novel/<id>/<slug>"><h3 ...>Title</h3>
	const anchors = doc.select(new CSSSelector('a[href*="/en/novel/"]'));
	const seen = new Set<string>();
	const entries: Entry[] = [];

	for (let i = 0; i < anchors.length; i++) {
		const a = anchors.get(i);
		if (!a) continue;
		const href = a.attr("href");
		const m = href.match(/\/en\/novel\/(\d+)\/([^/?#]+)/);
		if (!m) continue;
		const rawId = m[1];
		if (!rawId || seen.has(rawId)) continue;

		const title =
			decodeEntities(a.attr("title")) ||
			a.select(new CSSSelector("h3")).first?.text?.trim() ||
			rawId;
		seen.add(rawId);

		entries.push({
			id: { uid: rawId },
			url: `${BASE}/en/novel/${rawId}/${m[2]}`,
			title,
			media_type: "Book",
			cover: cardCover(a),
			author: null,
			rating: null,
			views: null,
			length: null,
		});
	}
	return entries;
}

/** Walk up to the card root and find the first real cover image URL. */
function cardCover(a: DionElement): Link | null {
	let node: DionElement | undefined = a;
	for (let depth = 0; depth < 6 && node; depth++) {
		const imgs = node.select(new CSSSelector("img"));
		for (let i = 0; i < imgs.length; i++) {
			const src = imgs.get(i)?.attr("src") ?? "";
			// Skip the blurred placeholder shim; keep the proxied cover.
			if (src.includes("/api/v2/img?src=")) {
				return link(abs(src.replace(/&amp;/g, "&")));
			}
		}
		node = node.parent;
	}
	return null;
}

/** The listing pages render numbered page links; detect whether a next page exists. */
function detectNextPage(doc: DionElement, currentPage: number): boolean {
	const links = doc.select(new CSSSelector('a[href*="page="]'));
	for (let i = 0; i < links.length; i++) {
		const href = links.get(i)?.attr("href") ?? "";
		const m = href.match(/page=(\d+)/);
		if (m && m[1]) {
			const n = Number.parseInt(m[1], 10);
			if (n > currentPage) return true;
		}
	}
	return false;
}

function searchHitToEntry(hit: SearchHit): Entry {
	const rawId = String(hit.raw_id);
	return {
		id: { uid: rawId },
		url: `${BASE}/en/novel/${rawId}/${hit.slug}`,
		title: hit.data?.title ?? rawId,
		media_type: "Book",
		cover: null,
		author: hit.data?.author ? [hit.data.author] : null,
		rating: hit.rating ?? null,
		views: hit.view ?? null,
		length: hit.chapter_count ?? null,
	};
}

/** Parse a novel detail page for description, author, genres and status. */
function parseNovelMeta(doc: DionElement): NovelMeta {
	const title = doc.select(new CSSSelector("h1")).first?.text?.trim() ?? null;

	const description = extractDescription(doc);

	// Metadata lives in two-column grid rows: <span>Label</span> <div>value</div>.
	const { author, status } = extractGridMeta(doc);
	const genres = extractGenres(doc);
	const cover = extractDetailCover(doc);

	return { title, description, author, genres, status, cover };
}

function extractDescription(doc: DionElement): string {
	// The synopsis is the longest text block in the main content area.
	const candidates = doc.select(new CSSSelector("p"));
	let best = "";
	for (let i = 0; i < candidates.length; i++) {
		const t = candidates.get(i)?.text?.trim() ?? "";
		if (t.length > best.length && t.length > 60) best = t;
	}
	return decodeEntities(best);
}

function extractGridMeta(doc: DionElement): {
	author: string | null;
	status: string | null;
} {
	let author: string | null = null;
	let status: string | null = null;
	const rows = doc.select(
		new CSSSelector('div[class*="grid-cols-[108px_1fr]"]'),
	);
	for (let i = 0; i < rows.length; i++) {
		const row = rows.get(i);
		if (!row) continue;
		const label = row.select(new CSSSelector("span")).first?.text?.trim();
		// The value is the row text minus the label.
		const fullText = row.text.trim();
		const value = label ? fullText.replace(label, "").trim() : fullText;
		if (label === "Author") author = value || null;
		else if (label === "Status") status = value || null;
	}
	return { author, status };
}

function extractGenres(doc: DionElement): string[] | null {
	// Genres appear as small uppercase spans near a "Genre" label.
	const genres: string[] = [];
	const spans = doc.select(new CSSSelector("span.uppercase"));
	for (let i = 0; i < spans.length; i++) {
		const t = spans.get(i)?.text?.trim();
		if (t && t.length > 1 && t !== "Genre" && /^[a-z]/i.test(t)) {
			genres.push(t);
		}
	}
	return genres.length > 0 ? dedupe(genres) : null;
}

function extractDetailCover(doc: DionElement): string | null {
	const imgs = doc.select(new CSSSelector("img"));
	for (let i = 0; i < imgs.length; i++) {
		const src = imgs.get(i)?.attr("src") ?? "";
		if (src.includes("/api/v2/img?src=")) {
			return abs(src.replace(/&amp;/g, "&"));
		}
	}
	return null;
}

function chaptersToEpisodes(rawId: string, chapters: ChapterInfo[]): Episode[] {
	return chapters.map((c) => ({
		id: { uid: `${rawId}:${c.id}` },
		name: c.title || `Chapter ${c.order}`,
		url: `${BASE}/en/novel/${rawId}/chapter-${c.order}`,
		description: null,
		cover: null,
		timestamp: null,
	}));
}

function parseEpisodeUid(uid: string): { rawId: string; chapterId: string } {
	const idx = uid.lastIndexOf(":");
	if (idx < 0) return { rawId: uid, chapterId: "" };
	return { rawId: uid.slice(0, idx), chapterId: uid.slice(idx + 1) };
}

/**
 * Convert the reader/get body into a Paragraph[].
 *
 * The body is usually a plain JSON array of translated paragraph strings (with glossary
 * tokens). Legacy/encrypted bodies arrive as an "arr:..." AES-GCM blob which the runtime
 * cannot decrypt (WebCrypto subtle is unavailable in the extension VM), so we fall back to
 * a best-effort single-paragraph render of whatever string we receive.
 */
function bodyToParagraphs(
	body: string[] | string | undefined,
	terms: Array<[string, string]> | undefined,
): Array<{ type: "Text"; content: string; style: null }> {
	if (!body) return [];
	if (Array.isArray(body)) {
		return body
			.map((p) => (typeof p === "string" ? p : String(p)))
			.filter((p) => p && p.trim().length > 0)
			.map((p) => ({
				type: "Text" as const,
				content: resolveGlossary(decodeEntities(p), terms),
				style: null,
			}));
	}
	if (typeof body === "string") {
		return [
			{
				type: "Text",
				content: resolveGlossary(decodeEntities(body), terms),
				style: null,
			},
		];
	}
	return [];
}

function errorSource(
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

function notLoggedInSource(
	_message: string,
	settings: Record<string, Setting>,
): SourceResult {
	return {
		source: {
			type: "Paragraphlist",
			paragraphs: [
				{
					type: "Text",
					content:
						"This chapter requires you to be logged in. Free chapters (1–10) " +
						"can be read without an account, but later chapters need a WTR-Lab " +
						"session. Open the extension's account settings and log in to " +
						"wtr-lab.com to continue reading.",
					style: null,
				},
			],
			audio: null,
		},
		settings,
	};
}

function dedupe<T>(arr: T[]): T[] {
	return [...new Set(arr)];
}
