import { randomUUID } from 'crypto';

export type ChatRole = 'system' | 'user' | 'assistant';

export interface RetrievalToggles {
	bm25: boolean;
	tfidf: boolean;
	fuzzy: boolean;
	dense: boolean;
	graph: boolean;
	graphEnabled: boolean;
}

export interface Citation {
	index: number;
	noteId: string;
	title: string;
}

export interface ConversationRecord {
	id: string;
	title: string | null;
	model: string;
	systemPrompt: string;
	notesOn: boolean;
	retrievalToggles: RetrievalToggles;
	createdAt: string;
	updatedAt: string;
}

export interface ConversationMessageRecord {
	id: string;
	role: ChatRole;
	content: string;
	citations: Citation[];
	createdAt: string;
	seq: number;
}

export interface AppendMessageInput {
	role: ChatRole;
	content: string;
	citations?: Citation[];
}

export interface UpdateConversationFields {
	title?: string | null;
	model?: string;
	systemPrompt?: string;
	notesOn?: boolean;
	retrievalToggles?: RetrievalToggles;
}

export const DEFAULT_RETRIEVAL_TOGGLES: RetrievalToggles = {
	bm25: true,
	tfidf: true,
	fuzzy: true,
	dense: true,
	graph: true,
	graphEnabled: true,
};

export interface DbLike {
	run(sql: string, params?: any[]): Promise<void>;
	all<T>(sql: string, params?: any[]): Promise<T[]>;
}

export class ConversationStore {
	constructor(private readonly db: DbLike) {}

	async createConversation(input: {
		model: string;
		systemPrompt: string;
		notesOn?: boolean;
		retrievalToggles?: RetrievalToggles;
		title?: string | null;
	}): Promise<ConversationRecord> {
		const id = randomUUID();
		const now = new Date().toISOString();
		const notesOn = input.notesOn !== false;
		const toggles = input.retrievalToggles ?? DEFAULT_RETRIEVAL_TOGGLES;

		await this.db.run(
			`INSERT INTO conversations (id, title, model, system_prompt, notes_on, retrieval_toggles, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[id, input.title ?? null, input.model, input.systemPrompt, notesOn ? 1 : 0, JSON.stringify(toggles), now, now],
		);

		return {
			id,
			title: input.title ?? null,
			model: input.model,
			systemPrompt: input.systemPrompt,
			notesOn,
			retrievalToggles: toggles,
			createdAt: now,
			updatedAt: now,
		};
	}

	async listConversations(): Promise<ConversationRecord[]> {
		const rows = await this.db.all<any>('SELECT * FROM conversations ORDER BY updated_at DESC');
		return rows.map(mapConversationRow);
	}

	async getConversation(id: string): Promise<ConversationRecord | null> {
		const rows = await this.db.all<any>('SELECT * FROM conversations WHERE id = ?', [id]);
		return rows.length > 0 ? mapConversationRow(rows[0]) : null;
	}

	async updateConversation(id: string, fields: UpdateConversationFields): Promise<void> {
		const sets: string[] = [];
		const params: any[] = [];

		if (fields.title !== undefined) {
			sets.push('title = ?');
			params.push(fields.title);
		}
		if (fields.model !== undefined) {
			sets.push('model = ?');
			params.push(fields.model);
		}
		if (fields.systemPrompt !== undefined) {
			sets.push('system_prompt = ?');
			params.push(fields.systemPrompt);
		}
		if (fields.notesOn !== undefined) {
			sets.push('notes_on = ?');
			params.push(fields.notesOn ? 1 : 0);
		}
		if (fields.retrievalToggles !== undefined) {
			sets.push('retrieval_toggles = ?');
			params.push(JSON.stringify(fields.retrievalToggles));
		}
		if (sets.length === 0) return;

		sets.push('updated_at = ?');
		params.push(new Date().toISOString(), id);

		await this.db.run(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ?`, params);
	}

	async deleteConversation(id: string): Promise<void> {
		await this.db.run('DELETE FROM conversations WHERE id = ?', [id]);
	}

	async appendMessage(conversationId: string, message: AppendMessageInput): Promise<ConversationMessageRecord> {
		const id = randomUUID();
		const now = new Date().toISOString();
		const citations = message.citations ?? [];
		const seq = await this.nextSeq(conversationId);

		await this.db.run(
			`INSERT INTO conversation_messages (id, conversation_id, role, content, citations, created_at, seq)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[id, conversationId, message.role, message.content, JSON.stringify(citations), now, seq],
		);
		await this.db.run('UPDATE conversations SET updated_at = ? WHERE id = ?', [now, conversationId]);

		return { id, role: message.role, content: message.content, citations, createdAt: now, seq };
	}

	async listMessages(conversationId: string): Promise<ConversationMessageRecord[]> {
		const rows = await this.db.all<any>(
			'SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY seq ASC',
			[conversationId],
		);
		return rows.map(mapMessageRow);
	}

	async replaceMessage(conversationId: string, seq: number, message: { content: string; citations?: Citation[] }): Promise<void> {
		await this.db.run(
			'UPDATE conversation_messages SET content = ?, citations = ?, created_at = ? WHERE conversation_id = ? AND seq = ?',
			[message.content, JSON.stringify(message.citations ?? []), new Date().toISOString(), conversationId, seq],
		);
	}

	async deleteMessage(conversationId: string, seq: number): Promise<void> {
		await this.db.run('DELETE FROM conversation_messages WHERE conversation_id = ? AND seq = ?', [conversationId, seq]);
	}

	private async nextSeq(conversationId: string): Promise<number> {
		const rows = await this.db.all<{ m: number | null }>(
			'SELECT MAX(seq) AS m FROM conversation_messages WHERE conversation_id = ?',
			[conversationId],
		);
		return (rows[0]?.m ?? 0) + 1;
	}
}

export function mapConversationRow(row: any): ConversationRecord {
	let toggles: RetrievalToggles = DEFAULT_RETRIEVAL_TOGGLES;
	try {
		toggles = { ...DEFAULT_RETRIEVAL_TOGGLES, ...JSON.parse(row.retrieval_toggles ?? '{}') };
	} catch {}

	return {
		id: row.id,
		title: row.title ?? null,
		model: row.model,
		systemPrompt: row.system_prompt,
		notesOn: row.notes_on !== 0,
		retrievalToggles: toggles,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export function mapMessageRow(row: any): ConversationMessageRecord {
	let citations: Citation[] = [];
	try {
		citations = JSON.parse(row.citations ?? '[]');
	} catch {}

	return {
		id: row.id,
		role: row.role as ChatRole,
		content: row.content,
		citations,
		createdAt: row.created_at,
		seq: row.seq,
	};
}