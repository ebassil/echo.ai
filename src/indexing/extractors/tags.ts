import joplin from 'api';

export interface JoplinTag {
	id: string;
	title: string;
	updated_time?: number;
	created_time?: number;
}

export async function fetchTagsForNote(noteId: string): Promise<JoplinTag[]> {
	try {
		// Joplin data API: GET /notes/:id/tags
		const result: any = await (joplin as any).data.get(['notes', noteId, 'tags']);
		if (!result) return [];
		// Paginated response has items
		if (Array.isArray(result.items)) return result.items as JoplinTag[];
		if (Array.isArray(result)) return result as JoplinTag[];
		return [];
	} catch {
		return [];
	}
}

export async function fetchAllTags(): Promise<JoplinTag[]> {
	try {
		const all: JoplinTag[] = [];
		let page = 1;
		while (true) {
			const result: any = await (joplin as any).data.get(['tags'], { page, limit: 100 });
			const items: JoplinTag[] = result.items ?? result ?? [];
			all.push(...items);
			if (!result.has_more) break;
			page++;
		}
		return all;
	} catch {
		return [];
	}
}
