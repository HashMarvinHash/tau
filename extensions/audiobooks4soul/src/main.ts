// Dion extension for Audiobooks4Soul.com — free streaming audiobooks.
//
// The site is a WordPress blog on the tagDiv Newspaper theme. Each book is a
// post at `/<slug>/`. A post page holds a metadata box (status / version /
// author / narrator / series / genre / updated / listening time), a review-style
// description under `.td-post-content` and a "simple audio player"
// (`div.simp-playlist`) whose tracks are `<span class="simp-source" data-src>`.
//
// Audio: each track's `data-src` is an encrypted blob. The site's player calls
// `/wp-content/plugins/custom-story-audio/inc/security/decrypt.php?encrypted=<blob>`
// (Referer must be the post URL) which returns the plain `.mp3` URL on
// `storage01.ezaudiobooks.com`. That host requires `Referer:
// https://audiobooks4soul.com/` on playback, so it is set on the returned Link.
//
// Browse: WordPress REST pagination is hard-capped at page 1 by a hardening
// plugin (`?page=2` -> 400), and there is no global post archive, so browsing is
// category-based. Category archives live at `/<category-slug>/page/N/` (search
// at `/?s=<q>&paged=N`) and render `td_module_*` cards inside `.tdb_loop`
// (category) / `.td-ss-main-content` (search). Pagination: the category nav
// (`next page-numbers`) is injected by an inline script, so `hasnext` is
// detected on the raw body; search pages have no nav at all, so there the
// heuristic is "full page of results".

import { DionExtension } from "@dion-js/runtime-lib";
import { Dropdown, defineStoreSetting } from "@dion-js/runtime-lib/settings";
import { Column, Text } from "@dion-js/runtime-lib/ui";
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
	EventData,
	EventResult,
	Link,
	Setting,
	SourceResult,
} from "@dion-js/runtime-types/runtime";
import { fetch } from "network";
import { parseHtml } from "parse";
import type { DionElement } from "parse";

const BASE = "https://audiobooks4soul.com";
// The audio host (storage01.ezaudiobooks.com) rejects requests without this
// site referer, and decrypt.php rejects requests without a referer as well.
const REFERER = `${BASE}/`;
const DECRYPT_URL = `${BASE}/wp-content/plugins/custom-story-audio/inc/security/decrypt.php?encrypted=`;

// The search loop renders 10 results per page and has no pagination nav, so a
// full page is treated as "probably more".
const SEARCH_RESULTS_PER_PAGE = 10;

// Category slug -> label, from /wp-json/wp/v2/categories (ordered by size).
const CATEGORIES: { slug: string; label: string }[] = [
	{ slug: "science-fiction-fantasy-1", label: "Science Fiction & Fantasy" },
	{ slug: "literature-fiction", label: "Literature & Fiction" },
	{ slug: "childrens-audiobooks", label: "Children's Audiobooks" },
	{ slug: "thriller-suspense", label: "Thriller & Suspense" },
	{ slug: "mystery", label: "Mystery" },
	{ slug: "romance-2", label: "Romance" },
	{ slug: "teen-young-adult", label: "Teen & Young Adult" },
	{ slug: "fantasy", label: "Fantasy" },
	{ slug: "psychological-thriller", label: "Psychological Thriller" },
	{ slug: "action-adventure", label: "Action & Adventure" },
	{ slug: "erotica-1", label: "Erotica" },
	{ slug: "lgbtq", label: "LGBTQ+" },
	{ slug: "one-shot", label: "One Shot" },
	{ slug: "biographies-memoirs", label: "Biographies & Memoirs" },
	{ slug: "business-careers", label: "Business & Careers" },
	{ slug: "horror", label: "Horror" },
	{ slug: "history", label: "History" },
	{ slug: "detective", label: "Detective" },
	{ slug: "genre-fiction", label: "Genre Fiction" },
	{ slug: "health-wellness", label: "Health & Wellness" },
	{ slug: "adults", label: "Adults" },
	{ slug: "contemporary", label: "Contemporary" },
	{
		slug: "parenting-personal-development",
		label: "Parenting & Personal Development",
	},
	{ slug: "relationships", label: "Relationships" },
	{ slug: "science-fiction", label: "Science Fiction" },
	{ slug: "arts-entertainment", label: "Arts & Entertainment" },
	{ slug: "news", label: "News" },
	{ slug: "education-learning", label: "Education & Learning" },
	{ slug: "womens-fiction", label: "Women's Fiction" },
	{ slug: "self-help", label: "Self-help" },
	{ slug: "crime-fiction", label: "Crime Fiction" },
	{ slug: "politics-social-sciences", label: "Politics & Social Sciences" },
	{
		slug: "growing-up-facts-of-life",
		label: "Growing Up & Facts of Life",
	},
	{ slug: "classics", label: "Classics" },
	{ slug: "romantic-suspense", label: "Romantic Suspense" },
	{ slug: "military", label: "Military" },
	{ slug: "romantic-comedy", label: "Romantic Comedy" },
	{ slug: "religion-spirituality", label: "Religion & Spirituality" },
	{ slug: "science-engineering", label: "Science & Engineering" },
	{
		slug: "psychology-mental-health",
		label: "Psychology & Mental Health",
	},
	{ slug: "folk-tales-myths", label: "Folk Tales & Myths" },
	{ slug: "fairy-tales", label: "Fairy Tales" },
	{ slug: "african-american", label: "African American" },
	{ slug: "world-literature", label: "World Literature" },
	{ slug: "americas", label: "Americas" },
	{ slug: "politics-activism", label: "Politics & Activism" },
	{
		slug: "entertainment-performing-arts",
		label: "Entertainment & Performing Arts",
	},
	{ slug: "personal-development", label: "Personal Development" },
	{ slug: "career-success", label: "Career Success" },
	{ slug: "paranormal", label: "Paranormal" },
	{ slug: "computers-technology", label: "Computers & Technology" },
	{ slug: "money-finance", label: "Money & Finance" },
	{ slug: "sports-outdoors", label: "Sports & Outdoors" },
	{ slug: "drama-plays", label: "Drama & Plays" },
	{ slug: "new-zealand-oceania", label: "New Zealand & Oceania" },
	{ slug: "art-literature", label: "Art & Literature" },
	{ slug: "sports", label: "Sports" },
	{ slug: "australia", label: "Australia" },
	{ slug: "management-leadership", label: "Management & Leadership" },
	{
		slug: "entertainment-celebrities",
		label: "Entertainment & Celebrities",
	},
	{ slug: "social-sciences", label: "Social Sciences" },
	{ slug: "travel-tourism", label: "Travel & Tourism" },
	{ slug: "history-culture", label: "History & Culture" },
	{ slug: "spirituality", label: "Spirituality" },
	{ slug: "education", label: "Education" },
	{ slug: "historical-fiction", label: "Historical Fiction" },
	{ slug: "politics-government", label: "Politics & Government" },
	{ slug: "featured", label: "Featured" },
	{ slug: "animals-nature", label: "Animals & Nature" },
	{ slug: "home-garden", label: "Home & Garden" },
	{ slug: "comedy-humor", label: "Comedy & Humor" },
	{ slug: "biographies", label: "Biographies" },
	{
		slug: "content-creation-social-media",
		label: "Content Creation & Social Media",
	},
];

const CATEGORY_SLUGS = new Set(CATEGORIES.map((c) => c.slug));

// First path segments that are never book slugs (used by handleUrl).
const NON_ENTRY_SEGMENTS = new Set([
	"author",
	"category",
	"community",
	"contact",
	"external-link",
	"faq",
	"faqs",
	"feed",
	"home-1",
	"narrator",
	"page",
	"search-audiobook",
	"signin",
	"signup",
	"story-author",
	"tag",
	"wp-content",
	"wp-json",
	"wp-login.php",
	"xmlrpc.php",
]);

function abs(href: string): string {
	if (!href) return href;
	if (href.startsWith("http")) return href;
	return BASE + (href.startsWith("/") ? href : `/${href}`);
}

function link(url: string, header?: { [key: string]: string }): Link {
	return header ? { url, header } : { url, header: null };
}

/** Extract the path portion of a URL without relying on the `URL` global. */
function pathOf(url: string): string {
	const proto = url.indexOf("://");
	let rest = url;
	if (proto >= 0) {
		rest = url.slice(proto + 3); // after "https://"
		const slash = rest.indexOf("/");
		rest = slash >= 0 ? rest.slice(slash) : "";
	}
	const q = rest.search("[?#]");
	if (q >= 0) rest = rest.slice(0, q);
	return rest;
}

/** Pull the post slug (id.uid) out of a book-card URL. */
function slugFromUrl(url: string): string {
	const parts = pathOf(url).split("/").filter(Boolean);
	return parts[0] ?? url;
}

/** Percent-encode an encrypted track blob so it is safe in a query string. */
function encodeEncrypted(value: string): string {
	let out = "";
	for (const ch of value) {
		if (ch === "+") out += "%2B";
		else if (ch === "/") out += "%2F";
		else if (ch === "=") out += "%3D";
		else out += ch;
	}
	return out;
}

/** Best cover URL from a lazy-loaded tagDiv card image. */
function cardImageUrl(img: DionElement | undefined): string | null {
	if (!img) return null;
	// <img class="entry-thumb" data-src="..." data-srcset="...">
	const dataSrc = img.attr("data-src");
	if (dataSrc) return abs(dataSrc);
	// <span class="entry-thumb td-thumb-css" data-bg="...">
	const dataBg = img.attr("data-bg");
	if (dataBg) return abs(dataBg);
	// data-srcset holds "url width" pairs; prefer the largest.
	const srcset = img.attr("data-srcset");
	if (srcset) {
		const urls = srcset
			.split(",")
			.map((part) => part.trim().split(/\s+/)[0] ?? "")
			.filter((u) => u && !u.startsWith("data:"));
		const last = urls[urls.length - 1];
		if (last) return abs(last);
	}
	const src = img.attr("src");
	if (src && !src.startsWith("data:")) return abs(src);
	return null;
}

function parseBookCard(card: DionElement): Entry | null {
	const anchor =
		card.select(new CSSSelector("h3.entry-title a")).first ??
		card.select(new CSSSelector(".entry-title a")).first ??
		card.select(new CSSSelector("a[rel=bookmark]")).first;
	const href = anchor?.attr("href");
	const title = anchor?.text?.trim();
	if (!href || !title) return null;

	// Note: some tagDiv cards render the thumb as a CSS-background
	// `<span class="entry-thumb td-thumb-css">` instead of an `<img>`; the
	// `.entry-thumb` class selector matches both variants.
	const img =
		card.select(new CSSSelector(".entry-thumb")).first ??
		card.select(new CSSSelector(".td-module-thumb img")).first;
	const cover = cardImageUrl(img);

	return {
		id: { uid: slugFromUrl(href) },
		url: abs(href),
		title,
		media_type: "Audio",
		cover: cover ? link(cover) : null,
		author: null,
		rating: null,
		views: null,
		length: null,
	};
}

/** Parse a listing page (category archive or search results). */
function parseListing(doc: DionElement, body: string): EntryList {
	// Search pages render the loop inside .td-ss-main-content; category
	// archives use the Newspaper 12 .tdb_loop. The card markup is identical.
	let cards = doc.select(
		new CSSSelector(".td-ss-main-content .td_module_wrap"),
	);
	if (cards.length === 0) {
		cards = doc.select(new CSSSelector(".tdb_loop .td_module_wrap"));
	}

	const content = cards
		.map((card) => parseBookCard(card))
		.filter((e): e is Entry => e !== null);

	// The category pagination nav (a.next.page-numbers) is injected by an
	// inline script, so it is only detectable on the raw HTML body.
	const hasnext = body.includes("next page-numbers");

	return { content, hasnext };
}

/** One `.simp-playlist` track: display name + encrypted (or plain) source. */
interface PlaylistTrack {
	name: string;
	src: string;
}

/** Parse the simple-audio-player playlist into tracks. */
function parsePlaylist(doc: DionElement): PlaylistTrack[] {
	const items = doc.select(
		new CSSSelector(".simp-playlist li span.simp-source"),
	);
	const tracks: PlaylistTrack[] = [];
	for (let i = 0; i < items.length; i++) {
		const el = items.get(i);
		if (!el) continue;
		const src = el.attr("data-src");
		if (!src) continue;
		const name = el.text?.trim();
		tracks.push({ name: name || `Track ${i + 1}`, src });
	}
	return tracks;
}

/** Decrypt a track's data-src into a playable audio URL. */
async function resolveTrackSrc(src: string, referer: string): Promise<string> {
	// The player only routes base64-looking blobs through decrypt.php; plain
	// URLs are used as-is.
	if (!src.startsWith("http")) {
		const res = await fetch(`${DECRYPT_URL}${encodeEncrypted(src)}`, {
			headers: { Referer: referer },
		});
		const decrypted = res.body.trim();
		if (!decrypted.startsWith("http")) {
			throw new Error("Failed to decrypt audio source");
		}
		return decrypted;
	}
	return src;
}

/** Map the site's status text to a ReleaseStatus. */
function parseStatus(
	text: string | null,
): "Releasing" | "Complete" | "Unknown" {
	const v = text?.trim().toLowerCase() ?? "";
	if (v.startsWith("complete")) return "Complete";
	if (v.startsWith("ongoing") || v.startsWith("releasing")) return "Releasing";
	return "Unknown";
}

/** "45 hrs and 30 mins" / "9 hrs" / "30 mins" -> seconds; null when absent. */
function parseListeningTime(text: string | null): number | null {
	if (!text) return null;
	const lower = text.toLowerCase();
	let seconds: number | null = null;
	const hrs = lower.match(/(\d+)\s*(?:hrs?|hours?)/);
	if (hrs?.[1]) seconds = (seconds ?? 0) + Number.parseInt(hrs[1], 10) * 3600;
	const mins = lower.match(/(\d+)\s*(?:mins?|minutes?)/);
	if (mins?.[1]) seconds = (seconds ?? 0) + Number.parseInt(mins[1], 10) * 60;
	if (seconds === null) return null;
	// The host expects an i32; `| 0` keeps the value on the integer path so it
	// does not cross the JS<->Rust boundary as a float.
	return seconds | 0;
}

/** Find the metadata-box span for a label ("Author", "Listening Time", ...). */
function findMetaSpan(
	doc: DionElement,
	label: string,
): DionElement | undefined {
	const spans = doc.select(new CSSSelector("span"));
	for (let i = 0; i < spans.length; i++) {
		const span = spans.get(i);
		if (!span) continue;
		const text = span.text?.trim() ?? "";
		if (text.toLowerCase().startsWith(`${label.toLowerCase()}:`)) {
			return span;
		}
	}
	return undefined;
}

/** Collect the link texts of a metadata span ("Author: A, B" -> ["A", "B"]). */
function metaSpanLinks(span: DionElement | undefined): string[] {
	if (!span) return [];
	return span
		.select(new CSSSelector("a"))
		.map((a) => a.text?.trim() ?? "")
		.filter((t) => t.length > 0);
}

/** Build the extra-info UI shown under the entry details. */
function buildInfoUi(rows: (string | null)[]): ReturnType<typeof Column> {
	return Column(
		...rows.filter((r): r is string => r !== null).map((r) => Text(r)),
	);
}

export default class extends DionExtension implements SourceProvider {
	settings = {};
	searchSettings = {
		category: defineStoreSetting<string>("category", {
			default: "science-fiction-fantasy-1",
			label: "Browse category",
			ui: new Dropdown(
				CATEGORIES.map((c) => ({ value: c.slug, label: c.label })),
			),
		}),
	};

	accounts = {};
	entrySettings = {};

	async onEvent(_data: EventData): Promise<EventResult | undefined> {
		return undefined;
	}

	async browse(
		page: number,
		settings: Record<string, Setting>,
	): Promise<EntryListResult> {
		const store = this.convertSettingStore(settings);
		const slug = this.searchSettings.category.get(store);
		// Host is 0-indexed; the site is 1-indexed.
		const n = page + 1;
		const url = n > 1 ? `${BASE}/${slug}/page/${n}/` : `${BASE}/${slug}/`;
		const res = await fetch(url);
		return {
			entries: parseListing(parseHtml(res.body), res.body),
			settings: store.toMap(),
		};
	}

	async search(
		page: number,
		filter: string,
		settings: Record<string, Setting>,
	): Promise<EntryListResult> {
		const store = this.convertSettingStore(settings);
		const n = page + 1;
		const query = encodeURIComponent(filter ?? "");
		const url =
			n > 1 ? `${BASE}/?s=${query}&paged=${n}` : `${BASE}/?s=${query}`;
		const res = await fetch(url);
		const list = parseListing(parseHtml(res.body), res.body);
		// Search pages carry no pagination nav; a full page implies more.
		if (!list.hasnext) {
			list.hasnext = list.content.length >= SEARCH_RESULTS_PER_PAGE;
		}
		return { entries: list, settings: store.toMap() };
	}

	async detail(
		entryid: EntryId,
		settings: Record<string, Setting>,
	): Promise<EntryDetailedResult> {
		const slug = entryid.uid;
		const url = `${BASE}/${slug}/`;
		const res = await fetch(url);
		const doc = parseHtml(res.body);

		const title =
			doc.select(new CSSSelector("h1.tdb-title-text")).first?.text?.trim() ??
			slug;

		// Metadata box: "Label: value" spans (value often a list of links).
		const authors = metaSpanLinks(findMetaSpan(doc, "author"));
		const narrators = metaSpanLinks(findMetaSpan(doc, "narrator"));
		const series = metaSpanLinks(findMetaSpan(doc, "series"))[0] ?? null;
		const genre = metaSpanLinks(findMetaSpan(doc, "genre"))[0] ?? null;
		const status = parseStatus(
			findMetaSpan(doc, "status")?.text?.split(":")[1] ?? null,
		);
		const version =
			findMetaSpan(doc, "version")?.text?.split(":")[1]?.trim() ?? null;
		const listeningTime =
			findMetaSpan(doc, "listening time")
				?.text?.split(":")
				.slice(1)
				.join(":")
				.trim() ?? null;

		// Description: review paragraphs under .td-post-content.
		const paragraphs = doc
			.select(new CSSSelector(".td-post-content p"))
			.map((p) => p.text?.trim() ?? "")
			.filter((t) => t.length > 0);
		const description = paragraphs.join("\n\n");

		// Full-size cover from og:image, falling back to the player thumbnail.
		const ogImage =
			doc
				.select(new CSSSelector('meta[property="og:image"]'))
				.first?.attr("content") ?? "";
		const playerCover = doc
			.select(new CSSSelector("#simp"))
			.first?.attr("data-cover");
		const cover = ogImage || playerCover || null;

		// Tracks: episode uid encodes the playlist index for `source()`.
		const tracks = parsePlaylist(doc);
		const episodes: Episode[] = tracks.map((track, i) => ({
			id: { uid: `${slug}#${i}` },
			name: track.name,
			description: null,
			url,
			cover: null,
			timestamp: null,
		}));

		const ui = buildInfoUi([
			narrators.length > 0 ? `Narrated by ${narrators.join(", ")}` : null,
			series ? `Series: ${series}` : null,
			version ? `Version: ${version}` : null,
			listeningTime ? `Listening time: ${listeningTime}` : null,
		]);

		const entry: EntryDetailed = {
			id: entryid,
			url,
			titles: [title],
			media_type: "Audio",
			status,
			description,
			language: "en",
			author: authors.length > 0 ? authors : null,
			cover: cover ? link(cover) : null,
			genres: genre ? [genre] : null,
			episodes,
			length: parseListeningTime(listeningTime),
			rating: null,
			views: null,
			poster: null,
			ui,
			meta: null,
		};

		return { entry, settings };
	}

	async source(
		epid: EpisodeId,
		settings: Record<string, Setting>,
	): Promise<SourceResult> {
		const hash = epid.uid.lastIndexOf("#");
		const slug = hash < 0 ? epid.uid : epid.uid.slice(0, hash);
		const index =
			hash < 0 ? 0 : Number.parseInt(epid.uid.slice(hash + 1), 10) || 0;

		const url = `${BASE}/${slug}/`;
		const res = await fetch(url);
		const doc = parseHtml(res.body);
		const tracks = parsePlaylist(doc);

		const track = tracks[index];
		if (!track) {
			throw new Error(`No audio track ${index} found for ${slug}`);
		}

		const audioUrl = await resolveTrackSrc(track.src, url);

		return {
			source: {
				type: "Audio",
				chapters: null,
				sources: [
					{
						name: track.name,
						lang: "en",
						url: link(audioUrl, { Referer: REFERER }),
					},
				],
			},
			settings,
		};
	}

	async handleUrl(url: string): Promise<boolean> {
		// Deep links look like https://audiobooks4soul.com/<slug>/ and are not
		// taxonomy/archive/utility pages. Parse the host without the `URL` global.
		const proto = url.indexOf("://");
		if (proto < 0) return false;
		const afterProto = url.slice(proto + 3);
		const slash = afterProto.indexOf("/");
		const host = (
			slash >= 0 ? afterProto.slice(0, slash) : afterProto
		).toLowerCase();
		if (
			host !== "audiobooks4soul.com" &&
			!host.endsWith(".audiobooks4soul.com")
		) {
			return false;
		}
		const parts = pathOf(url).split("/").filter(Boolean);
		if (parts.length === 0) return false;
		const first = parts[0] ?? "";
		if (NON_ENTRY_SEGMENTS.has(first)) return false;
		if (CATEGORY_SLUGS.has(first)) return false;
		return true;
	}
}
