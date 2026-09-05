import joplin from 'api';

export type Scope =
	| { kind: 'note'; noteId: string }
	| { kind: 'folder'; folderId: string }
	| { kind: 'all' };

export interface JoplinNoteBrief {
	id: string;
	title: string;
	parent_id?: string | null;
	created_time?: number;
	updated_time?: number;
	body?: string;
}

async function fetchNoteById(noteId: string): Promise<JoplinNoteBrief | null> {
	try {
		const note: any = await (joplin as any).data.get(['notes', noteId], {
			fields: ['id', 'title', 'parent_id', 'created_time', 'updated_time', 'body'],
		});
		if (!note || !note.id) return null;
		return note as JoplinNoteBrief;
	} catch {
		return null;
	}
}

async function fetchAllFolderIds(): Promise<Map<string, string | null>> {
	const map = new Map<string, string | null>();
	let page = 1;
	while (true) {
		const result: any = await (joplin as any).data.get(['folders'], { page, limit: 100 });
		const items: any[] = result.items ?? result ?? [];
		for (const folder of items) {
			map.set(folder.id, folder.parent_id ?? null);
		}
		if (!result.has_more) break;
		page++;
	}
	return map;
}

async function getDescendantFolderIds(rootId: string): Promise<Set<string>> {
	const folderParentMap = await fetchAllFolderIds();
	const descendants = new Set<string>([rootId]);
	// BFS: for each folder, if its parent is in descendants, add it
	let changed = true;
	while (changed) {
		changed = false;
		for (const [folderId, parentId] of folderParentMap) {
			if (parentId && descendants.has(parentId) && !descendants.has(folderId)) {
				descendants.add(folderId);
				changed = true;
			}
		}
	}
	return descendants;
}

async function fetchNotesForFolders(folderIds: Set<string>): Promise<string[]> {
	const ids: string[] = [];
	let page = 1;
	while (true) {
		const result: any = await (joplin as any).data.get(['notes'], {
			fields: ['id', 'parent_id'],
			page,
			limit: 100,
		});
		const items: any[] = result.items ?? result ?? [];
		for (const note of items) {
			if (note.parent_id && folderIds.has(note.parent_id)) {
				ids.push(note.id);
			} else if (!note.parent_id && folderIds.has('')) {
				ids.push(note.id);
			}
		}
		if (!result.has_more) break;
		page++;
	}
	return ids;
}

export async function resolveScope(scope: Scope): Promise<string[]> {
	if (scope.kind === 'note') {
		const note = await fetchNoteById(scope.noteId);
		return note ? [note.id] : [];
	}
	if (scope.kind === 'folder') {
		const descendants = await getDescendantFolderIds(scope.folderId);
		return fetchNotesForFolders(descendants);
	}
	// all
	const ids: string[] = [];
	let page = 1;
	while (true) {
		const result: any = await (joplin as any).data.get(['notes'], {
			fields: ['id'],
			page,
			limit: 100,
		});
		const items: any[] = result.items ?? result ?? [];
		for (const note of items) ids.push(note.id);
		if (!result.has_more) break;
		page++;
	}
	return ids;
}

export async function fetchNotesPaginated(
	noteIds: string[] | null,
	options: { batchSize?: number; onPage?: (notes: JoplinNoteBrief[]) => Promise<void> } = {},
): Promise<void> {
	// If noteIds is null, page through all notes directly
	if (noteIds === null) {
		let page = 1;
		while (true) {
			const result: any = await (joplin as any).data.get(['notes'], {
				fields: ['id', 'title', 'parent_id', 'created_time', 'updated_time', 'body'],
				page,
				limit: options.batchSize ?? 100,
			});
			const items: JoplinNoteBrief[] = result.items ?? result ?? [];
			if (items.length > 0 && options.onPage) await options.onPage(items);
			if (!result.has_more) break;
			page++;
			// Yield
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		return;
	}

	// For explicit id list, fetch in batches
	const batchSize = options.batchSize ?? 20;
	for (let i = 0; i < noteIds.length; i += batchSize) {
		const batch = noteIds.slice(i, i + batchSize);
		const notes: JoplinNoteBrief[] = [];
		for (const id of batch) {
			const note = await fetchNoteById(id);
			if (note) notes.push(note);
		}
		if (options.onPage) await options.onPage(notes);
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}
