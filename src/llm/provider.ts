export interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface ChatOptions {
	temperature?: number;
	maxTokens?: number;
}

export interface Entity {
	name: string;
	type: string;
	confidence?: number;
}

export interface Relation {
	from: string;
	to: string;
	type: string;
	confidence?: number;
}

export interface ExtractionResult {
	entities: Entity[];
	relations: Relation[];
}

export interface ConnectionTestResult {
	ok: boolean;
	message: string;
}

export interface TestConnectionOptions {
	signal?: AbortSignal;
	onProgress?: (label: string, percent: number) => void | Promise<void>;
}

export interface LLMProvider {
	readonly name: string;
	chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
	embeddings(texts: string[]): Promise<number[][]>;
	extract(text: string): Promise<ExtractionResult>;
	testConnection(options?: TestConnectionOptions): Promise<ConnectionTestResult>;
}