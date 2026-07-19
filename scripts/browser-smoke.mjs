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

const overallDeadline = setTimeout(() => {
  console.error('[smoke:browser] FAIL: smoke test exceeded the 60-second hard deadline.');
  try {
    child?.kill('SIGKILL');
  } catch {
    // The process may already have exited.
  }
  void browser?.close();
  if (dataDir) {
    void rm(dataDir, { recursive: true, force: true });
  }
  process.exit(1);
}, 60_000);
overallDeadline.unref();

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

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
  await waitForHealth(`${baseUrl}/api/health`, () => serverOutput);
  browserPath = await resolveBrowserExecutable();

  browser = await chromium.launch({ executablePath: browserPath, headless: true });
  page = await browser.newPage();
  page.on('pageerror', (error) => {
    pageErrors.push(error.stack ?? String(error));
  });
  page.on('console', (message) => {
    consoleMessages.push(`[${message.type()}] ${message.text()}`);
  });

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

    if (rootState.childElementCount >= 1 && rootState.innerText.includes('WORKSPACES')) {
      mounted = true;
      break;
    }
    await delay(250);
  }

  const diagnosticMarkers = ['Startup error', 'Startup rejection', 'did not mount'];
  const startupDiagnostic = diagnosticMarkers.find((marker) => rootState.innerText.includes(marker));
  if (pageErrors.length > 0) {
    throw new Error(`Captured ${pageErrors.length} page error${pageErrors.length === 1 ? '' : 's'}.`);
  }
  if (startupDiagnostic) {
    throw new Error(`The boot-diagnostics card reported: ${startupDiagnostic}`);
  }
  if (!mounted) {
    throw new Error('The React app did not render the WORKSPACES heading within 15 seconds.');
  }
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
  if (dataDir) {
    try {
      await rm(dataDir, { recursive: true, force: true });
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
