import { parseMarkdownSections } from './markdown';

export interface Chunk {
	id: string;
	noteId: string;
	chunkIndex: number;
	content: string;
	tokenCount: number;
}

export interface ChunkerOptions {
	maxChars?: number;
	maxTokens?: number;
	overlapChars?: number;
	 overlapTokens?: number;
}

export const DEFAULT_CHUNKER_OPTIONS = {
	maxChars: 2000,
	maxTokens: 512,
	overlapChars: 200,
} as const;

// Rough token estimate: ~4 chars per token
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function makeChunkId(noteId: string, chunkIndex: number): string {
	return `${noteId}:${chunkIndex}`;
}

export function chunkNote(
	noteId: string,
	title: string,
	body: string,
	options: ChunkerOptions = {},
): Chunk[] {
	const maxChars = options.maxChars ?? DEFAULT_CHUNKER_OPTIONS.maxChars;
	const overlapChars = options.overlapChars ?? DEFAULT_CHUNKER_OPTIONS.overlapChars;

	// Combine title + body for chunking, but ensure title is included in first chunk
	const fullContent = title.trim().length > 0 ? `# ${title.trim()}\n\n${body ?? ''}` : (body ?? '');
	const trimmed = fullContent.trim();
	if (trimmed.length === 0) {
		// Still produce one empty-ish chunk for consistency? But spec says small notes one chunk.
		// Return empty array for empty notes; caller can handle.
		return [];
	}

	const sections = parseMarkdownSections(trimmed);

	// Merge sections respecting maxChars, preferring heading boundaries
	const rawChunks: string[] = [];
	let current = '';

	for (const section of sections) {
		const text = section.content;

		if (section.isCodeFence) {
			// Code fences are opaque: if they exceed maxChars, treat as standalone chunk(s)
			if (text.length > maxChars) {
				if (current.trim().length > 0) {
					rawChunks.push(current.trim());
					current = '';
				}
				// Split oversized code fence by maxChars without breaking mid-line if possible
				rawChunks.push(...splitByMaxChars(text, maxChars));
			} else {
				if (current.length + text.length + 2 > maxChars && current.trim().length > 0) {
					rawChunks.push(current.trim());
					current = text;
				} else {
					current = current.length > 0 ? `${current}\n\n${text}` : text;
				}
			}
			continue;
		}

		// Regular section (may be heading + content)
		if (text.length > maxChars) {
			// Section itself too large, need to split further
			if (current.trim().length > 0) {
				rawChunks.push(current.trim());
				current = '';
			}
			rawChunks.push(...splitByMaxChars(text, maxChars));
		} else {
			if (current.length + text.length + 2 > maxChars && current.trim().length > 0) {
				rawChunks.push(current.trim());
				current = text;
			} else {
				current = current.length > 0 ? `${current}\n\n${text}` : text;
			}
		}
	}

	if (current.trim().length > 0) {
		rawChunks.push(current.trim());
	}

	// Apply overlap if requested and more than one chunk
	const overlapped = overlapChars > 0 && rawChunks.length > 1 ? applyOverlap(rawChunks, overlapChars) : rawChunks;

	// Handle small note: ensures at least one chunk if content existed
	if (overlapped.length === 0 && trimmed.length > 0) {
		overlapped.push(trimmed.slice(0, maxChars));
	}

	return overlapped.map((content, index) => ({
		id: makeChunkId(noteId, index),
		noteId,
		chunkIndex: index,
		content,
		tokenCount: estimateTokens(content),
	}));
}

function splitByMaxChars(text: string, maxChars: number): string[] {
	const chunks: string[] = [];
	let remaining = text;

	while (remaining.length > maxChars) {
		// Prefer split at paragraph or line boundary
		let splitAt = remaining.lastIndexOf('\n\n', maxChars);
		if (splitAt === -1 || splitAt < maxChars * 0.5) {
			splitAt = remaining.lastIndexOf('\n', maxChars);
		}
		if (splitAt === -1 || splitAt < maxChars * 0.5) {
			splitAt = remaining.lastIndexOf(' ', maxChars);
		}
		if (splitAt === -1 || splitAt < maxChars * 0.5) {
			splitAt = maxChars;
		}
		chunks.push(remaining.slice(0, splitAt).trim());
		remaining = remaining.slice(splitAt).trim();
	}
	if (remaining.length > 0) {
		chunks.push(remaining.trim());
	}
	return chunks;
}

function applyOverlap(chunks: string[], overlapChars: number): string[] {
	if (chunks.length <= 1) return chunks;
	const result: string[] = [chunks[0]];
	for (let i = 1; i < chunks.length; i++) {
		const prev = chunks[i - 1];
		const overlap = prev.slice(Math.max(0, prev.length - overlapChars));
		// Avoid duplicating if current already starts with overlap
		let current = chunks[i];
		if (current.startsWith(overlap.trimStart().slice(0, 20)) && overlap.length > 20) {
			// Overlap already partially present, just keep as is
		} else if (overlap.trim().length > 0) {
			current = `${overlap}\n\n${current}`;
			// Ensure we don't exceed too much; trim if needed (allow slight exceed)
		}
		result.push(current);
	}
	return result;
}
