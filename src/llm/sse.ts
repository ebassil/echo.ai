// Shared SSE parser for OpenAI-compatible streaming chat completions.
// Reads `data:` lines from a response body, extracts `choices[].delta.content`,
// yields string deltas, and stops at the `[DONE]` sentinel.

const DONE_TOKEN = '[DONE]';

export async function* parseSSEStream(
	body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, void> {
	const decoder = new TextDecoder();
	const reader = body.getReader();
	let buffer = '';
	let eventData: string[] = [];

	const flushEvent = (): string | null => {
		if (eventData.length === 0) return null;
		const text = eventData.join('\n');
		eventData = [];
		const delta = parseEvent(text);
		if (delta === DONE_TOKEN) return DONE_TOKEN;
		return delta || null;
	};

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });

			let newlineIndex: number;
			while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
				let line = buffer.slice(0, newlineIndex);
				buffer = buffer.slice(newlineIndex + 1);
				if (line.endsWith('\r')) line = line.slice(0, -1);

				if (line.length === 0) {
					// Blank line: SSE event boundary.
					const delta = flushEvent();
					if (delta === DONE_TOKEN) return;
					if (delta) yield delta;
				} else if (line.startsWith('data:')) {
					eventData.push(line.slice(5).trimStart());
				}
				// Other SSE fields (event:, id:, comments) are ignored.
			}
		}

		// Flush any trailing event that was not terminated by a blank line.
		if (eventData.length > 0) {
			const delta = parseEvent(eventData.join('\n'));
			if (delta !== DONE_TOKEN && delta) yield delta;
		}
	} finally {
		reader.releaseLock();
	}
}

function parseEvent(text: string): string {
	const trimmed = text.trim();
	if (trimmed === DONE_TOKEN) return DONE_TOKEN;
	try {
		const parsed = JSON.parse(trimmed) as { choices?: Array<{ delta?: { content?: unknown } }> };
		const content = parsed?.choices?.[0]?.delta?.content;
		return typeof content === 'string' ? content : '';
	} catch {
		return '';
	}
}