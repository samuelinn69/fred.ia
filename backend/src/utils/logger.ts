import winston from 'winston';

const { combine, timestamp, colorize, printf, json, errors } = winston.format;

// ── Human-readable format for development ────────────────────
const devFormat = combine(
  errors({ stack: true }),
  timestamp({ format: 'HH:mm:ss' }),
  colorize({ all: true }),
  printf(({ level, message, timestamp, stack, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} [${level}] ${message}${metaStr}${stack ? `\n${stack}` : ''}`;
  })
);

// ── JSON format for production (structured logging) ──────────
const prodFormat = combine(
  errors({ stack: true }),
  timestamp(),
  json()
);

export const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: process.env.NODE_ENV === 'production' ? prodFormat : devFormat,
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      maxsize: 10_485_760, // 10MB
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: 'logs/combined.log',
      maxsize: 10_485_760,
      maxFiles: 10,
    }),
  ],
  // Do NOT log unhandled rejections to stdout in prod
  exitOnError: false,
});

// Convenience method for HTTP logs (Express middleware)
logger.http = logger.http || ((msg: string, meta?: object) => logger.log('http', msg, meta));
