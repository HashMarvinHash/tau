// Dion extension for pawchive.pw — an archive of creator posts (Patreon/Fanbox/etc.).
//
// Data model mapping (per the extension's purpose):
//   Creator => Entry        (browse/search lists creators)
//   Post    => Episode      (a creator's posts become episodes)
//
// API (base: https://pawchive.pw/api/v1):
//   GET /creators                                 — every creator in one giant array
//   GET /{service}/user/{creator_id}              — a creator's posts (offset stepping of 50)
//   GET /{service}/user/{creator_id}/profile      — creator metadata (name, favorites)
//   GET /{service}/user/{creator_id}/post/{id}    — a single post (content + attachments)
//
// Media is served from a separate image host:
//   full:       https://img.pawchive.pw/data{path}
//   thumbnail:  https://img.pawchive.pw/thumbnail/data{path}
// (the API returns relative `path`s like "/ef/a1/efa1ac9f...png").
//
// A post's source is a Paragraphlist: the post's HTML text content is converted to
// paragraphs, then every attached image is appended at the bottom as a CustomUI Image.
//
// refresh() fetches only the newest listing page (one request) and compares it with
// the host's cached episodes; when nothing changed the entry is returned untouched,
// otherwise the creator's scraped caches are dropped and detail() rebuilds fully.

import { DionExtension } from "@dion-js/runtime-lib";
import { Dropdown, SettingStore } from "@dion-js/runtime-lib/settings.js";
import { Image } from "@dion-js/runtime-lib/ui.js";
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
	Setting,
	SourceResult,
} from "@dion-js/runtime-types/runtime";
import { fetch } from "network";
import { parseHtml, parseHtmlFragment } from "parse";

const SITE = "https://pawchive.pw";
const API = "https://pawchive.pw/api/v1";
const IMG = "https://img.pawchive.pw";

// /creators returns everything at once (no server-side pagination), so we paginate the
// cached array client-side.
const PAGE_SIZE = 50;

// Per-entry setting id for the tag filter dropdown.
const TAG_SETTING = "tag";

interface TagInfo {
	tag: string;
	count: number;
}

interface PawchiveFile {
	name?: string | null;
	path?: string | null;
}

interface PawchivePost {
	id: string;
	user?: string | null;
	service?: string | null;
	title?: string | null;
	content?: string | null;
	substring?: string | null;
	published?: string | null;
	added?: string | null;
	file?: PawchiveFile | null;
	attachments?: PawchiveFile[] | null;
}

interface PawchiveCreator {
	id: string;
	name: string;
	service: string;
	favorited?: number | null;
	ever_imported?: boolean | null;
}

interface PawchiveProfile {
	id: string;
	name?: string | null;
	service?: string | null;
	kemono_favorited?: number | null;
	ever_imported?: boolean | null;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function link(url: string): Link {
	return { url, header: null };
}

/** Full-size image URL from a Pawchive attachment `path` ("/ab/cd/abcd....png"). */
function fullUrl(path: string): string {
	return `${IMG}/thumbnail/data${path}`;
}

/** Thumbnail image URL from a Pawchive attachment `path`. */
function thumbnailUrl(path: string): string {
	return `${IMG}/thumbnail/data${path}`;
}

function isImage(name: string | null | undefined): boolean {
	return /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(name ?? "");
}

/** First image path on a post: the `file` (hero) if present, else the first attachment. */
function firstImagePath(post: PawchivePost): string | null {
	if (post.file?.path && isImage(post.file.name ?? post.file.path)) {
		return post.file.path;
	}
	for (const a of post.attachments ?? []) {
		if (a.path && isImage(a.name ?? a.path)) return a.path;
	}
	return null;
}

/** All image paths on a post (hero `file` first, then attachments), de-duplicated. */
function collectImagePaths(post: PawchivePost): string[] {
	const paths: string[] = [];
	const seen = new Set<string>();
	const push = (f: PawchiveFile | null | undefined): void => {
		if (f?.path && !seen.has(f.path) && isImage(f.name ?? f.path)) {
			seen.add(f.path);
			paths.push(f.path);
		}
	};
	push(post.file);
	for (const a of post.attachments ?? []) push(a);
	return paths;
}

/** Plain-text snippet from HTML, for episode descriptions. */
function plainSnippet(
	html: string | null | undefined,
	max = 200,
): string | null {
	if (!html || !html.trim()) return null;
	const doc = parseHtml(`<html><body><div id="c">${html}</div></body></html>`);
	const text = (doc.select(new CSSSelector("#c")).first?.text ?? "").trim();
	if (!text) return null;
	return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

/** Parse the /tags page's `#tag-container` into {tag, count} pairs. */
function parseTags(html: string): TagInfo[] {
	const doc = parseHtml(html);
	const rows = doc.select(new CSSSelector("#tag-container article a"));
	const tags: TagInfo[] = [];
	for (let i = 0; i < rows.length; i++) {
		const a = rows.get(i);
		if (!a) continue;
		const spans = a.select(new CSSSelector("span"));
		const name = (spans.get(0)?.text ?? "").trim();
		if (!name) continue;
		const count = Number.parseInt((spans.get(1)?.text ?? "0").trim(), 10);
		tags.push({ tag: name, count: Number.isNaN(count) ? 0 : count });
	}
	return tags;
}

/** Parse `article.post-card` elements from a tag-filtered listing page into Episodes.
 *  The filtered HTML only exposes id/title/timestamp; full content is fetched per-post
 *  in `source()` via the API. */
function parsePostCards(
	html: string,
	service: string,
	creatorId: string,
): Episode[] {
	const doc = parseHtml(html);
	const cards = doc.select(new CSSSelector("article.post-card"));
	const episodes: Episode[] = [];
	for (let i = 0; i < cards.length; i++) {
		const card = cards.get(i);
		if (!card) continue;
		const postId = card.attr("data-id").trim();
		if (!postId) continue;
		const title =
			(
				card.select(new CSSSelector(".post-card__header")).first?.text ?? ""
			).trim() || "Untitled";
		const time =
			(
				card
					.select(new CSSSelector("time.timestamp"))
					.first?.attr("datetime") ?? ""
			).trim() || null;
		episodes.push({
			id: { uid: postUid(service, creatorId, postId) },
			name: title,
			url: postUrl(service, creatorId, postId),
			description: null,
			cover: null,
			timestamp: time,
		});
	}
	return episodes;
}

/** Encode a tag name for the `?tag=` query param, matching the site's `+`-for-space style. */
function encodeTagParam(tag: string): string {
	return encodeURIComponent(tag).replace(/%20/g, "+");
}

// Episode identity fields, shared by the builders and refresh()'s comparison
// so both always agree on what identifies a post.

function postUid(service: string, creatorId: string, postId: string): string {
	return `${service}/${creatorId}/${postId}`;
}

function postUrl(service: string, creatorId: string, postId: string): string {
	return `${SITE}/${service}/user/${creatorId}/post/${postId}`;
}

function postTitle(p: PawchivePost): string {
	return p.title?.trim() || "Untitled";
}

function postTimestamp(p: PawchivePost): string | null {
	return p.published ?? p.added ?? null;
}

/** Map a creator record to a browse/search Entry. */
function creatorToEntry(c: PawchiveCreator): Entry {
	return {
		id: { uid: `${c.service}/${c.id}` },
		url: `${SITE}/${c.service}/user/${c.id}`,
		title: c.name || c.id,
		media_type: "Unknown",
		cover: link(`https://pawchive.pw/icons/${c.service}/${c.id}`),
		author: null,
		rating: null,
		views: null,
		length: null,
	};
}

/** Map a post record to an Episode. */
function postToEpisode(
	p: PawchivePost,
	service: string,
	creatorId: string,
): Episode {
	const cover = firstImagePath(p);
	return {
		id: { uid: postUid(service, creatorId, p.id) },
		name: postTitle(p),
		url: postUrl(service, creatorId, p.id),
		description: plainSnippet(p.content ?? p.substring),
		cover: cover ? link(thumbnailUrl(cover)) : null,
		timestamp: postTimestamp(p),
	};
}

/** Canonicalize a timestamp for equality checks: naive date-times (no zone
 *  offset) are treated as UTC, matching how the runtime normalizes episode
 *  timestamps it hands back, so freshly fetched values compare equal to
 *  host-normalized ones. */
function canonicalTimestamp(ts: Episode["timestamp"]): string | null {
	if (ts === null || ts === undefined || ts === "") return null;
	const raw = typeof ts === "object" ? ts.toJSON() : String(ts);
	const withZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw}Z`;
	const epoch = Date.parse(withZone);
	return Number.isNaN(epoch) ? raw : new Date(epoch).toISOString();
}

/** True when `candidates` (a newest-first listing page) still matches the host's
 *  cached episodes: every uid must exist with the same name and timestamp. A short
 *  candidate list is the complete listing, so the counts must also match; a full
 *  page cannot verify older posts and only compares the page itself. */
function listingUnchanged(candidates: Episode[], cached: Episode[]): boolean {
	if (cached.length === 0 || candidates.length === 0) return false;
	if (candidates.length < PAGE_SIZE && candidates.length !== cached.length)
		return false;
	const byUid = new Map(cached.map((e) => [e.id.uid, e] as const));
	return candidates.every((c) => {
		const old = byUid.get(c.id.uid);
		return (
			old !== undefined &&
			old.name === c.name &&
			canonicalTimestamp(old.timestamp) === canonicalTimestamp(c.timestamp)
		);
	});
}

/** Build the Paragraphlist contents for a post: text first, images at the bottom. */
function buildPostParagraphs(post: PawchivePost): Paragraph[] {
	const out: Paragraph[] = [];
	if (post.content) {
		for (const p of parseHtmlFragment(post.content).paragraphs) out.push(p);
	}
	for (const path of collectImagePaths(post)) {
		out.push({
			type: "CustomUI",
			ui: Image(link(fullUrl(path))),
		});
	}
	if (out.length === 0)
		out.push({
			type: "Text",
			content: "This post has no content.",
			style: null,
		});
	return out;
}

// ---------------------------------------------------------------------------
// extension
// ---------------------------------------------------------------------------

export default class extends DionExtension implements SourceProvider {
	settings = {};
	accounts = {};
	entrySettings = {};

	// /creators is huge (~11MB) and unpaginated; cache it for the instance lifetime.
	private creatorsCache: PawchiveCreator[] | null = null;
	// Per-creator scraped tags (uid -> tags), and per-creator+tag scraped post lists.
	private tagsCache = new Map<string, TagInfo[]>();
	private taggedEpisodesCache = new Map<string, Episode[]>();

	/** Fetch the full creator list once, filtered to creators with archived content,
	 *  sorted by favorites (most popular first). */
	private async getCreators(): Promise<PawchiveCreator[]> {
		if (this.creatorsCache) return this.creatorsCache;
		const res = await fetch(`${API}/creators`);
		const all = (res.json as PawchiveCreator[] | undefined) ?? [];
		const filtered = all.filter((c) => c.ever_imported === true);
		filtered.sort((a, b) => (b.favorited ?? 0) - (a.favorited ?? 0));
		this.creatorsCache = filtered;
		return filtered;
	}

	async browse(
		page: number,
		settings: Record<string, Setting>,
	): Promise<EntryListResult> {
		const all = await this.getCreators();
		const start = page * PAGE_SIZE;
		const content = all.slice(start, start + PAGE_SIZE).map(creatorToEntry);
		return {
			entries: {
				content,
				hasnext: start + PAGE_SIZE < all.length,
				length: content.length,
			},
			settings,
		};
	}

	async search(
		page: number,
		filter: string,
		settings: Record<string, Setting>,
	): Promise<EntryListResult> {
		const q = filter.trim().toLowerCase();
		if (!q) throw new Error("Search query is empty.");
		const all = await this.getCreators();
		const matched = all.filter((c) => c.name?.toLowerCase().includes(q));
		const start = page * PAGE_SIZE;
		const content = matched.slice(start, start + PAGE_SIZE).map(creatorToEntry);
		return {
			entries: {
				content,
				hasnext: start + PAGE_SIZE < matched.length,
				length: content.length,
			},
			settings,
		};
	}

	async detail(
		entryid: EntryId,
		settings: Record<string, Setting>,
	): Promise<EntryDetailedResult> {
		const { service, creatorId } = parseCreatorUid(entryid.uid);
		const store = new SettingStore(settings);

		const profile = await this.fetchProfile(service, creatorId);

		// The site exposes no API for tags; scrape the /tags page to populate a
		// per-entry dropdown the user can filter the post list by.
		const tags = await this.fetchTags(service, creatorId);
		const selectedTag = store.getOrDefine<string>({
			id: TAG_SETTING,
			defaultval: "",
			label: "Filter by tag",
			visible: tags.length > 0,
			ui: new Dropdown([
				{ value: "", label: "All posts" },
				...tags.map((t) => ({
					value: t.tag,
					label: `${t.tag} (${t.count})`,
				})),
			]),
		});

		let episodes: Episode[];
		let description = buildDescription(profile, service);

		// When a tag is selected (and still exists), the API can't filter for us,
		// so we scrape the filtered HTML listing instead.
		if (selectedTag && tags.some((t) => t.tag === selectedTag)) {
			episodes = (
				await this.fetchTaggedEpisodes(service, creatorId, selectedTag)
			).toReversed();
			description += ` Filtered by tag: ${selectedTag} (${episodes.length} posts).`;
		} else {
			const posts = await this.fetchAllCreatorPosts(service, creatorId);
			episodes = posts
				.map((p) => postToEpisode(p, service, creatorId))
				.toReversed();
		}

		return {
			entry: {
				id: entryid,
				url: `${SITE}/${service}/user/${creatorId}`,
				titles: [profile?.name || creatorId],
				media_type: "Unknown",
				status: "Unknown",
				description,
				language: "en",
				author: null,
				cover: link(`https://pawchive.pw/icons/${service}/${creatorId}`),
				poster: link(`https://pawchive.pw/banners/${service}/${creatorId}`),
				genres: [service],
				rating: null,
				views: null,
				length: episodes.length,
				episodes,
				ui: null,
				meta: null,
			},
			settings: store.toMap(),
		};
	}

	/**
	 * Cheap refresh: fetch only the newest listing page (one request) and compare
	 * it with the host's cached episodes. When nothing changed, return the entry
	 * untouched; otherwise drop this creator's scraped caches and let `detail`
	 * rebuild fully. Only the episode listing is verified — profile metadata
	 * (favorites, title) is refreshed only when a post actually changed. Edits
	 * and deletions older than the newest page are only caught by the rebuild.
	 */
	async refresh(
		entry: EntryDetailed,
		settings: Record<string, Setting>,
	): Promise<EntryDetailedResult> {
		const { service, creatorId } = parseCreatorUid(entry.id.uid);
		const tag = new SettingStore(settings).tryGet<string>(TAG_SETTING) ?? "";

		try {
			if (tag) {
				const res = await fetch(
					`${SITE}/${service}/user/${creatorId}?o=0&tag=${encodeTagParam(tag)}`,
				);
				if (
					res.ok &&
					listingUnchanged(
						parsePostCards(res.body, service, creatorId),
						entry.episodes,
					)
				) {
					return { entry, settings };
				}
			} else {
				const newest = await this.fetchCreatorPosts(service, creatorId, 0);
				if (
					listingUnchanged(
						newest.map((p) => ({
							id: { uid: postUid(service, creatorId, p.id) },
							name: postTitle(p),
							url: postUrl(service, creatorId, p.id),
							timestamp: postTimestamp(p),
						})),
						entry.episodes,
					)
				) {
					return { entry, settings };
				}
			}
		} catch {
			// Fall through to a full rebuild rather than erroring the refresh.
		}

		// Drop this creator's scraped caches so the rebuild sees fresh data.
		const key = `${service}/${creatorId}`;
		this.tagsCache.delete(key);
		for (const k of [...this.taggedEpisodesCache.keys()]) {
			if (k.startsWith(`${key}?tag=`)) this.taggedEpisodesCache.delete(k);
		}
		return this.detail(entry.id, settings);
	}

	async source(
		epid: EpisodeId,
		settings: Record<string, Setting>,
	): Promise<SourceResult> {
		const { service, creatorId, postId } = parsePostUid(epid.uid);
		const res = await fetch(
			`${API}/${service}/user/${creatorId}/post/${postId}`,
		);
		const post = (res.json as PawchivePost | undefined) ?? {
			id: postId,
		};

		return {
			source: {
				type: "Paragraphlist",
				paragraphs: buildPostParagraphs(post),
				audio: null,
			},
			settings,
		};
	}

	async handleUrl(url: string): Promise<boolean> {
		const host = urlHost(url);
		if (host !== "pawchive.pw" && !host.endsWith(".pawchive.pw")) return false;
		const parts = urlPath(url).split("/").filter(Boolean);
		// /{service}/user/{creator_id}[/post/{post_id}]
		return parts.length >= 3 && parts[1] === "user";
	}

	private async fetchProfile(
		service: string,
		creatorId: string,
	): Promise<PawchiveProfile | null> {
		try {
			const res = await fetch(`${API}/${service}/user/${creatorId}/profile`);
			if (!res.ok) return null;
			return (res.json as PawchiveProfile | undefined) ?? null;
		} catch {
			return null;
		}
	}

	private async fetchCreatorPosts(
		service: string,
		creatorId: string,
		offset: number,
	): Promise<PawchivePost[]> {
		try {
			const res = await fetch(
				`${API}/${service}/user/${creatorId}?o=${offset}`,
			);
			if (!res.ok) return [];
			return (res.json as PawchivePost[] | undefined) ?? [];
		} catch {
			return [];
		}
	}

	/** Fetch all posts for a creator by paginating through every page (50 per page). */
	private async fetchAllCreatorPosts(
		service: string,
		creatorId: string,
	): Promise<PawchivePost[]> {
		const all: PawchivePost[] = [];
		let offset = 0;
		while (true) {
			const page = await this.fetchCreatorPosts(service, creatorId, offset);
			if (page.length === 0) break;
			all.push(...page);
			// fewer items than page size means this was the last page
			if (page.length < 50) break;
			offset += 50;
		}
		return all;
	}

	/** Scrape a creator's tag list from the /tags page (no API endpoint exists). */
	private async fetchTags(
		service: string,
		creatorId: string,
	): Promise<TagInfo[]> {
		const key = `${service}/${creatorId}`;
		const cached = this.tagsCache.get(key);
		if (cached) return cached;
		try {
			const res = await fetch(`${SITE}/${service}/user/${creatorId}/tags`);
			if (!res.ok) return [];
			const tags = parseTags(res.body);
			this.tagsCache.set(key, tags);
			return tags;
		} catch {
			return [];
		}
	}

	/** Scrape every post of a creator for a given tag, paging through the filtered listing. */
	private async fetchTaggedEpisodes(
		service: string,
		creatorId: string,
		tag: string,
	): Promise<Episode[]> {
		const key = `${service}/${creatorId}?tag=${tag}`;
		const cached = this.taggedEpisodesCache.get(key);
		if (cached) return cached;

		const encoded = encodeTagParam(tag);
		const episodes: Episode[] = [];
		let offset = 0;
		while (true) {
			let page: Episode[];
			try {
				const res = await fetch(
					`${SITE}/${service}/user/${creatorId}?o=${offset}&tag=${encoded}`,
				);
				if (!res.ok) break;
				page = parsePostCards(res.body, service, creatorId);
			} catch {
				break;
			}
			if (page.length === 0) break;
			episodes.push(...page);
			if (page.length < 50) break;
			offset += 50;
		}
		this.taggedEpisodesCache.set(key, episodes);
		return episodes;
	}
}

function buildDescription(
	profile: PawchiveProfile | null,
	service: string,
): string {
	if (!profile) return `Archived creator on ${service}.`;
	const fav = profile.kemono_favorited ?? null;
	return `Archived creator on ${service}.${fav != null ? ` ${fav} favorites.` : ""}`;
}

/** Parse a creator Entry uid ("{service}/{creator_id}") into its parts. */
function parseCreatorUid(uid: string): { service: string; creatorId: string } {
	const [service, creatorId] = uid.split("/");
	return { service: service ?? "", creatorId: creatorId ?? "" };
}

/** Parse a post Episode uid ("{service}/{creator_id}/{post_id}") into its parts. */
function parsePostUid(uid: string): {
	service: string;
	creatorId: string;
	postId: string;
} {
	const [service, creatorId, postId] = uid.split("/");
	return {
		service: service ?? "",
		creatorId: creatorId ?? "",
		postId: postId ?? "",
	};
}

/** Extract the host from a URL without the `URL` global. */
function urlHost(url: string): string {
	const proto = url.indexOf("://");
	let rest = proto >= 0 ? url.slice(proto + 3) : url;
	const slash = rest.indexOf("/");
	if (slash >= 0) rest = rest.slice(0, slash);
	const colon = rest.indexOf(":");
	if (colon >= 0) rest = rest.slice(0, colon);
	return rest.toLowerCase();
}

/** Extract the path of a URL without the `URL` global. */
function urlPath(url: string): string {
	const proto = url.indexOf("://");
	let rest = proto >= 0 ? url.slice(proto + 3) : url;
	const slash = rest.indexOf("/");
	rest = slash >= 0 ? rest.slice(slash) : "";
	const q = rest.search("[?#]");
	if (q >= 0) rest = rest.slice(0, q);
	return rest;
}
