export type LogLevel = "info" | "warn" | "error";

export type LogDetails = Record<string, unknown>;

function serializeLog(level: LogLevel, event: string, details?: LogDetails): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...(details ?? {})
  });
}

export function log(level: LogLevel, event: string, details?: LogDetails): void {
  const line = serializeLog(level, event, details);
  process.stderr.write(line + "\n");
}
