let cachedLocked: boolean | null = null;

// Joplin does not expose a vault/encryption lock API to plugins. Probing
// `joplin.encryptionService` throws "property or method does not exist" through
// the plugin proxy, so never access it. Treat the vault as unlocked unless a
// caller explicitly set the cached state via setVaultLocked().
export async function isVaultLocked(): Promise<boolean> {
	if (cachedLocked !== null) return cachedLocked;
	return false;
}

export function setVaultLocked(locked: boolean): void {
	cachedLocked = locked;
}

export function getCachedVaultLocked(): boolean | null {
	return cachedLocked;
}
