const http = require('http');
const socketIO = require('socket.io');
const app = require('./app');
const { initializeDatabase, closeDatabase } = require('./database/connection');
const { setupSocketIO } = require('./realtime/socketManager');
const { startHeartbeat, stopHeartbeat } = require('./realtime/heartbeat');

const PORT = process.env.PORT || 5050;

async function startServer() {
    try {
        await initializeDatabase();
        
        const server = http.createServer(app);
        
        // Create Socket.IO instance with CORS configuration
        const io = socketIO(server, {
            cors: {
                origin: '*',
                methods: ['GET', 'POST']
            }
        });
        
        // Make io available to routes (BUG FIX)
        app.set('io', io);
        
        // Setup namespaces and connection tracking
        setupSocketIO(io);
        
        server.listen(PORT, () => {
            console.log(`FlowMatic-SOLO server running on port ${PORT}`);
            console.log('Socket.IO server ready with connection tracking');
            
            // Start heartbeat system
            startHeartbeat(io);
        });
        
        return server;
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

let server;
startServer().then(s => { server = s; });

process.on('SIGTERM', async () => {
    console.log('SIGTERM signal received: closing HTTP server');
    if (server) {
        server.close(async () => {
            try {
                stopHeartbeat();
                await closeDatabase();
                console.log('HTTP server closed');
            } catch (error) {
                console.error('❌ Error during shutdown:', error.message);
            }
        });
    }
});

process.on('SIGINT', async () => {
    console.log('SIGINT signal received: closing HTTP server');
    if (server) {
        server.close(async () => {
            try {
                stopHeartbeat();
                await closeDatabase();
                console.log('HTTP server closed');
            } catch (error) {
                console.error('❌ Error during shutdown:', error.message);
            }
        });
    }
});