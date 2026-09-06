export interface RunLogger {
	warn(message: string): void;
	error(message: string): void;
}

export function createRunLogger(): RunLogger {
	const seen = new Set<string>();
	return {
		warn(message: string) {
			if (seen.has(message)) return;
			seen.add(message);
			console.warn(message);
		},
		error(message: string) {
			if (seen.has(message)) return;
			seen.add(message);
			console.error(message);
		},
	};
}