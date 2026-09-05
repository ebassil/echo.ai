import joplin from 'api';

let cachedLocked: boolean | null = null;

export async function isVaultLocked(): Promise<boolean> {
	try {
		const joplinAny: any = joplin as any;
		// Joplin E2EE: check via joplin.settings or encryption service if available
		// Fallback: try to list notes; if vault locked, some APIs may still work but body is empty.
		// Best effort: check joplin.data.get for one note's body; if empty due to lock, we can't know.
		// Use joplin.views.dialogs or settings key if present.
		if (typeof joplinAny.settings?.value === 'function') {
			// There is no direct vault lock API exposed to plugins as of 3.x, but check for undocumented service
		}
		if (joplinAny.encryptionService) {
			const svc = joplinAny.encryptionService();
			if (typeof svc.isMasterKeyLoaded === 'function') {
				const loaded = await svc.isMasterKeyLoaded();
				cachedLocked = !loaded;
				return !loaded;
			}
		}
		// Heuristic: check if notes have body; if vault is locked, bodies may be encrypted gibberish or empty.
		// Default to not locked if we cannot determine.
		return false;
	} catch {
		return false;
	}
}

export function setVaultLocked(locked: boolean): void {
	cachedLocked = locked;
}

export function getCachedVaultLocked(): boolean | null {
	return cachedLocked;
}
