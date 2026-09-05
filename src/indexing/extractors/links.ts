export interface WikiLink {
	raw: string;
	target: string;
	alias: string | null;
	index: number;
}

export interface WikiLinkExtraction {
	links: WikiLink[];
	unresolved: WikiLink[];
}

const WIKI_LINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

// Extract wiki-links from markdown body. Returns all matches with target/alias.
export function extractWikiLinks(body: string): WikiLink[] {
	const links: WikiLink[] = [];
	let match: RegExpExecArray | null;
	// Reset lastIndex
	WIKI_LINK_RE.lastIndex = 0;
	while ((match = WIKI_LINK_RE.exec(body)) !== null) {
		const raw = match[0];
		const target = (match[1] ?? '').trim();
		const alias = match[2] != null ? match[2].trim() : null;
		if (target.length === 0) continue;
		links.push({
			raw,
			target,
			alias,
			index: match.index,
		});
	}
	return links;
}

// Helper to dedupe by lowercased target
export function dedupeLinks(links: WikiLink[]): WikiLink[] {
	const seen = new Set<string>();
	const result: WikiLink[] = [];
	for (const link of links) {
		const key = link.target.toLocaleLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(link);
	}
	return result;
}

export function countUnresolved(links: WikiLink[], resolvedTargets: Set<string>): number {
	let count = 0;
	for (const link of links) {
		if (!resolvedTargets.has(link.target.toLocaleLowerCase())) count++;
	}
	return count;
}
