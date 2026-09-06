import type { RetrieveOptions, ChatContext } from '../retrieval/types';
import { retrieve } from '../retrieval/index';
import { assembleContext } from '../retrieval/context';
import { loadRetrievalSettings } from '../retrieval/settings';

// Default context-injection entry point: runs the fused retrieval pipeline and
// assembles the deduplicated, token-budgeted ChatContext used for citations.
export function createRetrieveContext(): (query: string, options: RetrieveOptions) => Promise<ChatContext> {
	return async (query, options) => {
		const settings = await loadRetrievalSettings();
		const tokenBudget = options.tokenBudget ?? settings.tokenBudget;
		const hits = await retrieve(query, { ...options, tokenBudget });
		return assembleContext(hits, settings, { ...options, tokenBudget }).chatContext;
	};
}