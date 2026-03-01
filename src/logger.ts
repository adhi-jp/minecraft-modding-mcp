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
  if (level === "error") {
    console.error(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.info(line);
}
