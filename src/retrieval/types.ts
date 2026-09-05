export interface Hit {
	chunkId?: string;
	noteId: string;
	title: string;
	content: string;
	score: number;
}

export type RetrieverId = 'bm25' | 'tfidf' | 'fuzzy' | 'dense' | 'graph';

export interface Retriever {
	id: RetrieverId;
	enabled: boolean;
	retrieve(query: string, options: RetrieveOptions): Promise<Hit[]>;
	unavailable?: boolean;
}

export interface RetrieveOptions {
	retrievers?: RetrieverId[];
	limit?: number;
	perNoteLimit?: number;
	tokenBudget?: number;
	graphLayer?: 'structural' | 'semantic' | 'both';
}

export interface FusedResult {
	hits: Hit[];
	retrieverScores: Record<RetrieverId, number[]>;
}

export interface RetrieveContext {
	db: any;
	provider: {
		embeddings(texts: string[]): Promise<number[][]>;
	};
	settings: RetrievalSettings;
}

export interface RetrievalSettings {
	enabledRetrievers: Record<RetrieverId, boolean>;
	denseK: number;
	tokenBudget: number;
	maxChunksPerNote: number;
	rrfK: number;
	rerankEnabled: boolean;
	rerankModel?: string;
}

export interface ChatContext {
	chunks: Array<{
		chunkId: string;
		noteId: string;
		title: string;
		content: string;
		score: number;
		contributingRetrievers: RetrieverId[];
	}>;
	totalTokens: number;
}

export interface SearchResult {
	noteId: string;
	title: string;
	chunkText: string;
	score: number;
	contributingRetrievers: RetrieverId[];
}

export interface Reranker {
	rerank(hits: Hit[], query: string): Promise<Hit[]>;
}