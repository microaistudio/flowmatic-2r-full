// src/realtime/socketManager.js
// UPDATED VERSION with connection management for Phase 2.3

const connectionManager = require('./connectionManager');
const { INBOUND_EVENTS } = require('./eventTypes');
const { setupHeartbeatHandlers } = require('./heartbeat');

// Store reference to io instance (NEW)
let io = null;

// Setup Socket.IO with namespaces (UPDATED SIGNATURE)
function setupSocketIO(socketIO) {
  try {
    io = socketIO;  // Store reference (NEW)
    
    // Setup namespaces as defined in architecture
    const namespaces = [
      '/kiosk',
      '/terminal', 
      '/monitor',
      '/customer'
    ];

    namespaces.forEach(namespace => {
      io.of(namespace).on('connection', (socket) => {
        try {
          // Add to connection manager (NEW)
          connectionManager.addConnection(namespace, socket);
          
          console.log(`Client connected to ${namespace}: ${socket.id}`);

          // Handle disconnection
          socket.on('disconnect', (reason) => {
            try {
              console.log(`Client disconnected from ${namespace}: ${socket.id} (${reason})`);
              connectionManager.removeConnection(namespace, socket.id); // NEW
            } catch (error) {
              console.error('❌ Error handling disconnect:', error.message);
            }
          });

          // NEW: Handle join-service event (for targeted broadcasts)
          socket.on(INBOUND_EVENTS.JOIN_SERVICE, (data) => {
            try {
              if (data && data.serviceId) {
                const room = `service-${data.serviceId}`;
                socket.join(room);
                connectionManager.joinRoom(socket.id, room);
                console.log(`Socket ${socket.id} joined room: ${room}`);
                
                // Send acknowledgment
                socket.emit('joined', { room, serviceId: data.serviceId });
              }
            } catch (error) {
              console.error('❌ Error joining service room:', error.message);
            }
          });

          // NEW: Handle join-counter event (for counter-specific updates)
          socket.on(INBOUND_EVENTS.JOIN_COUNTER, (data) => {
            try {
              if (data && data.counterId) {
                const room = `counter-${data.counterId}`;
                socket.join(room);
                connectionManager.joinRoom(socket.id, room);
                console.log(`Socket ${socket.id} joined room: ${room}`);
                
                // Send acknowledgment
                socket.emit('joined', { room, counterId: data.counterId });
              }
            } catch (error) {
              console.error('❌ Error joining counter room:', error.message);
            }
          });

          // NEW: Handle join-all event (for monitoring all updates)
          socket.on(INBOUND_EVENTS.JOIN_ALL, () => {
            try {
              const room = 'all-updates';
              socket.join(room);
              connectionManager.joinRoom(socket.id, room);
              console.log(`Socket ${socket.id} joined room: ${room}`);
              
              // Send acknowledgment
              socket.emit('joined', { room });
            } catch (error) {
              console.error('❌ Error joining all-updates room:', error.message);
            }
          });

          // NEW: Update activity on any event
          socket.onAny(() => {
            try {
              connectionManager.updateActivity(socket.id);
            } catch (error) {
              console.error('❌ Error updating activity:', error.message);
            }
          });

          // NEW: Setup heartbeat handlers
          setupHeartbeatHandlers(socket, namespace);
          
          // NEW: Send welcome message with connection info
          socket.emit('welcome', {
            namespace,
            socketId: socket.id,
            connectedAt: new Date(),
            server: 'FlowMatic-SOLO R2'
          });
        } catch (error) {
          console.error('❌ Error setting up socket connection:', error.message);
        }
      });
    });

    // NEW: Add admin endpoint for connection stats
    io.of('/admin').on('connection', (socket) => {
      try {
        console.log(`Admin connected: ${socket.id}`);
        
        socket.on('get-stats', () => {
          try {
            socket.emit('stats', connectionManager.getStats());
          } catch (error) {
            console.error('❌ Error getting stats:', error.message);
          }
        });

        socket.on('get-connections', () => {
          try {
            socket.emit('connections', connectionManager.getAllCounts());
          } catch (error) {
            console.error('❌ Error getting connections:', error.message);
          }
        });

        socket.on('disconnect', () => {
          try {
            console.log(`Admin disconnected: ${socket.id}`);
          } catch (error) {
            console.error('❌ Error handling admin disconnect:', error.message);
          }
        });
      } catch (error) {
        console.error('❌ Error setting up admin connection:', error.message);
      }
    });

    console.log('Socket.IO namespaces initialized with connection tracking');
  } catch (error) {
    console.error('❌ Error setting up Socket.IO:', error.message);
    throw error;
  }
}

// NEW: Get Socket.IO instance
function getIO() {
  try {
    if (!io) {
      throw new Error('Socket.IO not initialized. Call setupSocketIO first.');
    }
    return io;
  } catch (error) {
    console.error('❌ Error getting IO instance:', error.message);
    throw error;
  }
}

// NEW: Get specific namespace
function getNamespace(namespace) {
  try {
    const io = getIO();
    return io.of(namespace);
  } catch (error) {
    console.error('❌ Error getting namespace:', error.message);
    throw error;
  }
}

// NEW: Get connection stats
function getConnectionStats() {
  try {
    return connectionManager.getStats();
  } catch (error) {
    console.error('❌ Error getting connection stats:', error.message);
    return { total: 0, byNamespace: {}, byRoom: {}, averageConnectionTime: 0 };
  }
}

// NEW: Get connections in a specific room
function getRoomConnections(room) {
  try {
    return connectionManager.getConnectionsInRoom(room);
  } catch (error) {
    console.error('❌ Error getting room connections:', error.message);
    return [];
  }
}

module.exports = {
  setupSocketIO,
  getIO,           // NEW export
  getNamespace,    // NEW export
  getConnectionStats,  // NEW export
  getRoomConnections   // NEW export
};