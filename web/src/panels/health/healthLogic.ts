import type { ProviderInfo, RunSnapshot, Workspace } from '@mat/shared';
import type { EvidenceIntegrity, WsConnectionState } from '../../app/store.js';
import { displayNodeLabel } from '../../components/nodeLabel.js';

export type HealthSeverity = 'ok' | 'info' | 'working' | 'warning' | 'error';
export type HealthScope = 'system' | 'workspace' | 'provider' | 'run';

export interface HealthFinding {
  id: string;
  scope: HealthScope;
  severity: HealthSeverity;
  title: string;
  detail: string;
  issue: boolean;
  nodeRunId?: string;
  providerId?: ProviderInfo['id'];
}

export interface ServerHealthState {
  status: 'checking' | 'ok' | 'error';
  version?: string;
  message?: string;
}

export interface HealthInput {
  server: ServerHealthState;
  wsConnection: WsConnectionState;
  providers: readonly ProviderInfo[];
  workspace?: Workspace;
  run?: RunSnapshot;
  evidenceIntegrity?: EvidenceIntegrity;
  providerRefreshError?: string;
}

export function healthFindings(input: HealthInput): HealthFinding[] {
  return [
    ...serverFindings(input.server, input.wsConnection, input.providerRefreshError),
    ...workspaceFindings(input.workspace, input.run),
    ...(input.providers.length > 0 ? input.providers.map(providerFinding) : [{
      id: 'provider-none', scope: 'provider' as const, severity: 'info' as const, issue: false,
      title: 'No provider status loaded', detail: 'Open Health while the local server is available to load the latest CLI checks.',
    }]),
    ...runFindings(input.run, input.evidenceIntegrity),
  ];
}

export function healthIssueCount(input: HealthInput): number {
  return healthFindings(input).filter((finding) => finding.issue).length;
}

export function findingsByScope(findings: readonly HealthFinding[], scope: HealthScope): HealthFinding[] {
  return findings.filter((finding) => finding.scope === scope);
}

export function providerFinding(provider: ProviderInfo): HealthFinding {
  if (provider.id === 'mock') {
    return {
      id: 'provider-mock', scope: 'provider', severity: 'ok', issue: false, providerId: provider.id,
      title: 'mock: deterministic test provider',
      detail: 'Built-in and intentionally exempt from CLI discovery and authentication checks.',
    };
  }
  if (!provider.ok) {
    const recordedAuthFailure = provider.authAlert
      ? `\nA sign-in failure was recorded at ${formatTimestamp(provider.authAlert.at)} during run ${provider.authAlert.runId}. This is historical evidence, not a live authentication probe.`
      : '';
    return {
      id: `provider-${provider.id}`, scope: 'provider', severity: 'warning', issue: provider.authAlert !== undefined, providerId: provider.id,
      title: `${provider.id}: latest CLI check did not detect it`,
      detail: `${provider.detail ?? 'MAT could not find this provider executable on its augmented PATH.'}${recordedAuthFailure}\nProvider version checks may be cached for up to 10 minutes.`,
    };
  }
  if (provider.authAlert) {
    return {
      id: `provider-${provider.id}`, scope: 'provider', severity: 'warning', issue: true, providerId: provider.id,
      title: `${provider.id}: recorded sign-in failure`,
      detail: `${provider.authAlert.message}\nRecorded at ${formatTimestamp(provider.authAlert.at)} during run ${provider.authAlert.runId}. This is historical evidence, not a live authentication probe.`,
    };
  }
  return {
    id: `provider-${provider.id}`, scope: 'provider', severity: 'ok', issue: false, providerId: provider.id,
    title: `${provider.id}: latest CLI check detected it`,
    detail: provider.version
      ? `${provider.version}. Version checks may be cached for up to 10 minutes and do not confirm that the provider is currently signed in.`
      : 'Version checks may be cached for up to 10 minutes and do not confirm that the provider is currently signed in.',
  };
}

function serverFindings(server: ServerHealthState, wsConnection: WsConnectionState, providerRefreshError?: string): HealthFinding[] {
  const findings: HealthFinding[] = [];
  if (server.status === 'checking') {
    findings.push({ id: 'server', scope: 'system', severity: 'working', issue: false, title: 'Checking local server', detail: 'Running a read-only health request.' });
  } else if (server.status === 'error') {
    findings.push({ id: 'server', scope: 'system', severity: 'error', issue: true, title: 'Local server unavailable', detail: server.message ?? 'The health request failed.' });
  } else {
    findings.push({ id: 'server', scope: 'system', severity: 'ok', issue: false, title: 'Local server reachable', detail: server.version ? `MAT server ${server.version}` : 'The health request succeeded.' });
  }

  if (wsConnection === 'open') {
    findings.push({ id: 'websocket', scope: 'system', severity: 'ok', issue: false, title: 'Live updates connected', detail: 'Run and evidence updates can arrive in real time.' });
  } else if (wsConnection === 'connecting') {
    findings.push({ id: 'websocket', scope: 'system', severity: 'working', issue: false, title: 'Connecting live updates', detail: 'The app is reconnecting to the local server.' });
  } else {
    findings.push({ id: 'websocket', scope: 'system', severity: 'warning', issue: true, title: 'Live updates disconnected', detail: 'Existing evidence remains readable, but new events may be delayed.' });
  }

  if (providerRefreshError) {
    findings.push({ id: 'provider-refresh', scope: 'system', severity: 'warning', issue: true, title: 'Provider check could not refresh', detail: providerRefreshError });
  }
  return findings;
}

function workspaceFindings(workspace: Workspace | undefined, run: RunSnapshot | undefined): HealthFinding[] {
  if (!workspace && !run?.workspaceSnapshot) {
    return [{ id: 'workspace-none', scope: 'workspace', severity: 'info', issue: false, title: 'No workspace selected', detail: 'Select a project to inspect its Git and verification setup.' }];
  }

  const provenance = run?.workspaceSnapshot;
  const name = provenance?.name ?? workspace?.name ?? 'Workspace';
  const isGit = provenance?.isGit ?? workspace?.isGit ?? false;
  const verifyCommand = provenance?.verifyCommand ?? workspace?.verifyCommand;
  const source = provenance ? 'Viewed run snapshot' : 'Selected workspace';
  return [
    {
      id: 'workspace-git', scope: 'workspace', severity: isGit ? 'ok' : 'info', issue: false,
      title: isGit ? 'Git workspace recorded' : 'Not a Git workspace',
      detail: `${source}: ${name}. ${isGit ? 'This makes worktree isolation eligible; MAT checks the repository again when a stage runs, and patch evidence exists only when a candidate creates it.' : 'This is supported; worktree stages fall back to the workspace and do not produce worktree patch evidence.'}`,
    },
    {
      id: 'workspace-verify', scope: 'workspace', severity: verifyCommand ? 'ok' : 'info', issue: false,
      title: verifyCommand ? 'Verification command configured' : 'No verification command configured',
      detail: verifyCommand
        ? `${source} has a verification command. MAT runs it only for a successful worktree-isolated candidate with a non-empty patch.`
        : 'This is a setup note, not a failure. MAT will not attempt command-based verification.',
    },
  ];
}

function runFindings(run: RunSnapshot | undefined, integrity: EvidenceIntegrity | undefined): HealthFinding[] {
  if (!run) {
    return [{ id: 'run-none', scope: 'run', severity: 'info', issue: false, title: 'No viewed run', detail: 'Start or select a run to inspect node and evidence health.' }];
  }

  const runSeverity: HealthSeverity = run.status === 'failed'
    ? 'error'
    : ['running', 'gating', 'created'].includes(run.status)
      ? 'working'
      : run.status === 'aborted' ? 'info' : 'ok';
  const findings: HealthFinding[] = [{
    id: 'run-status', scope: 'run',
    severity: runSeverity,
    issue: run.status === 'failed',
    title: `Viewed run: ${run.status}`,
    detail: run.status === 'failed' ? 'The run ended unsuccessfully. Inspect the affected nodes below.' : `Evidence source: ${run.runId}.`,
  }];

  if (integrity?.status === 'recovering') {
    findings.push({
      id: 'evidence-integrity', scope: 'run', severity: 'working', issue: false,
      title: 'Recovering an evidence gap',
      detail: sequenceDetail(integrity, 'MAT is backfilling missing persisted events before treating the live view as complete.'),
    });
  } else if (integrity?.status === 'incomplete') {
    findings.push({
      id: 'evidence-integrity', scope: 'run', severity: 'error', issue: true,
      title: 'Evidence continuity is incomplete',
      detail: sequenceDetail(integrity, integrity.message ?? 'One or more persisted events could not be recovered.'),
    });
  } else if (integrity?.status === 'live') {
    findings.push({ id: 'evidence-integrity', scope: 'run', severity: 'ok', issue: false, title: 'Evidence continuity intact', detail: 'No live sequence gap is currently known.' });
  }

  for (const node of run.nodes) {
    const label = displayNodeLabel(node, run.nodes);
    if (node.status === 'failed' || node.status === 'stalled') {
      findings.push({
        id: `node-${node.nodeRunId}`, scope: 'run', severity: node.status === 'failed' ? 'error' : 'warning', issue: true,
        title: `${label}: ${node.status}`,
        detail: node.status === 'failed'
          ? 'The node ended unsuccessfully. Inspect its evidence and failure guidance.'
          : 'The node has stopped producing progress. Inspect its latest evidence.',
        nodeRunId: node.nodeRunId,
      });
    }
    if (node.verification?.status === 'failed' || node.verification?.status === 'error') {
      findings.push({
        id: `verification-${node.nodeRunId}`, scope: 'run', severity: 'error', issue: true,
        title: `${label}: verification ${node.verification.status}`,
        detail: 'The configured verification contract did not pass. Inspect the node evidence for the recorded result.',
        nodeRunId: node.nodeRunId,
      });
    }
  }

  for (const decision of run.gateDecisions.filter((candidate) => candidate.degraded)) {
    const stageName = run.workflow.stages.find((stage) => stage.id === decision.stageId)?.name ?? decision.stageId;
    findings.push({
      id: `gate-${decision.stageId}-${decision.gateAttempt}`, scope: 'run', severity: 'warning', issue: true,
      title: `${stageName}: degraded gate decision`,
      detail: 'The orchestrator continued with reduced decision confidence. Review the gate rationale in the run evidence.',
    });
  }
  return findings;
}

function formatTimestamp(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? `timestamp ${String(value)}` : date.toISOString();
}

function sequenceDetail(integrity: EvidenceIntegrity, fallback: string): string {
  if (integrity.expectedSeq === undefined) return fallback;
  const range = integrity.receivedSeq === undefined
    ? `Expected event ${String(integrity.expectedSeq)}.`
    : `Expected event ${String(integrity.expectedSeq)} before event ${String(integrity.receivedSeq)}.`;
  return `${range} ${fallback}`;
}
