const express = require('express');
const router = express.Router();
const { getDb } = require('../database/connection');

// Health check endpoint
router.get('/', (req, res) => {
    const db = getDb();
    
    // Basic health check
    const healthStatus = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        service: 'FlowMatic-SOLO',
        version: '2.0.0',
        uptime: process.uptime(),
        memory: {
            used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
            total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
            percentage: Math.round((process.memoryUsage().heapUsed / process.memoryUsage().heapTotal) * 100)
        }
    };
    
    // Quick database check
    db.get('SELECT COUNT(*) as count FROM services', (err, result) => {
        if (err) {
            healthStatus.database = 'error';
            healthStatus.status = 'unhealthy';
        } else {
            healthStatus.database = 'connected';
            healthStatus.services = result.count;
        }
        
        // Get Socket.IO connections if available
        const io = req.app.get('io');
        if (io && io.engine) {
            healthStatus.socketConnections = io.engine.clientsCount || 0;
        }
        
        res.json(healthStatus);
    });
});

module.exports = router;