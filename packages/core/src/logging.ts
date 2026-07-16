// Minimal structured logger with level filtering and a pluggable sink.

import { LOG_LEVELS, type LogLevel } from './types.ts';

export interface LogRecord {
  level: LogLevel;
  message: string;
  at: number;
  fields?: Record<string, unknown>;
}

export type LogSink = (record: LogRecord) => void;

function rank(level: LogLevel): number {
  return LOG_LEVELS.indexOf(level);
}

export class Logger {
  constructor(
    private minLevel: LogLevel = 'info',
    private sink: LogSink = defaultSink,
  ) {}

  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  setSink(sink: LogSink): void {
    this.sink = sink;
  }

  log(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (rank(level) < rank(this.minLevel)) return;
    this.sink({ level, message, at: Date.now(), fields });
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.log('debug', msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>): void {
    this.log('info', msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.log('warn', msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>): void {
    this.log('error', msg, fields);
  }
}

const defaultSink: LogSink = (r) => {
  const prefix = `[${new Date(r.at).toISOString()}] ${r.level.toUpperCase()}`;
  const extra = r.fields ? ' ' + JSON.stringify(r.fields) : '';
  // eslint-disable-next-line no-console
  (r.level === 'error' ? console.error : console.error)(`${prefix} ${r.message}${extra}`);
};
