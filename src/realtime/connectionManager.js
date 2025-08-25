// src/realtime/connectionManager.js
// Connection tracking for Socket.IO namespaces - Raspberry Pi optimized

class ConnectionManager {
  constructor() {
    // Track connections by namespace and socket ID
    this.connections = {
      '/kiosk': new Map(),
      '/terminal': new Map(),
      '/monitor': new Map(),
      '/customer': new Map()
    };
    
    // Track rooms joined by each socket
    this.socketRooms = new Map();
  }

  // Add a new connection
  addConnection(namespace, socket) {
    try {
      const ns = namespace.startsWith('/') ? namespace : `/${namespace}`;
      
      if (!this.connections[ns]) {
        console.error(`Unknown namespace: ${ns}`);
        return false;
      }

      // Store connection info
      this.connections[ns].set(socket.id, {
        id: socket.id,
        connectedAt: new Date(),
        lastActivity: new Date(),
        rooms: new Set()
      });

      // Initialize room tracking for this socket
      this.socketRooms.set(socket.id, new Set());

      console.log(`[ConnectionManager] Added ${socket.id} to ${ns}. Total: ${this.connections[ns].size}`);
      return true;
    } catch (error) {
      console.error('❌ Error adding connection:', error.message);
      return false;
    }
  }

  // Remove a connection
  removeConnection(namespace, socketId) {
    try {
      const ns = namespace.startsWith('/') ? namespace : `/${namespace}`;
      
      if (!this.connections[ns]) {
        return false;
      }

      const deleted = this.connections[ns].delete(socketId);
      
      // Clean up room tracking
      this.socketRooms.delete(socketId);

      if (deleted) {
        console.log(`[ConnectionManager] Removed ${socketId} from ${ns}. Total: ${this.connections[ns].size}`);
      }

      return deleted;
    } catch (error) {
      console.error('❌ Error removing connection:', error.message);
      return false;
    }
  }

  // Update last activity timestamp
  updateActivity(socketId) {
    try {
      // Check all namespaces for this socket
      for (const [ns, connections] of Object.entries(this.connections)) {
        const conn = connections.get(socketId);
        if (conn) {
          conn.lastActivity = new Date();
          return true;
        }
      }
      return false;
    } catch (error) {
      console.error('❌ Error updating activity:', error.message);
      return false;
    }
  }

  // Add socket to a room
  joinRoom(socketId, room) {
    try {
      const rooms = this.socketRooms.get(socketId);
      if (rooms) {
        rooms.add(room);
        
        // Update connection info
        for (const connections of Object.values(this.connections)) {
          const conn = connections.get(socketId);
          if (conn) {
            conn.rooms.add(room);
            break;
          }
        }
        
        console.log(`[ConnectionManager] Socket ${socketId} joined room: ${room}`);
        return true;
      }
      return false;
    } catch (error) {
      console.error('❌ Error joining room:', error.message);
      return false;
    }
  }

  // Remove socket from a room
  leaveRoom(socketId, room) {
    try {
      const rooms = this.socketRooms.get(socketId);
      if (rooms) {
        rooms.delete(room);
        
        // Update connection info
        for (const connections of Object.values(this.connections)) {
          const conn = connections.get(socketId);
          if (conn) {
            conn.rooms.delete(room);
            break;
          }
        }
        
        console.log(`[ConnectionManager] Socket ${socketId} left room: ${room}`);
        return true;
      }
      return false;
    } catch (error) {
      console.error('❌ Error leaving room:', error.message);
      return false;
    }
  }

  // Get connection count for a namespace
  getConnectionCount(namespace) {
    try {
      const ns = namespace.startsWith('/') ? namespace : `/${namespace}`;
      return this.connections[ns]?.size || 0;
    } catch (error) {
      console.error('❌ Error getting connection count:', error.message);
      return 0;
    }
  }

  // Get all connection counts
  getAllCounts() {
    try {
      const counts = {};
      for (const [ns, connections] of Object.entries(this.connections)) {
        counts[ns] = connections.size;
      }
      return counts;
    } catch (error) {
      console.error('❌ Error getting all counts:', error.message);
      return {};
    }
  }

  // Get connections in a specific room
  getConnectionsInRoom(room) {
    try {
      const connectionsInRoom = [];
      
      for (const [socketId, rooms] of this.socketRooms.entries()) {
        if (rooms.has(room)) {
          // Find which namespace this socket belongs to
          for (const [ns, connections] of Object.entries(this.connections)) {
            const conn = connections.get(socketId);
            if (conn) {
              connectionsInRoom.push({
                socketId,
                namespace: ns,
                connectedAt: conn.connectedAt,
                lastActivity: conn.lastActivity
              });
              break;
            }
          }
        }
      }
      
      return connectionsInRoom;
    } catch (error) {
      console.error('❌ Error getting connections in room:', error.message);
      return [];
    }
  }

  // Get stale connections (no activity for specified minutes)
  getStaleConnections(inactiveMinutes = 5) {
    try {
      const staleConnections = [];
      const cutoffTime = new Date(Date.now() - inactiveMinutes * 60 * 1000);
      
      for (const [ns, connections] of Object.entries(this.connections)) {
        for (const [socketId, conn] of connections.entries()) {
          if (conn.lastActivity < cutoffTime) {
            staleConnections.push({
              socketId,
              namespace: ns,
              lastActivity: conn.lastActivity,
              minutesInactive: Math.floor((Date.now() - conn.lastActivity) / 60000)
            });
          }
        }
      }
      
      return staleConnections;
    } catch (error) {
      console.error('❌ Error getting stale connections:', error.message);
      return [];
    }
  }

  // Get detailed connection info
  getConnectionInfo(socketId) {
    try {
      for (const [ns, connections] of Object.entries(this.connections)) {
        const conn = connections.get(socketId);
        if (conn) {
          return {
            socketId,
            namespace: ns,
            connectedAt: conn.connectedAt,
            lastActivity: conn.lastActivity,
            rooms: Array.from(conn.rooms),
            connectedMinutes: Math.floor((Date.now() - conn.connectedAt) / 60000)
          };
        }
      }
      return null;
    } catch (error) {
      console.error('❌ Error getting connection info:', error.message);
      return null;
    }
  }

  // Get summary statistics
  getStats() {
    try {
      const stats = {
        total: 0,
        byNamespace: {},
        byRoom: {},
        averageConnectionTime: 0
      };

      let totalConnectionTime = 0;
      
      // Count by namespace and calculate average connection time
      for (const [ns, connections] of Object.entries(this.connections)) {
        stats.byNamespace[ns] = connections.size;
        stats.total += connections.size;
        
        for (const conn of connections.values()) {
          totalConnectionTime += (Date.now() - conn.connectedAt);
        }
      }

      // Count by room
      for (const rooms of this.socketRooms.values()) {
        for (const room of rooms) {
          stats.byRoom[room] = (stats.byRoom[room] || 0) + 1;
        }
      }

      // Calculate average connection time
      if (stats.total > 0) {
        stats.averageConnectionTime = Math.floor(totalConnectionTime / stats.total / 60000); // in minutes
      }

      return stats;
    } catch (error) {
      console.error('❌ Error getting stats:', error.message);
      return { total: 0, byNamespace: {}, byRoom: {}, averageConnectionTime: 0 };
    }
  }

  // Clear all connections (for testing or reset)
  clearAll() {
    try {
      for (const connections of Object.values(this.connections)) {
        connections.clear();
      }
      this.socketRooms.clear();
      console.log('[ConnectionManager] All connections cleared');
    } catch (error) {
      console.error('❌ Error clearing connections:', error.message);
    }
  }
}

// Export singleton instance
module.exports = new ConnectionManager();