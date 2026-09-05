import joplin from 'api';
import type { Script } from 'api/types';
import { start, stop } from './plugin/runtime';

interface EchoScript extends Script {
	onStop?(event: any): Promise<void>;
}

const script: EchoScript = {
	onStart: async () => {
		await start();
	},
	onStop: async () => {
		await stop();
	},
};

joplin.plugins.register(script);