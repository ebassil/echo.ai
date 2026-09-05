import { createHash } from 'crypto';

export function computeContentHash(title: string, body: string): string {
	const normalizedTitle = (title ?? '').trim().normalize('NFC');
	const normalizedBody = (body ?? '').normalize('NFC');
	const input = `${normalizedTitle}\n${normalizedBody}`;
	return sha256Hex(input);
}

export function sha256Hex(input: string): string {
	return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function hashNote(note: { title: string; body?: string | null }): string {
	return computeContentHash(note.title ?? '', note.body ?? '');
}
