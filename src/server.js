const http = require('http');
const socketIO = require('socket.io');
const app = require('./app');
const { initializeDatabase, closeDatabase } = require('./database/connection');
const { setupSocketIO } = require('./realtime/socketManager');
const { startHeartbeat, stopHeartbeat } = require('./realtime/heartbeat');
const { initializeResetScheduler } = require('./services/systemReset');
const logger = require('./utils/logger');

const PORT = process.env.PORT || 5050;

async function startServer() {
    await initializeDatabase();

    const server = http.createServer(app);

    const io = socketIO(server, {
        cors: {
            origin: '*',
            methods: ['GET', 'POST']
        }
    });

    app.set('io', io);
    setupSocketIO(io);
    await initializeResetScheduler(io);

    await new Promise((resolve) => {
        server.listen(PORT, () => {
            logger.info({ port: PORT }, 'FlowMatic-SOLO server running');
            logger.info('Socket.IO server ready with connection tracking');
            startHeartbeat(io);
            resolve();
        });
    });

    return server;
}

let server;
startServer()
    .then((s) => {
        server = s;
    })
    .catch((error) => {
        logger.error({ err: error }, 'Failed to start server');
        // Rethrow to allow process manager (PM2) to handle restart.
        throw error;
    });

async function shutdown(signal) {
    logger.warn({ signal }, 'Shutdown signal received, closing server');

    if (!server) {
        logger.warn('Server not initialized; exiting');
        return;
    }

    await new Promise((resolve) => {
        server.close(resolve);
    });

    try {
        stopHeartbeat();
        await closeDatabase();
        logger.info('HTTP server closed gracefully');
    } catch (error) {
        logger.error({ err: error }, 'Error during shutdown');
    }
}

process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch((error) =>
        logger.error({ err: error }, 'Unhandled error during SIGTERM shutdown')
    );
});

process.on('SIGINT', () => {
    shutdown('SIGINT').catch((error) =>
        logger.error({ err: error }, 'Unhandled error during SIGINT shutdown')
    );
});
