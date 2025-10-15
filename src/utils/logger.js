const pino = require('pino');

function createLogger() {
    const level = process.env.LOG_LEVEL || 'info';
    const isDevelopment = process.env.NODE_ENV !== 'production';

    return pino({
        level,
        transport: isDevelopment
            ? {
                  target: 'pino-pretty',
                  options: {
                      colorize: true,
                      translateTime: 'SYS:standard'
                  }
              }
            : undefined,
        base: {
            pid: process.pid,
            service: 'flowmatic-r2'
        }
    });
}

module.exports = createLogger();
