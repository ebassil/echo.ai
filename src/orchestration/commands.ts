import joplin from 'api';
import { enqueueRun } from './runner';
import type { PipelineSelector } from './types';

async function registerCommand(
  name: string,
  label: string,
  pipeline: PipelineSelector,
  scope: 'all',
): Promise<void> {
  await joplin.commands.register({
    name,
    label,
    iconName: 'fas fa-sync',
    execute: async () => {
      await enqueueRun({ pipeline, scope, trigger: 'manual' });
    },
  });
}

export async function registerOrchestrationCommands(): Promise<void> {
  await registerCommand('echo.reindexAll', 'Echo: Reindex all', 'structural', 'all');
  await registerCommand('echo.extractAll', 'Echo: Extract semantics (all)', 'semantic', 'all');
  await registerCommand('echo.reindexAndExtractAll', 'Echo: Reindex and extract all', 'both', 'all');

  try {
    const joplinAny: any = joplin as any;
    if (joplinAny.views?.menuItems?.create) {
      // Joplin's MenuItemLocation enum uses lowercase values ("tools").
      await joplinAny.views.menuItems.create('echo.reindexAllMenu', 'echo.reindexAll', 'tools');
      await joplinAny.views.menuItems.create('echo.extractAllMenu', 'echo.extractAll', 'tools');
      await joplinAny.views.menuItems.create('echo.bothMenu', 'echo.reindexAndExtractAll', 'tools');
    }
    if (joplinAny.views?.toolbarButtons?.create) {
      await joplinAny.views.toolbarButtons.create('echo.reindexAllToolbar', 'echo.reindexAll', 'noteToolbar');
    }
  } catch (e) {
    console.warn('[echo] orchestration menu/toolbar registration failed', e);
  }
}
