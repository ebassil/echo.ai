import joplin from 'api';
import { SETTINGS, DEFAULT_SETTINGS } from '../settings/registry';

export interface ChatSettings {
	systemPrompt: string;
	model: string;
	historyBudget: number;
}

const HISTORY_BUDGET_MIN = 1000;
const HISTORY_BUDGET_MAX = 64000;

export async function resolveChatSettings(): Promise<ChatSettings> {
	const values = await joplin.settings.values([
		SETTINGS.chatSystemPrompt,
		SETTINGS.chatModel,
		SETTINGS.chatHistoryBudget,
		SETTINGS.model,
	]);

	const rawChatModel = values[SETTINGS.chatModel];
	const globalModel = values[SETTINGS.model];
	const model =
		typeof rawChatModel === 'string' && rawChatModel.trim().length > 0
			? rawChatModel
			: typeof globalModel === 'string'
				? globalModel
				: DEFAULT_SETTINGS.model;

	const systemPrompt =
		typeof values[SETTINGS.chatSystemPrompt] === 'string'
			? (values[SETTINGS.chatSystemPrompt] as string)
			: DEFAULT_SETTINGS.chatSystemPrompt;

	const rawBudget = values[SETTINGS.chatHistoryBudget];
	let historyBudget =
		typeof rawBudget === 'number' && Number.isFinite(rawBudget)
			? Math.floor(rawBudget)
			: DEFAULT_SETTINGS.chatHistoryBudget;
	if (historyBudget < HISTORY_BUDGET_MIN || historyBudget > HISTORY_BUDGET_MAX) {
		historyBudget = DEFAULT_SETTINGS.chatHistoryBudget;
	}

	return { systemPrompt, model, historyBudget };
}