import { spawn } from 'node:child_process';
import { stat, mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = resolve(root, 'server/dist/index.js');
const webEntry = resolve(root, 'web/dist/index.html');

let browser;
let child;
let dataDir;
let workspaceDir;
let verifiedWorkspaceDir;

const overallDeadline = setTimeout(() => {
  console.error('[smoke:browser] FAIL: smoke test exceeded the 120-second hard deadline.');
  try {
    child?.kill('SIGKILL');
  } catch {
    // The process may already have exited.
  }
  void browser?.close();
  if (dataDir) {
    void rm(dataDir, { recursive: true, force: true });
  }
  if (workspaceDir) {
    void rm(workspaceDir, { recursive: true, force: true });
  }
  if (verifiedWorkspaceDir) {
    void rm(verifiedWorkspaceDir, { recursive: true, force: true });
  }
  process.exit(1);
}, 120_000);
overallDeadline.unref();

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function phase(name, operation) {
  try {
    const result = await operation();
    console.log(`[smoke:browser] PASS: ${name}`);
    return result;
  } catch (error) {
    console.error(`[smoke:browser] FAIL: ${name}: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

async function isFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function assertBuildExists() {
  const [hasServer, hasWeb] = await Promise.all([
    isFile(serverEntry),
    isFile(webEntry),
  ]);

  if (!hasServer || !hasWeb) {
    const missing = [
      !hasServer && 'server/dist/index.js',
      !hasWeb && 'web/dist/index.html',
    ].filter(Boolean).join(' and ');
    throw new Error(`${missing} ${missing.includes(' and ') ? 'are' : 'is'} missing. Run \`npm run build\` first.`);
  }
}

async function getFreePort() {
  const socket = net.createServer();
  await new Promise((resolveListen, rejectListen) => {
    socket.once('error', rejectListen);
    socket.listen(0, '127.0.0.1', resolveListen);
  });

  const address = socket.address();
  if (!address || typeof address === 'string') {
    socket.close();
    throw new Error('Could not determine the ephemeral server port.');
  }

  await new Promise((resolveClose, rejectClose) => {
    socket.close((error) => error ? rejectClose(error) : resolveClose());
  });
  return address.port;
}

async function waitForHealth(url, serverOutput) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(1_000, remaining))),
      });
      if (response.status === 200) {
        return;
      }
    } catch {
      // The server may still be starting.
    }
    const retryDelay = Math.min(250, deadline - Date.now());
    if (retryDelay > 0) {
      await delay(retryDelay);
    }
  }

  throw new Error(`Server health check did not return HTTP 200 within 10 seconds.\n${serverOutput()}`);
}

async function resolveBrowserExecutable() {
  if (process.env.CHROME_PATH) {
    if (await isFile(process.env.CHROME_PATH)) {
      return process.env.CHROME_PATH;
    }
    throw new Error(`CHROME_PATH does not point to an existing browser executable: ${process.env.CHROME_PATH}`);
  }

  const candidates = {
    linux: [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
    ],
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
    ],
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ],
  }[process.platform] ?? [];

  for (const candidate of candidates) {
    if (await isFile(candidate)) {
      return candidate;
    }
  }

  throw new Error('Chrome/Chromium was not found. Set CHROME_PATH to the browser executable.');
}

async function stopServer(server) {
  if (!server || server.exitCode !== null || server.signalCode !== null) {
    return;
  }

  try {
    server.kill('SIGTERM');
  } catch {
    return;
  }

  await Promise.race([
    new Promise((resolveExit) => server.once('exit', resolveExit)),
    delay(3_000),
  ]);

  if (server.exitCode === null && server.signalCode === null) {
    try {
      server.kill('SIGKILL');
    } catch {
      // The process exited between the state check and the signal.
    }

    if (server.exitCode === null && server.signalCode === null) {
      await Promise.race([
        new Promise((resolveExit) => server.once('exit', resolveExit)),
        delay(1_000),
      ]);
    }
  }
}

async function runCommand(command, args, cwd) {
  await new Promise((resolveCommand, rejectCommand) => {
    const process = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    process.stdout.on('data', (chunk) => { output += chunk.toString(); });
    process.stderr.on('data', (chunk) => { output += chunk.toString(); });
    process.once('error', rejectCommand);
    process.once('close', (code) => code === 0 ? resolveCommand() : rejectCommand(new Error(`${command} ${args.join(' ')} exited ${code}: ${output}`)));
  });
}

let page;
let port;
let browserPath;
let serverOutput = '';
let rootState = { childElementCount: 0, innerText: '' };
const pageErrors = [];
const consoleMessages = [];
let failure;

try {
  await assertBuildExists();
  port = await getFreePort();
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'mat-smoke-'));
  workspaceDir = await mkdtemp(path.join(os.tmpdir(), 'mat-smoke-workspace-'));
  verifiedWorkspaceDir = await mkdtemp(path.join(os.tmpdir(), 'mat-smoke-verified-'));

  child = spawn(process.execPath, [
    'server/dist/index.js',
    '--port', String(port),
    '--host', '127.0.0.1',
    '--data-dir', dataDir,
  ], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => {
    serverOutput += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    serverOutput += chunk.toString();
  });
  child.on('error', (error) => {
    serverOutput += `${error.stack ?? String(error)}\n`;
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await phase('server startup', () => waitForHealth(`${baseUrl}/api/health`, () => serverOutput));
  browserPath = await resolveBrowserExecutable();

  browser = await chromium.launch({ executablePath: browserPath, headless: true });
  page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
  page.on('pageerror', (error) => {
    pageErrors.push(error.stack ?? String(error));
  });
  page.on('console', (message) => {
    consoleMessages.push(`[${message.type()}] ${message.text()}`);
  });

  await phase('React mount', async () => {
    await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
    const mountDeadline = Date.now() + 15_000;
    let mounted = false;
    while (Date.now() < mountDeadline) {
      rootState = await page.evaluate(() => {
        const rootElement = document.getElementById('root');
        return {
          childElementCount: rootElement?.childElementCount ?? 0,
          innerText: rootElement?.innerText ?? '',
        };
      });
      if (rootState.childElementCount >= 1 && rootState.innerText.includes('WORKSPACES')) { mounted = true; break; }
      await delay(250);
    }
    const diagnosticMarkers = ['Startup error', 'Startup rejection', 'did not mount'];
    const startupDiagnostic = diagnosticMarkers.find((marker) => rootState.innerText.includes(marker));
    if (pageErrors.length > 0) throw new Error(`Captured ${pageErrors.length} page error${pageErrors.length === 1 ? '' : 's'}.`);
    if (startupDiagnostic) throw new Error(`The boot-diagnostics card reported: ${startupDiagnostic}`);
    if (!mounted) throw new Error('The React app did not render the WORKSPACES heading within 15 seconds.');
  });

  const api = async (apiPath, init) => {
    const response = await fetch(`${baseUrl}${apiPath}`, init ? { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } } : undefined);
    if (!response.ok) throw new Error(`${apiPath} returned ${response.status}: ${await response.text()}`);
    return response.status === 204 ? undefined : response.json();
  };

  const run = await phase('live run setup', async () => {
    const workspace = await api('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: 'Smoke', path: workspaceDir }) });
    const workflows = await api('/api/workflows');
    const workflow = workflows[0];
    if (!workflow) throw new Error('No workflow was available for the smoke run.');
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent?.includes('Smoke')), null, { timeout: 10_000 });
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes('Smoke'));
      button?.click();
    });
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Start'), null, { timeout: 10_000 });

    const longReply = (index) => `Candidate ${index}: ${'The quick brown fox streams a detailed response while the terminal keeps the live output pinned. '.repeat(38)}`;
    const slot = (index) => ({
      id: `smoke-${index}`,
      label: `Smoke ${index + 1}`,
      agent: { provider: 'mock', model: `slow:${700 + index * 100}`, permission: 'auto' },
      count: 1,
      promptTemplate: `MOCK_REPLY: ${longReply(index)}`,
    });
    const workflowOverride = {
      ...workflow,
      orchestrator: { ...workflow.orchestrator, enabled: false },
      stages: [{
        ...workflow.stages[0], id: 'smoke-stage', name: 'Smoke stage', gate: false, isolation: 'none', join: 'all', timeoutSec: 300, stallSec: 240,
        slots: Array.from({ length: 6 }, (_, index) => slot(index)),
      }],
    };
    delete workflowOverride.builtin;
    return api('/api/runs', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: workspace.id, workflowId: workflow.id, task: 'Browser smoke follow-mode run', workflowOverride }),
    });
  });

  await phase('live switching and panel sizing', async () => {
    await page.waitForSelector('[data-testid="stream-scroll-region"]', { timeout: 10_000 });
    const dimensions = await page.$eval('[data-testid="stream-scroll-region"]', (element) => ({ clientHeight: element.clientHeight, windowHeight: window.innerHeight }));
    if (dimensions.clientHeight <= 0 || dimensions.clientHeight >= dimensions.windowHeight) {
      throw new Error(`Invalid stream viewport height ${dimensions.clientHeight}px for a ${dimensions.windowHeight}px window.`);
    }
  });

  await phase('follow while rows grow', async () => {
    const samples = [];
    for (let index = 0; index < 16; index += 1) {
      samples.push(await page.$eval('[data-testid="stream-scroll-region"]', (element) => element.scrollHeight - element.scrollTop - element.clientHeight));
      await delay(250);
    }
    const nearBottom = samples.filter((gap) => gap <= 96).length;
    if (nearBottom / samples.length < 0.7) throw new Error(`Only ${nearBottom}/${samples.length} samples stayed within 96px of live output; gaps=${samples.map(Math.round).join(',')}`);
  });

  await phase('manual reading and jump to live', async () => {
    await page.waitForFunction(() => {
      const element = document.querySelector('[data-testid="stream-scroll-region"]');
      return element && element.scrollHeight > element.clientHeight * 1.5;
    }, null, { timeout: 10_000 });
    const placed = await page.$eval('[data-testid="stream-scroll-region"]', (element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
      element.scrollTop = Math.max(0, (element.scrollHeight - element.clientHeight) * 0.35);
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
      return element.scrollTop;
    });
    await delay(2_000);
    const after = await page.$eval('[data-testid="stream-scroll-region"]', (element) => element.scrollTop);
    if (Math.abs(after - placed) > 150) throw new Error(`Manual scroll position moved ${Math.round(after - placed)}px (from ${Math.round(placed)} to ${Math.round(after)}).`);
    const jump = page.getByRole('button', { name: 'Jump to live' });
    if (!await jump.isVisible()) throw new Error('Jump to live was not visible after scrolling upstream.');
    await jump.click();
    await page.waitForFunction(() => {
      const element = document.querySelector('[data-testid="stream-scroll-region"]');
      return element && element.scrollHeight - element.scrollTop - element.clientHeight < 96;
    }, null, { timeout: 1_000 });
  });

  await phase('run completion', async () => {
    const deadline = Date.now() + 30_000;
    let snapshot = run;
    while (Date.now() < deadline && snapshot.status !== 'done') {
      await delay(250);
      snapshot = await api(`/api/runs/${encodeURIComponent(run.runId)}`);
    }
    if (snapshot.status !== 'done') throw new Error(`Run ${run.runId} did not finish within 30 seconds (status=${snapshot.status}).`);
    await page.waitForFunction(() => [...document.querySelectorAll('span')].some((element) => element.textContent?.trim() === 'done'), null, { timeout: 5_000 });
  });

  await phase('verified run and report', async () => {
    await runCommand('git', ['init', '-q'], verifiedWorkspaceDir);
    await runCommand('git', ['config', 'user.email', 'mat-smoke@example.test'], verifiedWorkspaceDir);
    await runCommand('git', ['config', 'user.name', 'MAT Smoke'], verifiedWorkspaceDir);
    await runCommand('git', ['commit', '--allow-empty', '-qm', 'base'], verifiedWorkspaceDir);
    const workspace = await api('/api/workspaces', { method: 'POST', body: JSON.stringify({
      name: 'Verified Smoke', path: verifiedWorkspaceDir, verifyCommand: 'node -e "process.exit(0)"',
    }) });
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent?.includes('Verified Smoke')), null, { timeout: 10_000 });
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes('Verified Smoke'));
      button?.click();
    });
    const workflows = await api('/api/workflows');
    const source = workflows[0];
    if (!source) throw new Error('No workflow was available for the verified smoke run.');
    const workflowOverride = {
      ...source,
      id: 'verified-smoke',
      name: 'Verified Smoke',
      orchestrator: { ...source.orchestrator, enabled: false },
      stages: [{
        ...source.stages[0], id: 'verify-stage', name: 'Verify stage', isolation: 'worktree', gate: false, requireVerified: false,
        slots: [{
          id: 'writer', label: 'Writer', agent: { provider: 'mock', model: 'ok', permission: 'auto' }, count: 1,
          promptTemplate: 'MOCK_WRITE:mat-smoke.txt\nMOCK_REPLY: verified smoke complete',
        }],
      }],
    };
    delete workflowOverride.builtin;
    const verifiedRun = await api('/api/runs', { method: 'POST', body: JSON.stringify({
      workspaceId: workspace.id, workflowId: source.id, task: 'Create verified smoke evidence', workflowOverride,
    }) });
    const deadline = Date.now() + 30_000;
    let snapshot = verifiedRun;
    while (Date.now() < deadline && snapshot.status !== 'done') {
      await delay(250);
      snapshot = await api(`/api/runs/${encodeURIComponent(verifiedRun.runId)}`);
    }
    if (snapshot.status !== 'done') throw new Error(`Verified run ${verifiedRun.runId} did not finish (status=${snapshot.status}).`);
    await page.getByText('✓ verified', { exact: true }).waitFor({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Report', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText('## Outcome', { exact: false }).waitFor({ timeout: 10_000 });
    if (!(await dialog.textContent())?.includes('verified')) throw new Error('Run report did not contain verified evidence.');
    if (pageErrors.length > 0) throw new Error(`Captured ${pageErrors.length} page error${pageErrors.length === 1 ? '' : 's'}.`);
  });
} catch (error) {
  failure = error;
  if (page) {
    try {
      rootState = await page.evaluate(() => {
        const rootElement = document.getElementById('root');
        return {
          childElementCount: rootElement?.childElementCount ?? 0,
          innerText: rootElement?.innerText ?? '',
        };
      });
    } catch {
      // Keep the last root state if the page is no longer available.
    }
  }
} finally {
  let cleanupFailure;
  try {
    await browser?.close();
  } catch (error) {
    cleanupFailure = error;
  }
  try {
    await stopServer(child);
  } catch (error) {
    cleanupFailure ??= error;
  }
  // Windows keeps transient locks on freshly used git/worktree dirs; retry removal.
  for (const dir of [dataDir, workspaceDir, verifiedWorkspaceDir]) {
    if (!dir) continue;
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      cleanupFailure ??= error;
    }
  }
  clearTimeout(overallDeadline);
  failure ??= cleanupFailure;
}

if (failure) {
  console.error(`[smoke:browser] FAIL: ${failure.stack ?? String(failure)}`);
  console.error(`[smoke:browser] #root childElementCount: ${rootState.childElementCount}`);
  console.error(`[smoke:browser] #root innerText (first 500 chars): ${rootState.innerText.slice(0, 500) || '(empty)'}`);
  console.error(`[smoke:browser] Page errors:\n${pageErrors.join('\n') || '(none)'}`);
  console.error(`[smoke:browser] Console messages:\n${consoleMessages.join('\n') || '(none)'}`);
  console.error(`[smoke:browser] Server output:\n${serverOutput.trim() || '(none)'}`);
  process.exitCode = 1;
} else {
  console.log(`[smoke:browser] PASS port=${port} browser=${browserPath}`);
}
