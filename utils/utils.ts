import { Logger } from "pino";
import dotenv from 'dotenv';
dotenv.config();

/**
 * Runs the function `fn`
 * and retries automatically if it fails.
 *
 * Tries max `1 + retries` times
 * with `retryIntervalMs` milliseconds between retries.
 *
 * From https://mtsknn.fi/blog/js-retry-on-fail/
 */
export const retry = async <T>(
  fn: () => Promise<T> | T,
  { retries, retryIntervalMs }: { retries: number; retryIntervalMs: number },
): Promise<T> => {
  try {
    return await fn();
  } catch (error) {
    if (retries <= 0) {
      throw error;
    }
    await sleep(retryIntervalMs);
    return retry(fn, { retries: retries - 1, retryIntervalMs });
  }
};

export const sleep = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

export const retrieveEnvVariable = (variableName: string, logger: Logger) => {
    const variable = process.env[variableName] || '';
    if (!variable) {
      logger.error(`${variableName} is not set`);
      process.exit(1);
    }
    return variable;
}
