// Presentation only: the queue retains full jobs and diagnostics for details:true.
export function compactJob(job, { includeResult = true } = {}) {
  const out = { id: job.id, status: job.status, phase: job.phase };
  for (const key of ['label', 'queuePosition', 'conversationUrl', 'parentJobId', 'error']) {
    if (job[key] !== null && job[key] !== undefined && job[key] !== '') out[key] = job[key];
  }
  if (job.progress) {
    out.progress = {};
    for (const key of ['active', 'looksInterim', 'elapsedMs']) {
      if (job.progress[key] !== undefined) out.progress[key] = job.progress[key];
    }
    if (job.progress.preview) out.progress.preview = job.progress.preview.slice(0, 200);
  }
  if (job.attachmentCount) out.attachmentCount = job.attachmentCount;
  const files = job.result?.responseFiles || job.responseFiles;
  if (files) out.responseFiles = {
    status: files.status,
    expected: files.expected,
    fileCount: files.files?.length || 0,
    ...(files.inspectionRecommended ? { inspectionRecommended: true } : {}),
    ...(files.errors?.length ? { errorCount: files.errors.length } : {}),
  };
  // The result includes the answer, warnings and resource metadata; never truncate it.
  if (includeResult && job.result) out.result = job.result;
  return out;
}

export function compactBridgeStatus(status) {
  const out = {
    config: status.config,
    browserRunning: status.browserRunning,
    jobs: status.jobs,
    updates: status.updates?.managed === false ? { managed: false } : {
      currentVersion: status.updates?.currentVersion,
      autoUpdate: status.updates?.autoUpdate,
      availableVersion: status.updates?.availableVersion || null,
      lastError: status.updates?.lastError || null,
    },
  };
  if (status.authentication) out.authentication = status.authentication;
  const warnings = {};
  const errors = {
    browserClose: status.browserLifecycle?.lastCloseError,
    backgroundVisibility: status.backgroundVisibility?.error,
    cacheCleanup: status.browserCache?.lastCleanupError,
    retentionCleanup: status.localRetention?.lastInspectionCleanupError,
  };
  for (const [name, value] of Object.entries(errors)) if (value) warnings[name] = value;
  if (Object.keys(warnings).length) out.warnings = warnings;
  return out;
}
