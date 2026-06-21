// Prevent "nested session" detection when launched from inside Claude Code
delete process.env.CLAUDECODE;

import { run } from '@grammyjs/runner';
import { GrammyError, HttpError, type Bot } from 'grammy';
import { AbortController, type AbortSignal } from 'abort-controller';
import { createBot, registerCommandMenu } from './bot/bot.js';
import { config } from './config.js';
import { preventSleep, allowSleep } from './utils/caffeinate.js';
import { stopCleanup } from './telegram/deduplication.js';

const STARTUP_RETRY_MAX_MS = 20 * 60 * 1000;
const COMMAND_MENU_RETRY_MAX_MS = 20 * 60 * 1000;
const RETRY_INITIAL_MS = 10 * 1000;
const RETRY_MAX_MS = 60 * 1000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted retry sleep'));
      return;
    }

    let timeout: ReturnType<typeof setTimeout>;
    function cleanup() {
      signal?.removeEventListener('abort', abort);
    }
    function abort() {
      clearTimeout(timeout);
      cleanup();
      reject(new Error('Aborted retry sleep'));
    }

    timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function errorCode(error: unknown): number | undefined {
  if (error instanceof GrammyError) return error.error_code;
  if (error instanceof HttpError) return errorCode(error.error);
  if (typeof error === 'object' && error !== null) {
    const value = (error as { error_code?: unknown }).error_code;
    return typeof value === 'number' ? value : undefined;
  }
  return undefined;
}

function describeError(error: unknown): string {
  const code = errorCode(error);
  const prefix = code === undefined ? '' : `${code}: `;

  if (error instanceof GrammyError) return `${prefix}${error.description}`;
  if (error instanceof HttpError) return `${prefix}${error.message}`;
  if (error instanceof Error) return `${prefix}${error.message}`;
  return `${prefix}${String(error)}`;
}

function isRetryableTelegramError(error: unknown): boolean {
  const code = errorCode(error);
  if (code === 401 || code === 409) return false;
  if (code === 429 || (code !== undefined && code >= 500)) return true;
  if (error instanceof HttpError) return true;
  if (error instanceof GrammyError) return false;
  if (!(error instanceof Error)) return false;

  return /\b(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED)\b|timed out|fetch failed|socket hang up/i
    .test(error.message);
}

function retryDelayMs(previous: number): number {
  return Math.min(previous * 2, RETRY_MAX_MS);
}

async function initBotWithRetry(bot: Bot, signal: AbortSignal): Promise<void> {
  const startedAt = Date.now();
  let waitMs = RETRY_INITIAL_MS;

  for (let attempt = 1; ; attempt += 1) {
    try {
      await bot.init(signal);
      return;
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      if (!isRetryableTelegramError(error) || elapsedMs + waitMs > STARTUP_RETRY_MAX_MS) {
        throw error;
      }

      console.warn(
        `[startup] Telegram init failed, retrying in ${Math.round(waitMs / 1000)}s ` +
        `(attempt ${attempt}): ${describeError(error)}`,
      );
      await sleep(waitMs, signal);
      waitMs = retryDelayMs(waitMs);
    }
  }
}

async function registerCommandMenuWithRetry(bot: Bot, signal: AbortSignal): Promise<void> {
  const startedAt = Date.now();
  let waitMs = RETRY_INITIAL_MS;

  for (let attempt = 1; ; attempt += 1) {
    try {
      await registerCommandMenu(bot, signal);
      console.log('📋 Command menu registered');
      return;
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      if (!isRetryableTelegramError(error)) {
        console.warn(`⚠️ Failed to register commands, not retrying: ${describeError(error)}`);
        return;
      }
      if (elapsedMs + waitMs > COMMAND_MENU_RETRY_MAX_MS) {
        console.warn(`⚠️ Failed to register commands after ${Math.round(elapsedMs / 1000)}s: ${describeError(error)}`);
        return;
      }

      console.warn(
        `⚠️ Failed to register commands, retrying in ${Math.round(waitMs / 1000)}s ` +
        `(attempt ${attempt}): ${describeError(error)}`,
      );
      await sleep(waitMs, signal);
      waitMs = retryDelayMs(waitMs);
    }
  }
}

async function main() {
  console.log('🤖 Starting Claudegram...');
  console.log(`📋 Allowed users: ${config.ALLOWED_USER_IDS.join(', ')}`);
  console.log(`📝 Mode: ${config.STREAMING_MODE}`);

  // Prevent system sleep on macOS
  preventSleep();

  const lifecycleController = new AbortController();
  let runner: ReturnType<typeof run> | undefined;
  let shuttingDown = false;

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    lifecycleController.abort();
    console.log('\n👋 Shutting down...');
    allowSleep();
    stopCleanup();
    if (runner) await runner.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => { shutdown(); });
  process.on('SIGTERM', () => { shutdown(); });

  const bot = await createBot();

  // Initialize bot (fetches bot info from Telegram)
  await initBotWithRetry(bot, lifecycleController.signal);
  console.log(`✅ Bot started as @${bot.botInfo.username}`);
  console.log('📱 Send /start in Telegram to begin');
  void registerCommandMenuWithRetry(bot, lifecycleController.signal).catch((error) => {
    if (!lifecycleController.signal.aborted) {
      console.warn(`⚠️ Command menu retry stopped: ${describeError(error)}`);
    }
  });

  // Start concurrent runner — updates are processed in parallel,
  // with per-chat ordering enforced by the sequentialize middleware in bot.ts.
  // This lets /cancel bypass the per-chat queue and interrupt running queries.
  runner = run(bot);

  // Keep alive until the runner stops (crash or explicit stop)
  await runner.task();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  allowSleep();
  process.exit(1);
});
