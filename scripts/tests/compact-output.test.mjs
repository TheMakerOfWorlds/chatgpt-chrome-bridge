import assert from 'node:assert/strict';
import test from 'node:test';
import { compactJob, compactBridgeStatus } from '../lib/compact-output.mjs';
import { responseResourceLinks } from '../lib/mcp-output.mjs';
import { AskJobQueue, ChatGptChromeBridge } from '../lib/bridge.mjs';
import { DEFAULT_CONFIG } from '../lib/config.mjs';

test('compact active jobs keep recovery handles and bound previews without mutating full diagnostics', () => {
  const full = {
    id: 'job-one', label: 'Research', status: 'running', phase: 'generating', queuePosition: 0,
    conversationUrl: 'https://chatgpt.com/c/test', parentJobId: 'parent', error: null,
    progress: { preview: 'x'.repeat(1000), active: true, looksInterim: true, elapsedMs: 50000, stableForMs: 100 },
    pacing: { global: true, scheduledAt: 'time' }, submission: { clicked: true },
  };
  const before = JSON.stringify(full);
  const compact = compactJob(full);
  assert.equal(compact.id, full.id);
  assert.equal(compact.conversationUrl, full.conversationUrl);
  assert.equal(compact.parentJobId, 'parent');
  assert.equal(compact.queuePosition, 0);
  assert.equal(compact.progress.preview.length, 200);
  assert.equal(compact.progress.looksInterim, true);
  assert.equal(compact.submission, undefined);
  assert.equal(JSON.stringify(full), before);
  assert.ok(JSON.stringify(compact).length < before.length * 0.5);
  assert.equal(compactJob({...full, status: 'failed', error: 'Login needed'}).error, 'Login needed');
});

test('completed compact waits preserve the exact answer, warnings and every file resource', async t => {
  const result = {
    response: 'Complete answer '.repeat(2000),
    warnings: ['Session persistence needs attention'],
    responseFiles: { status: 'partial', expected: true, inspectionRecommended: true, errors: ['Missing second file'],
      manifestPath: '/tmp/output manifest.json', files: [{path: '/tmp/report.pdf', name: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 42}] },
  };
  const queue = new AskJobQueue({ config: {maxConcurrent: 1}, ask: async () => result });
  t.after(() => clearInterval(queue.pruneTimer));
  const created = queue.create({prompt: 'test'});
  const full = await queue.wait(created.id, 1);
  const compact = compactJob(full);
  assert.equal(compact.status, 'completed');
  assert.deepEqual(compact.result, full.result);
  assert.equal(compact.result.response, result.response);
  assert.deepEqual(compact.result.warnings, result.warnings);
  assert.deepEqual(responseResourceLinks(compact), responseResourceLinks(full));
  assert.equal(compact.responseFiles.inspectionRecommended, true);
  assert.equal(compact.responseFiles.errorCount, 1);
  const listed = compactJob(queue.list()[0], {includeResult: false});
  assert.equal(listed.result, undefined);
  assert.equal(listed.responseFiles.fileCount, 1);
  assert.ok(!JSON.stringify(listed).includes(result.response));
});

test('compact health preserves actionable errors while omitting internal paths and recent jobs', () => {
  const full = {config: {profile: 'Profile 2', projectUrl: null}, browserRunning: false, jobs: {running: 0},
    updates: {currentVersion: '0.2.5', autoUpdate: true, currentPath: '/private/release', lastError: 'Offline'},
    browserLifecycle: {lastCloseError: 'Session not saved'}, browserCache: {lastCleanupError: 'Cache busy'},
    localRetention: {lastInspectionCleanupError: 'Prune failed'}, recentJobs: [{id: 'old'}]};
  const compact = compactBridgeStatus(full);
  assert.equal(compact.updates.lastError, 'Offline');
  assert.deepEqual(compact.warnings, {browserClose: 'Session not saved', cacheCleanup: 'Cache busy', retentionCleanup: 'Prune failed'});
  assert.equal(compact.updates.currentPath, undefined);
  assert.equal(compact.recentJobs, undefined);
  assert.deepEqual(compact.config, full.config);
});

test('routine health avoids UI diagnostics while details retains them', async () => {
  const bridge = new ChatGptChromeBridge();
  bridge.config = {...DEFAULT_CONFIG};
  bridge.page = {isClosed: () => false};
  bridge.submissionPacer.status = async () => ({global: true});
  bridge.authenticationChecker = async () => ({authenticated: false});
  let inspections = 0;
  bridge.uiDiagnosticsProvider = async () => {inspections++;return {controls: ['login']};};
  const compact = await bridge.status({details: false});
  assert.equal(inspections, 0);
  assert.equal(compact.ui, undefined);
  assert.equal(compact.authentication.authenticated, false);
  const detailed = await bridge.status({details: true});
  assert.equal(inspections, 1);
  assert.deepEqual(detailed.ui, {controls: ['login']});
});
