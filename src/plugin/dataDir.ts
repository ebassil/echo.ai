import joplin from 'api';
import { mkdir } from 'fs/promises';
import { errorMessage } from '../util/errors';

export async function initDataDirectory(): Promise<string> {
	const dataDir = await joplin.plugins.dataDir();
	try {
		await mkdir(dataDir, { recursive: true });
	} catch (error) {
		throw new Error(`Could not create echo.ai data directory at "${dataDir}": ${errorMessage(error)}`);
	}
	return dataDir;
}