import { existsSync } from "node:fs";

/**
 * Loads `.env` from the current directory into process.env.
 * The Agent SDK does not read `.env` files, so every entry point calls this first.
 * Variables that are already set in the shell win.
 */
export function loadEnv(path = ".env"): void {
  if (existsSync(path)) {
    process.loadEnvFile(path);
  }
}
