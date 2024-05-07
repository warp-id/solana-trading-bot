import pino from 'pino';

const transport = pino.transport({
  targets: [
    {
      level: 'trace',
      target: 'pino-pretty',
      options: {
        destination: "./logs/activity.log",
        colorize: false,
        colorizeObjects: false,
        translateTime: "SYS:yyyy-mm-dd HH:MM:ss"
      },
    },
    {
      level: 'trace',
      target: 'pino-pretty',
      options: {},
    },
  ]
});

export const logger = pino(
  {
    level: 'info',
    redact: ['poolKeys'],
    serializers: {
      error: pino.stdSerializers.err,
    },
    base: undefined,
  },
  transport,
);
