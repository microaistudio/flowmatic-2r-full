// src/realtime/heartbeat.js
// Heartbeat system for monitoring connection health

const connectionManager = require('./connectionManager');

// Configuration
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const HEARTBEAT_TIMEOUT = 60000;  // 60 seconds (client considered dead if no response)

// Storage for heartbeat tracking
const heartbeats = new Map();
let heartbeatInterval = null;
let ioInstance = null;

/**
 * Start the heartbeat system
 * @param {Object} io - Socket.IO instance
 */
function startHeartbeat(io) {
    try {
        ioInstance = io;
        if (heartbeatInterval) {
            console.log('Heartbeat system already running');
            return;
        }

        console.log('Starting heartbeat system...');
        
        // Send heartbeat ping to all connected clients
        heartbeatInterval = setInterval(() => {
            const io = ioInstance;
            if (!io) {
                console.error('Socket.IO instance not available for heartbeat');
                return;
            }
            const now = Date.now();
            
            // Get all connections
            const stats = connectionManager.getStats();
            
            // Send ping to each namespace
            ['kiosk', 'terminal', 'monitor', 'customer'].forEach(namespace => {
                const ns = io.of(`/${namespace}`);
                
                // Emit heartbeat ping to all connected clients in this namespace
                ns.emit('heartbeat-ping', {
                    timestamp: now,
                    server: 'FlowMatic-SOLO R2'
                });
            });
            
            // Check for dead connections
            checkDeadConnections();
            
        }, HEARTBEAT_INTERVAL);
        
        console.log(`Heartbeat system started (interval: ${HEARTBEAT_INTERVAL}ms)`);
    } catch (error) {
        console.error('❌ Error starting heartbeat:', error.message);
    }
}

/**
 * Stop the heartbeat system
 */
function stopHeartbeat() {
    try {
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
            heartbeats.clear();
            console.log('Heartbeat system stopped');
        }
    } catch (error) {
        console.error('❌ Error stopping heartbeat:', error.message);
    }
}

/**
 * Record heartbeat response from a client
 * @param {string} socketId - The socket ID
 * @param {string} namespace - The namespace
 */
function recordHeartbeat(socketId, namespace) {
    try {
        const key = `${namespace}:${socketId}`;
        heartbeats.set(key, {
            lastSeen: Date.now(),
            namespace,
            socketId
        });
    } catch (error) {
        console.error('❌ Error recording heartbeat:', error.message);
    }
}

/**
 * Check for dead connections
 */
function checkDeadConnections() {
    try {
        const now = Date.now();
        const deadConnections = [];
        
        // Check each recorded heartbeat
        heartbeats.forEach((data, key) => {
            if (now - data.lastSeen > HEARTBEAT_TIMEOUT) {
                deadConnections.push(data);
                heartbeats.delete(key);
            }
        });
        
        // Report dead connections
        if (deadConnections.length > 0) {
            console.log(`Detected ${deadConnections.length} dead connections:`, deadConnections);
            
            // Emit alert to admin namespace
            if (ioInstance) {
                ioInstance.of('/admin').emit('dead-connections', {
                    count: deadConnections.length,
                    connections: deadConnections,
                    timestamp: new Date()
                });
            }
        }
    } catch (error) {
        console.error('❌ Error checking dead connections:', error.message);
    }
}

/**
 * Get heartbeat statistics
 */
function getHeartbeatStats() {
    try {
        const now = Date.now();
        const stats = {
            totalTracked: heartbeats.size,
            namespaces: {},
            healthy: 0,
            warning: 0,
            dead: 0
        };
        
        // Analyze each heartbeat
        heartbeats.forEach((data) => {
            const age = now - data.lastSeen;
            
            // Count by namespace
            if (!stats.namespaces[data.namespace]) {
                stats.namespaces[data.namespace] = {
                    total: 0,
                    healthy: 0,
                    warning: 0
                };
            }
            stats.namespaces[data.namespace].total++;
            
            // Categorize by health
            if (age < HEARTBEAT_INTERVAL * 1.5) {
                stats.healthy++;
                stats.namespaces[data.namespace].healthy++;
            } else if (age < HEARTBEAT_TIMEOUT) {
                stats.warning++;
                stats.namespaces[data.namespace].warning++;
            } else {
                stats.dead++;
            }
        });
        
        return stats;
    } catch (error) {
        console.error('❌ Error getting heartbeat stats:', error.message);
        return {
            totalTracked: 0,
            namespaces: {},
            healthy: 0,
            warning: 0,
            dead: 0
        };
    }
}

/**
 * Setup heartbeat handlers for a socket
 * @param {Socket} socket - The socket instance
 * @param {string} namespace - The namespace
 */
function setupHeartbeatHandlers(socket, namespace) {
    try {
        // Handle heartbeat response
        socket.on('heartbeat-pong', (data) => {
            recordHeartbeat(socket.id, namespace);
            
            // Update activity in connection manager
            connectionManager.updateActivity(socket.id);
        });
        
        // Record initial heartbeat
        recordHeartbeat(socket.id, namespace);
    } catch (error) {
        console.error('❌ Error setting up heartbeat handlers:', error.message);
    }
}

module.exports = {
    startHeartbeat,
    stopHeartbeat,
    recordHeartbeat,
    getHeartbeatStats,
    setupHeartbeatHandlers,
    HEARTBEAT_INTERVAL,
    HEARTBEAT_TIMEOUT
};