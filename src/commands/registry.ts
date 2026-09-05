import type { LLMProvider } from '../llm/provider';
import { registerTestConnectionCommand } from './testConnection';

export async function registerCommands(provider: LLMProvider): Promise<void> {
	await registerTestConnectionCommand(provider);
}