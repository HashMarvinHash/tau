// Dion extension for CozyAudiobooks.com — free streaming audiobooks.
//
// The site is a WordPress blog where each "book" is a post at `/<slug>/`.
// Book pages 302-redirect to a standalone player hosted at
// `vforumas.lt/audio/<slug>/` (a gate cookie `vf_audio_cozy_gate` is set on the
// way; the host's cookie jar handles the redirect chain transparently). The
// player page holds the cover, `h1` title, `p.meta` lines ("Author: …",
// "Duration: …") and a chapter list (`ol.chapters li[data-src]`). Each chapter's
// `data-src` is a direct `.mp3` URL on a CDN (ipaudio7.com) that supports Range
// requests and CORS, so we expose it as an `Audio` source.
//
// The player page no longer carries the description or category list, so those
// come from the WordPress REST API:
// `/wp-json/wp/v2/posts?slug=<slug>&_embed=1` returns `content.rendered`
// (description) and `_embedded["wp:term"]` (category names) alongside
// `modified_gmt`. `detail` records `modified_gmt` in the entry's `meta`, and
// `refresh` re-probes it (cheap `_fields=modified_gmt` request) and skips the
// page fetch + parse when it hasn't changed.

import { DionExtension } from "@dion-js/runtime-lib";
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
	Setting,
	SourceResult,
} from "@dion-js/runtime-types/runtime";
import { fetch } from "network";
import { parseHtml, parseHtmlFragment } from "parse";
import type { DionElement } from "parse";

const BASE = "https://cozyaudiobooks.com";

// Entry meta key holding the post's `modified_gmt` the episodes were built from.
const MODIFIED_META_KEY = "cozy-audiobooks:modified";

// Category slug -> label. Empty string means the home feed (all categories).
// Mirrors the site's own category bar (`.categories-bar .cat-pill` links).
const CATEGORIES: { slug: string; label: string }[] = [
	{ slug: "", label: "All" },
	{ slug: "uncategorized", label: "Uncategorized" },
	{ slug: "literature-fiction", label: "Literature & Fiction" },
	{ slug: "fantasy", label: "Fantasy" },
	{ slug: "science-fiction-fantasy", label: "Science Fiction & Fantasy" },
	{ slug: "mystery", label: "Mystery" },
	{ slug: "romance", label: "Romance" },
	{ slug: "thriller-suspense", label: "Thriller & Suspense" },
	{ slug: "adults", label: "Adults" },
	{ slug: "genre-fiction", label: "Genre Fiction" },
	{ slug: "sci-fi", label: "Sci-Fi" },
	{ slug: "contemporary", label: "Contemporary" },
	{ slug: "teen-young-adult", label: "Teen & Young Adult" },
	{ slug: "action-adventure", label: "Action & Adventure" },
	{ slug: "science-fiction", label: "Science Fiction" },
	{ slug: "adventure", label: "Adventure" },
];

/** Shape of the WordPress REST post fields we consume. */
type WpPost = {
	modified_gmt?: string;
	content?: { rendered?: string };
	_embedded?: { "wp:term"?: { taxonomy?: string; name?: string }[][] };
};

/** Description + genres + last-modified for a post, from the WP REST API. */
type PostInfo = {
	modified: string | null;
	description: string | null;
	genres: string[] | null;
};

function abs(href: string): string {
	if (!href) return href;
	if (href.startsWith("http")) return href;
	return BASE + (href.startsWith("/") ? href : `/${href}`);
}

function link(url: string): Link {
	return { url, header: null };
}

/** Extract the path portion of a URL without relying on the `URL` global. */
function pathOf(url: string): string {
	// Strip protocol://host if present.
	const proto = url.indexOf("://");
	let rest = url;
	if (proto >= 0) {
		rest = url.slice(proto + 3); // after "https://"
		const slash = rest.indexOf("/");
		rest = slash >= 0 ? rest.slice(slash) : "";
	}
	// Drop any query/hash so only the path remains.
	const q = rest.search("[?#]");
	if (q >= 0) rest = rest.slice(0, q);
	return rest;
}

/** Pull the post slug (id.uid) out of a book-card URL. */
function slugFromUrl(url: string): string {
	// "https://cozyaudiobooks.com/hello-heartbreaker/" -> "hello-heartbreaker"
	const parts = pathOf(url).split("/").filter(Boolean);
	return parts[0] ?? url;
}

function parseBookCard(card: DionElement): Entry | null {
	const h3 =
		card.select(new CSSSelector(".card-body h3 a")).first ??
		card.select(new CSSSelector("h3 a")).first ??
		card.select(new CSSSelector("a")).first;
	const href = h3?.attr("href");
	const title = h3?.text?.trim();
	if (!href || !title) return null;

	const cover = card.select(new CSSSelector("img")).first?.attr("src") ?? null;
	const author =
		card.select(new CSSSelector(".card-meta a")).first?.text?.trim() ?? null;

	return {
		id: { uid: slugFromUrl(href) },
		url: abs(href),
		title,
		media_type: "Audio",
		cover: cover ? link(abs(cover)) : null,
		author: author ? [author] : null,
		rating: null,
		views: null,
		length: null,
	};
}

export default class extends DionExtension implements SourceProvider {
	settings = {};
	searchSettings = {
		category: defineStoreSetting<string>("category", {
			default: "",
			label: "Browse category",
			ui: new Dropdown(
				CATEGORIES.map((c) => ({ value: c.slug, label: c.label })),
			),
		}),
	};

	accounts = {};
	entrySettings = {};

	private async browseList(url: string): Promise<EntryList> {
		const res = await fetch(url);
		const doc = parseHtml(res.body);
		const cards = doc.select(new CSSSelector("article.book-card"));

		const content = cards
			.map((card) => parseBookCard(card))
			.filter((e): e is Entry => e !== null);

		// WordPress paginates with /page/N/. A "next" page exists if the next
		// page number link is present.
		const next = doc.select(new CSSSelector("a.next")).first !== undefined;

		return { content, hasnext: next };
	}

	async browse(
		page: number,
		settings: Record<string, Setting>,
	): Promise<EntryListResult> {
		const store = this.convertSettingStore(settings);
		const slug = this.searchSettings.category.get(store);
		// Host is 0-indexed; the site is 1-indexed.
		const n = page + 1;
		const base = slug ? `${BASE}/category/${slug}` : BASE;
		const url = n > 1 ? `${base}/page/${n}/` : `${base}/`;
		return { entries: await this.browseList(url), settings: store.toMap() };
	}

	async search(
		page: number,
		filter: string,
		settings: Record<string, Setting>,
	): Promise<EntryListResult> {
		const store = this.convertSettingStore(settings);
		const n = page + 1;
		const url = `${BASE}/?s=${encodeURIComponent(filter)}&paged=${n}`;
		return { entries: await this.browseList(url), settings: store.toMap() };
	}

	async detail(
		entryid: EntryId,
		settings: Record<string, Setting>,
	): Promise<EntryDetailedResult> {
		const slug = entryid.uid;
		const url = `${BASE}/${slug}/`;
		// The REST post (description/genres/modified) is independent of the page
		// fetch, so run both at once.
		const [post, res] = await Promise.all([this.fetchPost(slug), fetch(url)]);
		return buildDetail(entryid, settings, parseHtml(res.body), url, post);
	}

	async refresh(
		entry: EntryDetailed,
		settings: Record<string, Setting>,
	): Promise<EntryDetailedResult> {
		const slug = entry.id.uid;
		const post = await this.fetchPost(slug);
		const stored = entry.meta?.[MODIFIED_META_KEY] ?? null;
		if (
			post?.modified != null &&
			stored !== null &&
			post.modified === stored &&
			entry.episodes.length > 0
		) {
			return { entry, settings };
		}
		const url = `${BASE}/${slug}/`;
		const res = await fetch(url);
		return buildDetail(
			entry.id,
			settings,
			parseHtml(res.body),
			url,
			post,
			entry.meta,
		);
	}

	/** WordPress REST post with embedded category terms; null when unavailable. */
	private async fetchPost(slug: string): Promise<PostInfo | null> {
		try {
			const res = await fetch(
				`${BASE}/wp-json/wp/v2/posts?slug=${encodeURIComponent(slug)}&_embed=1`,
			);
			if (!res.ok) return null;
			const json = res.json as WpPost[] | undefined;
			const post = json?.[0];
			if (!post) return null;

			const modified =
				typeof post.modified_gmt === "string" && post.modified_gmt
					? post.modified_gmt
					: null;

			let description: string | null = null;
			const rendered = post.content?.rendered;
			if (rendered) {
				// Strip tags/entities with the host parser, then drop the trailing
				// "Start listening to …" call-to-action paragraph.
				const text = parseHtmlFragment(rendered).text.replace(
					/Start listening to [\s\S]*$/i,
					"",
				);
				description = text.trim() || null;
			}

			let genres: string[] | null = null;
			const groups = post._embedded?.["wp:term"];
			if (Array.isArray(groups)) {
				const names: string[] = [];
				for (const group of groups) {
					if (!Array.isArray(group)) continue;
					for (const term of group) {
						if (term?.taxonomy === "category" && term.name) {
							names.push(parseHtmlFragment(term.name).text.trim());
						}
					}
				}
				genres = names.length > 0 ? names : null;
			}

			return { modified, description, genres };
		} catch {
			return null;
		}
	}

	async source(
		epid: EpisodeId,
		settings: Record<string, Setting>,
	): Promise<SourceResult> {
		const { slug, index } = parseEpisodeUid(epid.uid);

		const res = await fetch(`${BASE}/${slug}/`);
		const doc = parseHtml(res.body);
		const chapters = parseChapters(doc, slug);

		const episode = chapters[index];
		const audioUrl = episode?.url;

		if (!audioUrl) {
			throw new Error(`No audio source found for ${slug}#${index}`);
		}

		return {
			source: {
				type: "Audio",
				chapters: null,
				sources: [
					{
						name: episode?.name ?? slug,
						lang: "en",
						url: link(audioUrl),
					},
				],
			},
			settings,
		};
	}

	async handleUrl(url: string): Promise<boolean> {
		// Deep links look like https://cozyaudiobooks.com/<slug>/ and are not
		// category/search pages. Parse the host without the `URL` global.
		const proto = url.indexOf("://");
		if (proto < 0) return false;
		const afterProto = url.slice(proto + 3);
		const slash = afterProto.indexOf("/");
		const host = (
			slash >= 0 ? afterProto.slice(0, slash) : afterProto
		).toLowerCase();
		if (host !== "cozyaudiobooks.com" && !host.endsWith(".cozyaudiobooks.com"))
			return false;
		const parts = pathOf(url).split("/").filter(Boolean);
		if (parts.length === 0) return false;
		const first = parts[0];
		return first !== "category" && first !== "page";
	}
}

/** Build the full entry from a fetched player page. `cachedMeta` (from a refresh)
 *  is carried over so other extensions' meta keys survive the rebuild. */
function buildDetail(
	entryid: EntryId,
	settings: Record<string, Setting>,
	doc: DionElement,
	url: string,
	post: PostInfo | null,
	cachedMeta?: { [key: string]: string } | null,
): EntryDetailedResult {
	const slug = entryid.uid;
	const title =
		doc.select(new CSSSelector(".hero h1")).first?.text?.trim() ??
		doc.select(new CSSSelector("h1")).first?.text?.trim() ??
		slug;

	// Player page metadata: `<p class="meta">Author: …</p>` lines.
	const meta = parseMetaLines(doc);
	const author = meta.Author ? [meta.Author] : null;
	const language = normalizeLanguage(meta.Language ?? "English");
	const genres =
		post?.genres ??
		(meta.Category ? meta.Category.split(",").map((cat) => cat.trim()) : null);

	const coverSrc =
		doc.select(new CSSSelector(".hero .cover img")).first?.attr("src") ??
		doc.select(new CSSSelector(".cover img")).first?.attr("src") ??
		doc
			.select(new CSSSelector(".book-cover-single > img"))
			.first?.attr("src") ??
		null;

	const description = post?.description ?? "";

	const episodes = parseChapters(doc, slug);
	const lengthText = meta.Duration ?? null;
	const lengthSec = parseDuration(lengthText);

	const entryMeta: { [key: string]: string } = { ...(cachedMeta ?? {}) };
	if (post?.modified != null) entryMeta[MODIFIED_META_KEY] = post.modified;

	return {
		entry: {
			id: entryid,
			url,
			titles: [title],
			media_type: "Audio",
			status: "Complete",
			description,
			language,
			author,
			cover: coverSrc ? link(abs(coverSrc)) : null,
			genres,
			episodes,
			length: lengthSec,
			rating: null,
			views: null,
			poster: null,
			ui: null,
			meta: Object.keys(entryMeta).length > 0 ? entryMeta : null,
		},
		settings,
	};
}

/** Read the book page's metadata into a label->value map (Author, Duration,
 *  Language, Category, ...). The current theme renders a structured
 *  `book-meta-table` (`span.meta-label` + `span.meta-value` rows); older
 *  player pages used `<p class="meta">Label: value</p>` lines. Both are
 *  merged, with the table taking precedence. */
function parseMetaLines(doc: DionElement): Record<string, string> {
	const out: Record<string, string> = {};

	const labels = doc.select(new CSSSelector(".book-meta-table .meta-label"));
	const values = doc.select(new CSSSelector(".book-meta-table .meta-value"));
	const rows = Math.min(labels.length, values.length);
	for (let i = 0; i < rows; i++) {
		const label = labels.get(i)?.text?.trim();
		const value = values.get(i)?.text?.trim();
		if (label && value) out[label] = value;
	}

	const lines = doc.select(new CSSSelector("p.meta"));
	lines.map((line) => {
		const text = line.text?.trim();
		if (!text) return;
		const colon = text.indexOf(":");
		if (colon <= 0) return;
		const label = text.slice(0, colon).trim();
		const value = text.slice(colon + 1).trim();
		if (label && value && !(label in out)) out[label] = value;
	});
	return out;
}

/** Parse the player page's chapter list (`ol.chapters li[data-src]`) into
 *  episodes. Each `li` looks like `<li data-src="…mp3">1. Chapter Name</li>`. */
function parseChapters(doc: DionElement, slug: string): Episode[] {
	let lis = doc.select(new CSSSelector("ol.chapters li[data-src]"));
	if (lis.length === 0) {
		// Legacy theme markup.
		lis = doc.select(new CSSSelector("ol.chapter-list > li[data-src]"));
	}
	if (lis.length === 0) {
		// Fallback: a book with no chapter list but a main <audio> player.
		const src =
			doc.select(new CSSSelector("audio#vfAudio")).first?.attr("src") ??
			doc.select(new CSSSelector("audio#mainPlayer")).first?.attr("src");
		if (src) {
			return [
				{
					id: { uid: makeEpisodeUid(slug, 0) },
					name: "Full Audiobook",
					url: abs(src),
					description: null,
					cover: null,
					timestamp: null,
				},
			];
		}
		return [];
	}

	const episodes: Episode[] = [];
	for (let i = 0; i < lis.length; i++) {
		const li = lis.get(i);
		if (!li) continue;
		const src = li.attr("data-src");
		// Item text starts with the chapter number: "1. Chapter Name".
		const text = li.text?.trim() ?? "";
		const numMatch = /^(\d+)\s*[.)]\s*/.exec(text);
		const num = numMatch ? numMatch[1] : String(i + 1);
		const name = numMatch ? text.slice(numMatch[0].length).trim() : text;
		episodes.push({
			id: { uid: makeEpisodeUid(slug, i) },
			name: name ? `Chapter ${num}: ${name}` : `Chapter ${num}`,
			url: abs(src),
			description: null,
			cover: null,
			timestamp: null,
		});
	}
	return episodes;
}

function makeEpisodeUid(slug: string, index: number): string {
	return `${slug}#${index}`;
}

function parseEpisodeUid(uid: string): { slug: string; index: number } {
	const i = uid.lastIndexOf("#");
	if (i < 0) return { slug: uid, index: 0 };
	return {
		slug: uid.slice(0, i),
		index: Number.parseInt(uid.slice(i + 1), 10) || 0,
	};
}

/** "09:35:17" / "35:17" -> seconds; null when unparseable. */
function parseDuration(text: string | null): number | null {
	if (!text) return null;
	const parts = text.split(":").map((p) => Number.parseInt(p, 10));
	if (parts.some((p) => Number.isNaN(p))) return null;
	let sec = 0;
	for (const p of parts) sec = sec * 60 + p;
	return sec;
}

function normalizeLanguage(raw: string): string {
	const v = raw.trim().toLowerCase();
	if (v === "english" || v === "en") return "en";
	if (v === "spanish" || v === "es") return "es";
	if (v === "french" || v === "fr") return "fr";
	if (v === "german" || v === "de") return "de";
	return raw.trim() || "en";
}
