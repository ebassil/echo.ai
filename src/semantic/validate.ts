import type { LLMProvider, ExtractionResult, ChatMessage } from '../llm/provider';
import { parseExtraction } from '../llm/providers/ollama';

export interface ValidationError {
	message: string;
	raw?: string;
}

export function stripFences(raw: string): string {
	return raw
		.trim()
		.replace(/^```(?:json)?\s*/i, '')
		.replace(/```\s*$/m, '')
		.trim();
}

export function isValidEntity(e: any): boolean {
	return (
		e != null &&
		typeof e.name === 'string' &&
		e.name.trim().length > 0 &&
		typeof e.type === 'string'
	);
}

export function isValidRelation(r: any): boolean {
	return (
		r != null &&
		typeof r.from === 'string' &&
		r.from.trim().length > 0 &&
		typeof r.to === 'string' &&
		r.to.trim().length > 0 &&
		typeof r.type === 'string' &&
		r.type.trim().length > 0
	);
}

export function validateExtractionResult(result: ExtractionResult): string[] {
	const errors: string[] = [];
	for (let i = 0; i < result.entities.length; i++) {
		const e = result.entities[i] as any;
		if (typeof e.name !== 'string' || e.name.trim().length === 0) {
			errors.push(`entities[${i}].name must be non-empty string`);
		}
		if (typeof e.type !== 'string') {
			errors.push(`entities[${i}].type must be string`);
		}
	}
	for (let i = 0; i < result.relations.length; i++) {
		const r = result.relations[i] as any;
		if (typeof r.from !== 'string' || r.from.trim().length === 0) {
			errors.push(`relations[${i}].from must be non-empty string`);
		}
		if (typeof r.to !== 'string' || r.to.trim().length === 0) {
			errors.push(`relations[${i}].to must be non-empty string`);
		}
		if (typeof r.type !== 'string' || r.type.trim().length === 0) {
			errors.push(`relations[${i}].type must be non-empty string`);
		}
	}
	return errors;
}

export function parseAndValidate(raw: string): { result: ExtractionResult; errors: string[] } {
	const parsed = parseExtraction(raw);
	const errors = validateExtractionResult(parsed);
	return { result: parsed, errors };
}

/**
 * Strict extraction with one corrective retry.
 * On persistent failure, throws error with message truncated to 1k.
 */
export async function validatedExtract(provider: LLMProvider, text: string): Promise<ExtractionResult> {
	// First attempt via provider.extract
	let result: ExtractionResult;
	try {
		result = await provider.extract(text);
	} catch (e) {
		// If provider.extract throws, treat as invalid and retry
		result = { entities: [], relations: [] };
		// Attempt retry once
		return await retryOnce(provider, text, String(e));
	}

	const errors = validateExtractionResult(result);
	if (errors.length === 0) {
		return result;
	}

	// One corrective retry
	return await retryOnce(provider, text, errors.join('; '));
}

async function retryOnce(provider: LLMProvider, originalText: string, errorDetail: string): Promise<ExtractionResult> {
	const fixPrompt =
		`Your previous response was not valid JSON for the schema {"entities":[{"name":string,"type":string}],"relations":[{"from":string,"to":string,"type":string}]}. ` +
		`Error: ${errorDetail}. Return only the JSON.`;

	const messages: ChatMessage[] = [
		{
			role: 'system',
			content:
				'You extract entities and relations from text. Respond only with JSON matching ' +
				'{"entities":[{"name":string,"type":string}],"relations":[{"from":string,"to":string,"type":string}]}.',
		},
		{ role: 'user', content: originalText },
		{ role: 'user', content: fixPrompt },
	];

	let raw: string;
	try {
		raw = await provider.chat(messages, { temperature: 0 });
	} catch (e) {
		throw new Error(`Extraction failed and retry failed: ${String(e).slice(0, 1000)}`);
	}

	const { result, errors } = parseAndValidate(raw);
	if (errors.length > 0) {
		throw new Error(`Extraction validation failed after retry: ${errors.join('; ').slice(0, 1000)}`);
	}
	return result;
}
