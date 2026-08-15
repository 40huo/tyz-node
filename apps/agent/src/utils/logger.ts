type LogLevel = "info" | "warn" | "error" | "debug";

// JSON.stringify drops non-enumerable Error fields (message/stack), so
// surface them explicitly — otherwise every logged error renders as {}.
function errorReplacer(_key: string, value: unknown) {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, cause: value.cause };
  }
  return value;
}

class Logger {
  private formatMessage(level: LogLevel, message: string, meta?: any): string {
    const timestamp = new Date().toISOString();
    const metaStr = meta ? ` ${JSON.stringify(meta, errorReplacer)}` : "";
    return `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}`;
  }

  /**
   * PrintFunc compatible method for Hono logger middleware
   * Usage: app.use(logger(customLogger.print))
   */
  print = (message: string, ...rest: string[]) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}]`, message, ...rest);
  };

  info(message: string, meta?: any) {
    console.log(this.formatMessage("info", message, meta));
  }

  warn(message: string, meta?: any) {
    console.warn(this.formatMessage("warn", message, meta));
  }

  error(message: string, meta?: any) {
    console.error(this.formatMessage("error", message, meta));
  }

  debug(message: string, meta?: any) {
    if (process.env.DEBUG === "true") {
      console.debug(this.formatMessage("debug", message, meta));
    }
  }
}

export const logger = new Logger();
