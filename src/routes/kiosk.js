const express = require('express');
const router = express.Router();
const { getDb } = require('../database/connection');
const { logEvent, EventTypes } = require('../database/events');
const { broadcastTicketCreated } = require('../realtime/eventBroadcaster');

// NO PRINTER DEPENDENCIES - All printing handled client-side!

router.get('/services', (req, res) => {
    const db = getDb();
    
    // Get all active services
    db.all(
        'SELECT * FROM services WHERE is_active = 1 ORDER BY id',
        (err, services) => {
            if (err) {
                return res.status(500).json({ error: 'Failed to fetch services' });
            }
            
            if (!services || services.length === 0) {
                return res.json({ services: [] });
            }
            
            let completedServices = 0;
            const serviceResults = [];
            
            // For each service, get queue statistics
            services.forEach((service, index) => {
                db.all(
                    `SELECT 
                        COUNT(CASE WHEN state = 'waiting' THEN 1 END) as waiting_count,
                        COUNT(CASE WHEN state = 'called' THEN 1 END) as serving_count,
                        MIN(CASE WHEN state = 'called' THEN ticket_number END) as current_serving
                     FROM tickets 
                     WHERE service_id = ? AND state IN ('waiting', 'called')`,
                    [service.id],
                    (err, result) => {
                        const stats = result[0] || { waiting_count: 0, serving_count: 0, current_serving: null };
                        
                        // Get average wait time from recent completed tickets
                        db.get(
                            `SELECT AVG(actual_wait) as avg_wait 
                             FROM tickets 
                             WHERE service_id = ? 
                             AND state = 'completed' 
                             AND actual_wait IS NOT NULL
                             AND created_at > datetime('now', '-1 hour')`,
                            [service.id],
                            (err, avgResult) => {
                                const avgWaitSeconds = avgResult && avgResult.avg_wait ? Math.round(avgResult.avg_wait) : 180;
                                const avgWaitMinutes = Math.ceil(avgWaitSeconds / 60);
                                
                                // Calculate estimated wait time based on queue and average
                                const estimatedWaitMinutes = stats.waiting_count > 0 
                                    ? Math.ceil((stats.waiting_count * avgWaitSeconds) / 60)
                                    : 0;
                                    
                                // Real wait time (slightly randomized for realism)
                                const realWaitTime = estimatedWaitMinutes > 0 
                                    ? Math.max(1, estimatedWaitMinutes + Math.floor(Math.random() * 3) - 1)
                                    : 0;
                                
                                serviceResults[index] = {
                                    id: service.id,
                                    name: service.name,
                                    description: service.description || `${service.name} - Professional service`,
                                    prefix: service.prefix,
                                    queueCount: stats.waiting_count,
                                    nowServing: stats.current_serving || 'None',
                                    realWaitTime: realWaitTime,
                                    estimatedWaitMinutes: estimatedWaitMinutes,
                                    currentServing: stats.current_serving || null,
                                    servingCount: stats.serving_count,
                                    serving: stats.serving_count,
                                    avgWaitTime: avgWaitMinutes
                                };
                                
                                completedServices++;
                                
                                // When all services are processed, send response
                                if (completedServices === services.length) {
                                    res.json({
                                        services: serviceResults.filter(s => s !== undefined)
                                    });
                                }
                            }
                        );
                    }
                );
            });
        }
    );
});

router.post('/tickets', (req, res) => {
    try {
        const { serviceId, customerName, customerPhone, customerEmail, priority } = req.body;
        
        if (!serviceId) {
            return res.status(400).json({ error: 'serviceId is required' });
        }
        
        const db = getDb();
        
        db.serialize(() => {
            db.run('BEGIN TRANSACTION');
            
            db.get(
                'SELECT * FROM services WHERE id = ? AND is_active = 1',
                [serviceId],
                (err, service) => {
                    if (err) {
                        db.run('ROLLBACK');
                        return res.status(500).json({ error: 'Database error' });
                    }
                    
                    if (!service) {
                        db.run('ROLLBACK');
                        return res.status(400).json({ error: 'Invalid or inactive service' });
                    }
                    
                    const nextNumber = service.current_number + 1;
                    const ticketNumber = `${service.prefix}${String(nextNumber).padStart(3, '0')}`;
                    
                    db.run(
                        'UPDATE services SET current_number = ? WHERE id = ?',
                        [nextNumber, serviceId],
                        (err) => {
                            if (err) {
                                db.run('ROLLBACK');
                                return res.status(500).json({ error: 'Failed to update service counter' });
                            }
                            
                            const estimatedWait = nextNumber * service.estimated_service_time;
                            
                            db.run(
                                `INSERT INTO tickets (
                                    ticket_number, service_id, state, customer_name, 
                                    customer_phone, customer_email, estimated_wait, priority
                                ) VALUES (?, ?, 'waiting', ?, ?, ?, ?, ?)`,
                                [ticketNumber, serviceId, customerName, customerPhone, customerEmail, estimatedWait, priority || 0],
                                function(err) {
                                    if (err) {
                                        db.run('ROLLBACK');
                                        return res.status(500).json({ error: 'Failed to create ticket' });
                                    }
                                    
                                    const ticketId = this.lastID;
                                    
                                    // Log the event
                                    logEvent(
                                        EventTypes.TICKET_CREATED,
                                        'ticket',
                                        ticketId,
                                        {
                                            ticketNumber,
                                            serviceId,
                                            serviceName: service.name,
                                            customerName: customerName || 'Anonymous'
                                        }
                                    ).catch(err => console.error('Event logging failed:', err));
                                    
                                    db.run('COMMIT', (err) => {
                                        if (err) {
                                            return res.status(500).json({ error: 'Failed to commit transaction' });
                                        }
                                        
                                        // Get queue count for the service
                                        db.get('SELECT COUNT(*) as count FROM tickets WHERE service_id = ? AND state = ?', 
                                            [serviceId, 'waiting'], 
                                            (err, result) => {
                                                const queueCount = result ? result.count : 0;
                                                
                                                // Broadcast the event
                                                const io = req.app.get('io');
                                                if (io) {
                                                    broadcastTicketCreated(io, {
                                                        id: ticketId,
                                                        ticketNumber: ticketNumber,
                                                        serviceId: serviceId,
                                                        serviceName: service.name,
                                                        state: 'waiting',
                                                        customerName: customerName || 'Anonymous',
                                                        createdAt: new Date().toISOString()
                                                    }, {
                                                        serviceId: serviceId,
                                                        waiting: queueCount
                                                    });
                                                }
                                                
                                                // Send response
                                                res.status(201).json({
                                                    success: true,
                                                    ticket: {
                                                        id: ticketId,
                                                        ticketNumber: ticketNumber,
                                                        serviceId: serviceId,
                                                        serviceName: service.name,
                                                        state: 'waiting',
                                                        estimatedWait: estimatedWait,
                                                        estimatedWaitMinutes: Math.ceil(estimatedWait / 60),
                                                        createdAt: new Date().toISOString(),
                                                        queuePosition: queueCount
                                                    }
                                                });
                                            }
                                        );
                                    });
                                }
                            );
                        }
                    );
                }
            );
        });
    } catch (error) {
        console.error('❌ Error in POST /kiosk/tickets:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Print endpoint - just validates data and returns success
// Actual printing happens on the client side!
router.post('/print-ticket', async (req, res) => {
    try {
        const { ticketData } = req.body;
        
        if (!ticketData || !ticketData.number) {
            return res.status(400).json({ 
                success: false, 
                error: 'ticketData with number is required' 
            });
        }
        
        console.log('🖨️ Print ticket request received:', ticketData.number);
        
        // Server just acknowledges the print request
        // Client handles actual printing
        res.json({ 
            success: true,
            message: 'Print data validated',
            ticket: ticketData.number,
            timestamp: new Date().toISOString(),
            note: 'Client-side printing enabled'
        });
        
    } catch (error) {
        console.error('❌ Print validation error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Print validation failed',
            details: error.message 
        });
    }
});

// Printer configuration endpoint - returns client print settings
router.get('/printer-config', (req, res) => {
    const db = getDb();
    
    // Get printer settings from database
    db.all(
        "SELECT key, value FROM settings WHERE key LIKE 'printer.%'",
        (err, rows) => {
            if (err) {
                return res.status(500).json({ error: 'Failed to fetch printer settings' });
            }
            
            const config = rows.reduce((acc, row) => {
                const key = row.key.replace('printer.', '');
                acc[key] = row.value;
                return acc;
            }, {});
            
            // Default printer configuration for client
            const printerConfig = {
                method: config.method || 'browser', // 'browser', 'qz', 'webusb', 'server'
                printerName: config.name || 'TM-T203',
                paperWidth: parseInt(config.width) || 58, // mm
                autoprint: config.autoprint === 'true',
                localServerUrl: config.localServerUrl || 'http://localhost:9100',
                ...config
            };
            
            res.json(printerConfig);
        }
    );
});

// Health check endpoint for printer service
router.get('/printer-health', (req, res) => {
    // This endpoint is called by client to check if server is reachable
    // Actual printer status is determined client-side
    res.json({ 
        status: 'ok',
        message: 'Server ready for print requests',
        clientPrinting: true,
        timestamp: new Date().toISOString()
    });
});

module.exports = router;