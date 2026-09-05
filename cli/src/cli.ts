#!/usr/bin/env node
import { Command } from 'commander';
import * as fs from 'fs/promises';
import { loadDiscovery, endpointUrl } from './discovery';
import { offlineSearch, offlineStatus, offlineHistory, offlineRunById } from './offline';

// Ensure shared schema import is present — drift guard (6.3)
import '../../src/schema/index';

const VERSION = '0.1.0';

// Exit codes per spec: 0 success, 1 user error, 2 transport/auth
function fail(msg: string, code: 1 | 2 = 1): never {
  console.error(msg);
  process.exit(code);
}

async function fetchJson(url: string, token: string, init?: RequestInit): Promise<{ status: number; body: any; text: string }> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (init?.headers) Object.assign(headers, init.headers as any);
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers });
  } catch (e: any) {
    throw Object.assign(new Error(`Transport error: ${String(e?.message ?? e)} — is Joplin running with echo.ai enabled?`), { code: 2 });
  }
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, text };
}

function parseScope(opts: { note?: string; folder?: string; all?: boolean }): { noteId: string } | { folderId: string } | 'all' {
  const hasNote = !!opts.note;
  const hasFolder = !!opts.folder;
  const hasAll = !!opts.all;
  const count = Number(hasNote) + Number(hasFolder) + Number(hasAll);
  if (count === 0) fail('Must specify one of --note <id>, --folder <id>, or --all', 1);
  if (count > 1) fail('Specify only one of --note, --folder, --all', 1);
  if (hasNote) return { noteId: opts.note! };
  if (hasFolder) return { folderId: opts.folder! };
  return 'all';
}

async function main() {
  const program = new Command();
  program.name('echo').description('echo.ai CLI — pipeline, search, status').version(VERSION);

  const pipeline = program.command('pipeline').description('pipeline operations');
  pipeline
    .command('run')
    .description('trigger a pipeline run')
    .option('--note <id>', 'single note scope')
    .option('--folder <id>', 'folder scope (with descendants)')
    .option('--all', 'all notes scope')
    .option('--pipeline <name>', 'pipeline selector: structural|semantic|both|embedding', 'structural')
    .option('--force', 'bypass delta hash check', false)
    .option('--json', 'output JSON', false)
    .action(async (opts: any) => {
      const scope = parseScope(opts);
      const pipelineName = opts.pipeline as string;
      const valid = ['structural', 'semantic', 'embedding', 'both'];
      if (!valid.includes(pipelineName)) fail(`Invalid --pipeline "${pipelineName}" — must be one of ${valid.join(', ')}`, 1);

      const discovery = await loadDiscovery();
      if (!discovery.port || !discovery.token) {
        fail(
          `Cannot reach plugin — missing port/token. Checked dataDir: ${discovery.dataDir} (cli.json: ${discovery.cliJsonPath}, token: ${discovery.tokenPath}). Is Joplin running with echo.ai enabled? Set ECHO_DATA_DIR / ECHO_TOKEN to override.`,
          2,
        );
      }

      const payload = { pipeline: pipelineName, scope, force: !!opts.force };
      const url = endpointUrl(discovery.port!, '/v1/pipeline/run');
      let result: { status: number; body: any };
      try {
        result = await fetchJson(url, discovery.token!, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } catch (e: any) {
        if ((e as any).code === 2) fail(String(e.message), 2);
        throw e;
      }

      if (result.status === 404) fail(`Not found: ${JSON.stringify(result.body)}`, 1);
      if (result.status === 400) fail(`Bad request: ${JSON.stringify(result.body)}`, 1);
      if (result.status === 401 || result.status === 403) fail(`Auth error (${result.status}): ${JSON.stringify(result.body)}`, 2);
      if (result.status !== 202 && result.status !== 200) fail(`Unexpected status ${result.status}: ${(result as any).text}`, 2);

      const runId = result.body.runId ?? result.body.id;
      if (opts.json) {
        console.log(JSON.stringify(result.body, null, 2));
      } else {
        console.log(`Run enqueued: ${runId}`);
        console.log(`Pipeline: ${result.body.pipeline ?? pipelineName}  Scope: ${JSON.stringify(scope)}`);
        if (result.body.status === 'deferred') console.log('Status: deferred (vault locked) — will run after unlock');
        console.log(`Status: ${endpointUrl(discovery.port!, `/v1/runs/${runId}`)}`);
      }
    });

  program
    .command('update')
    .description('alias for pipeline run')
    .option('--note <id>', 'single note scope')
    .option('--folder <id>', 'folder scope')
    .option('--all', 'all notes scope')
    .option('--pipeline <name>', 'pipeline selector', 'structural')
    .option('--force', 'bypass delta', false)
    .option('--json', 'output JSON', false)
    .action(async (opts: any) => {
      // Reuse pipeline run logic
      const args = process.argv.slice(3);
      // Delegate to pipeline run handler by reconstructing
      const scope = parseScope(opts);
      const pipelineName = opts.pipeline as string;
      const valid = ['structural', 'semantic', 'embedding', 'both'];
      if (!valid.includes(pipelineName)) fail(`Invalid --pipeline "${pipelineName}"`, 1);
      const discovery = await loadDiscovery();
      if (!discovery.port || !discovery.token) fail(`Cannot reach plugin — missing port/token at ${discovery.dataDir}`, 2);
      const payload = { pipeline: pipelineName, scope, force: !!opts.force };
      const url = endpointUrl(discovery.port!, '/v1/pipeline/run');
      const result = await fetchJson(url, discovery.token!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (result.status === 401 || result.status === 403) fail(`Auth error (${result.status})`, 2);
      if (result.status === 404) fail(`Not found: ${JSON.stringify(result.body)}`, 1);
      if (result.status === 400) fail(`Bad request: ${JSON.stringify(result.body)}`, 1);
      if (result.status !== 202 && result.status !== 200) fail(`Unexpected ${result.status}: ${result.text}`, 2);
      const runId = result.body.runId ?? result.body.id;
      if (opts.json) console.log(JSON.stringify(result.body, null, 2));
      else {
        console.log(`Run enqueued: ${runId}`);
        if (result.body.status === 'deferred') console.log('Status: deferred (vault locked)');
      }
      void args;
    });

  program
    .command('search <query>')
    .description('search indexed chunks')
    .option('--limit <n>', 'result limit', '10')
    .option('--offline', 'read index directly (no plugin required)', false)
    .option('--retrievers <list>', 'comma-separated retriever toggles (bm25,dense,graph,etc.) — currently forwarded as metadata')
    .option('--no-graph', 'disable graph retriever (metadata)')
    .option('--json', 'output JSON', false)
    .action(async (query: string, opts: any) => {
      const limit = parseInt(opts.limit, 10) || 10;
      if (!query || !query.trim()) fail('Query must not be empty', 1);
      if (query.length > 500) fail('Query exceeds max length (500)', 1);

      if (opts.offline) {
        const discovery = await loadDiscovery();
        try {
          const res = await offlineSearch(discovery.dataDir, query, limit);
          if (opts.json) console.log(JSON.stringify(res, null, 2));
          else {
            if (res.results.length === 0) console.log('No results.');
            for (const r of res.results) {
              console.log(`- [${r.noteId}] ${r.title ?? ''}  (${r.chunkId})`);
              console.log(`  ${r.snippet}`);
            }
            console.log(`Total: ${res.total}`);
          }
          return;
        } catch (e: any) {
          fail(`Offline search failed: ${String(e?.message ?? e)}`, 1);
        }
      }

      const discovery = await loadDiscovery();
      if (!discovery.port || !discovery.token) {
        // Try offline fallback if requested implicitly? Spec says offline when --offline or endpoint unreachable with config
        fail(`Cannot reach plugin — use --offline for direct index reads. DataDir: ${discovery.dataDir}`, 2);
      }
      const url = endpointUrl(discovery.port!, '/v1/search');
      const payload: any = { query, limit };
      if (opts.retrievers) payload.retrievers = opts.retrievers;
      if (opts.graph === false) payload.retrievers = { ...(payload.retrievers ?? {}), graph: false };

      let result: { status: number; body: any; text: string };
      try {
        result = await fetchJson(url, discovery.token!, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } catch (e: any) {
        if ((e as any).code === 2) fail(String(e.message), 2);
        throw e;
      }
      if (result.status === 400) fail(`Bad request: ${JSON.stringify(result.body)}`, 1);
      if (result.status === 401 || result.status === 403) fail(`Auth error (${result.status})`, 2);
      if (result.status !== 200) fail(`Search failed (${result.status}): ${result.text}`, 2);
      if (opts.json) console.log(JSON.stringify(result.body, null, 2));
      else {
        const results = result.body.results ?? [];
        if (results.length === 0) console.log('No results.');
        for (const r of results) {
          console.log(`- [${r.noteId}] ${r.title ?? ''}  (${r.chunkId})`);
          console.log(`  ${r.snippet ?? r.content ?? ''}`);
        }
        console.log(`Total: ${result.body.total ?? results.length}`);
      }
    });

  const statusCmd = program.command('status').description('show pipeline status and history');
  statusCmd
    .option('--history', 'show run history', false)
    .option('--limit <n>', 'history limit', '20')
    .option('--offset <n>', 'history offset', '0')
    .option('--run <id>', 'show single run by id')
    .option('--offline', 'read pipeline_runs directly', false)
    .option('--json', 'output JSON', false)
    .action(async (opts: any) => {
      if (opts.run) {
        if (opts.offline) {
          const discovery = await loadDiscovery();
          try {
            const row = await offlineRunById(discovery.dataDir, opts.run);
            if (opts.json) console.log(JSON.stringify(row, null, 2));
            else console.log(JSON.stringify(row, null, 2));
            return;
          } catch (e: any) {
            const msg = String(e?.message ?? e);
            if (msg.includes('not found')) fail(msg, 1);
            fail(msg, 1);
          }
        }
        const discovery = await loadDiscovery();
        if (!discovery.port || !discovery.token) fail(`Cannot reach plugin — use --offline`, 2);
        const url = endpointUrl(discovery.port!, `/v1/runs/${encodeURIComponent(opts.run)}`);
        const res = await fetchJson(url, discovery.token!, { method: 'GET' });
        if (res.status === 404) fail(`Run not found: ${opts.run}`, 1);
        if (res.status === 401 || res.status === 403) fail(`Auth error (${res.status})`, 2);
        if (res.status !== 200) fail(`Failed (${res.status}): ${res.text}`, 2);
        if (opts.json) console.log(JSON.stringify(res.body, null, 2));
        else console.log(JSON.stringify(res.body, null, 2));
        return;
      }

      if (opts.history) {
        const limit = parseInt(opts.limit, 10) || 20;
        const offset = parseInt(opts.offset, 10) || 0;
        if (opts.offline) {
          const discovery = await loadDiscovery();
          const rows = await offlineHistory(discovery.dataDir, { limit, offset });
          if (opts.json) console.log(JSON.stringify(rows, null, 2));
          else {
            for (const r of rows) console.log(`${r.id}  ${r.pipeline}  ${r.status}  ${r.started_at}`);
            if (rows.length === 0) console.log('No runs.');
          }
          return;
        }
        const discovery = await loadDiscovery();
        if (!discovery.port || !discovery.token) fail(`Cannot reach plugin — use --offline`, 2);
        const url = endpointUrl(discovery.port!, `/v1/runs?limit=${limit}&offset=${offset}`);
        const res = await fetchJson(url, discovery.token!, { method: 'GET' });
        if (res.status !== 200) fail(`Failed (${res.status}): ${res.text}`, 2);
        if (opts.json) console.log(JSON.stringify(res.body, null, 2));
        else {
          const rows = Array.isArray(res.body) ? res.body : res.body.rows ?? res.body.runs ?? [];
          for (const r of rows) console.log(`${r.id}  ${r.pipeline}  ${r.status}  ${r.started_at}`);
          if (rows.length === 0) console.log('No runs.');
        }
        return;
      }

      // Default: current status
      if (opts.offline) {
        const discovery = await loadDiscovery();
        const s = await offlineStatus(discovery.dataDir);
        if (opts.json) console.log(JSON.stringify(s, null, 2));
        else console.log(JSON.stringify(s, null, 2));
        return;
      }
      const discovery = await loadDiscovery();
      if (!discovery.port || !discovery.token) fail(`Cannot reach plugin — use --offline. DataDir: ${discovery.dataDir}`, 2);
      const url = endpointUrl(discovery.port!, '/v1/status');
      const res = await fetchJson(url, discovery.token!, { method: 'GET' });
      if (res.status === 401 || res.status === 403) fail(`Auth error (${res.status})`, 2);
      if (res.status !== 200) fail(`Status failed (${res.status}): ${res.text}`, 2);
      if (opts.json) console.log(JSON.stringify(res.body, null, 2));
      else {
        const b = res.body;
        console.log(`Current run: ${b.currentRun ? b.currentRun.id + ' ' + b.currentRun.status : 'none'}`);
        console.log(`Queue depth: ${b.queueDepth}`);
        if (b.queuedRuns?.length) for (const q of b.queuedRuns) console.log(`  queued ${q.id} ${q.pipeline} ${q.trigger}`);
        if (b.progress) console.log(`Progress: ${b.progress.processed}/${b.progress.total} ${b.progress.currentNoteId}`);
      }
    });

  // Ensure help/version don't require plugin
  program.exitOverride((err: any) => {
    // commander throws on --help/--version; we propagate as exit 0
    if ((err as any).code === 'commander.helpDisplayed' || (err as any).code === 'commander.version') {
      process.exit(0);
    }
    throw err;
  });

try {
		await program.parseAsync(process.argv);
		// Exit explicitly: the global fetch agent keeps keep-alive sockets open,
		// which would otherwise keep the process alive after a successful command.
		process.exit(0);
	} catch (e: any) {
		if (e?.code === 'commander.helpDisplayed' || e?.code === 'commander.version') process.exit(0);
		const msg = String(e?.message ?? e);
		// Commander already printed help; exit 1 for user error
		if (msg.includes('unknown option') || msg.includes('required')) fail(msg, 1);
		fail(msg, 1);
		void fs;
	}
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
