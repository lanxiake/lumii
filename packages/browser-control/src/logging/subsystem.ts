/**
 * Simplified subsystem logger for browser-control package.
 * No Gateway dependencies.
 */

type LogObj = { date?: Date } & Record<string, unknown>;

export type SubsystemLogger = {
  subsystem: string;
  trace: (message: string, meta?: Record<string, unknown>) => void;
  debug: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
  fatal: (message: string, meta?: Record<string, unknown>) => void;
  raw: (message: string) => void;
  child: (name: string) => SubsystemLogger;
};

export function createSubsystemLogger(subsystem: string): SubsystemLogger {
  const prefix = `[${subsystem}]`;

  const logger: SubsystemLogger = {
    subsystem,
    trace: (message: string, meta?: Record<string, unknown>) => {
      console.debug(prefix, message, meta ?? "");
    },
    debug: (message: string, meta?: Record<string, unknown>) => {
      console.debug(prefix, message, meta ?? "");
    },
    info: (message: string, meta?: Record<string, unknown>) => {
      console.info(prefix, message, meta ?? "");
    },
    warn: (message: string, meta?: Record<string, unknown>) => {
      console.warn(prefix, message, meta ?? "");
    },
    error: (message: string, meta?: Record<string, unknown>) => {
      console.error(prefix, message, meta ?? "");
    },
    fatal: (message: string, meta?: Record<string, unknown>) => {
      console.error(prefix, "FATAL:", message, meta ?? "");
    },
    raw: (message: string) => {
      console.log(message);
    },
    child: (name: string) => createSubsystemLogger(`${subsystem}:${name}`),
  };

  return logger;
}
