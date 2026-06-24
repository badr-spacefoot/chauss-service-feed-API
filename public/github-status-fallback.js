const GITHUB_STATUS_FALLBACK_VERSION = '2026-06-06-actions-403-fallback';
const WORKFLOW_STATUS_LIMITED_MESSAGE = 'GitHub API limit reached; feed data is still available.';

async function updateFeedGenerationStatus() {
  try {
    const result = await getLatestWorkflowRunWithFallback();
    if (result.limited) {
      setFeedStatus('Workflow status limited', WORKFLOW_STATUS_LIMITED_MESSAGE, 'pending');
      scheduleFeedStatusRefresh(600000);
      return;
    }

    const run = result.run;
    if (!run) {
      setFeedStatus('Feed status unavailable', 'No workflow run found yet.', 'pending');
      scheduleFeedStatusRefresh(120000);
      return;
    }

    if (isActiveRun(run)) {
      const activeStep = await getCurrentWorkflowStep(run.jobs_url);
      setFeedStatus('Feed generation in progress', activeStep ? `Current step: ${activeStep}` : `Started: ${formatDateTime(run.run_started_at || run.created_at)}`, 'running');
      scheduleFeedStatusRefresh(30000);
      return;
    }

    if (run.conclusion === 'success') {
      setFeedStatus('Feed ready', `Last workflow success: ${formatDateTime(run.updated_at)}`, 'success');
      scheduleFeedStatusRefresh(120000);
      return;
    }

    setFeedStatus('Last generation needs attention', `${describeConclusion(run.conclusion)}: ${formatDateTime(run.updated_at)}`, 'error');
    scheduleFeedStatusRefresh(120000);
  } catch (_error) {
    setFeedStatus('Workflow status unavailable', 'Could not read GitHub Actions status right now.', 'pending');
    scheduleFeedStatusRefresh(600000);
  }
}

async function getLatestWorkflowRunWithFallback() {
  const response = await fetch(`${ACTIONS_WORKFLOW_RUNS_URL}&ts=${Date.now()}`, { headers: { Accept: 'application/vnd.github+json' } });
  if (response.status === 403) return { limited: true, run: null };
  if (!response.ok) throw new Error(`GitHub Actions returned ${response.status}`);
  return { limited: false, run: (await response.json()).workflow_runs?.[0] || null };
}

async function getLatestWorkflowRunSafe() {
  const result = await getLatestWorkflowRunWithFallback();
  return result.limited ? null : result.run;
}

async function openWorkflowIfReady() {
  setRunWorkflowButton('Checking...', true);
  try {
    const result = await getLatestWorkflowRunWithFallback();
    if (result.run && isActiveRun(result.run)) {
      setFeedStatus('Feed generation already in progress', `Started: ${formatDateTime(result.run.run_started_at || result.run.created_at)}`, 'running');
      setRunWorkflowButton('Workload running', true);
      scheduleSafeWorkflowButtonRefresh(30000);
      return;
    }
    if (result.limited) setFeedStatus('Workflow status limited', WORKFLOW_STATUS_LIMITED_MESSAGE, 'pending');
    window.open(WORKFLOW_PAGE_URL, '_blank', 'noopener');
    setRunWorkflowButton('Open GitHub Actions', false);
  } catch (error) {
    showAlert(error.message || 'Could not check GitHub Actions status.', true);
    setRunWorkflowButton('Open GitHub Actions', false);
  }
}
