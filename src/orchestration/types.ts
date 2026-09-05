export type Scope = { noteId: string } | { folderId: string } | 'all';

export type PipelineSelector = 'structural' | 'semantic' | 'embedding' | 'both';

export type TriggerKind = 'manual' | 'event' | 'schedule' | 'startup';

export const PRIORITY_MAP: Record<TriggerKind, number> = {
  manual: 3,
  event: 2,
  schedule: 1,
  startup: 0,
};

export interface RunHandle {
  runId: string;
  cancel(): Promise<void>;
  promise: Promise<BatchResult>;
}

export interface BatchResult {
  notesProcessed: number;
  chunksCreated: number;
  entitiesCreated: number;
  relationsCreated: number;
  skipped: number;
  errors: { noteId: string; message: string }[];
}

export interface PipelineResult {
  notesProcessed: number;
  chunksCreated: number;
  entitiesCreated: number;
  relationsCreated: number;
  skipped: number;
  errors: { noteId: string; message: string }[];
  unresolvedLinks?: number;
}

export interface PipelineRunOptions {
  signal?: AbortSignal;
  onProgress?: (processed: number, total: number, currentNoteId: string) => void;
  force?: boolean;
  cascade?: { mode: 'lazy' | 'eager'; depth?: number } | false;
}

export interface Pipeline {
  run(noteIds: string[], options: PipelineRunOptions): Promise<PipelineResult>;
}

export interface OrchestratorOptions {
  scope: Scope;
  pipeline: PipelineSelector;
  force?: boolean;
  cascade?: { mode: 'lazy' | 'eager'; depth?: number } | false;
  trigger?: TriggerKind;
  onProgress?: (processed: number, total: number, currentNoteId: string) => void;
}

export interface ProgressUpdate {
  processed: number;
  total: number;
  currentNoteId: string;
}
