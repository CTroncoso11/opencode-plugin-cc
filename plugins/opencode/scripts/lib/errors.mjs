// Exit codes and errors shared by the companion subcommands.

export const EXIT = Object.freeze({
  OK: 0,
  FAILED: 1,
  RUNNING: 2,
  USAGE: 3,
  NOT_FOUND: 4,
});

export class CompanionError extends Error {
  /**
   * @param {string} message
   * @param {number} [exitCode]
   */
  constructor(message, exitCode = EXIT.FAILED) {
    super(message);
    this.name = "CompanionError";
    this.exitCode = exitCode;
  }
}

/**
 * @param {string} message
 * @returns {CompanionError}
 */
export function usageError(message) {
  return new CompanionError(message, EXIT.USAGE);
}

/**
 * Collapse a message to one line so callers can show it as-is.
 * @param {unknown} message
 * @returns {string}
 */
export function oneLine(message) {
  return String(message ?? "").replace(/\s*[\r\n]+\s*/g, " ").trim();
}
