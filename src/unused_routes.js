const express = require('express');
const router = express.Router();
const { getDb } = require('./database/connection');
const { logEvent, EventTypes } = require('./database/events');
const { broadcastTicketCreated, broadcastTicketCalled, broadcastTicketCompleted, broadcastQueueUpdated } = require('./realtime/eventBroadcaster');

// Health check endpoint
router.get('/health', (req, res) => {
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

router.get('/kiosk/services', (req, res) => {
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
                                    queueCount: stats.waiting_count,
                                    nowServing: stats.current_serving || 'None',
                                    realWaitTime: realWaitTime,
                                    estimatedWaitTime: estimatedWaitMinutes,
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

router.post('/kiosk/tickets', (req, res) => {
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
                                                
                                                // Broadcast the event with camelCase fields
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
                                                
                                                // Send response with success wrapper
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

router.post('/terminal/call-next', (req, res) => {
    const { counterId, agentId } = req.body;
    
    if (!counterId || !agentId) {
        return res.status(400).json({ error: 'counterId and agentId are required' });
    }
    
    const db = getDb();
    
    db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        
        db.get(
            `SELECT service_id, priority 
             FROM agent_services
             WHERE agent_id = ?
             ORDER BY priority`,
            [agentId],
            (err, agentService) => {
                if (err) {
                    console.error('Error querying agent_services:', err);
                    db.run('ROLLBACK');
                    return res.status(500).json({ error: 'Database error', details: err.message });
                }
                
                if (!agentService) {
                    db.run('ROLLBACK');
                    return res.status(400).json({ error: 'Agent has no assigned services' });
                }
                
                db.get(
                    `SELECT t.*, s.name as service_name, s.prefix 
                     FROM tickets t
                     JOIN services s ON t.service_id = s.id
                     WHERE t.service_id = ? AND t.state = 'waiting'
                     ORDER BY t.created_at
                     LIMIT 1`,
                    [agentService.service_id],
                    (err, ticket) => {
                        if (err) {
                            console.error('Error finding next ticket:', err);
                            db.run('ROLLBACK');
                            return res.status(500).json({ error: 'Failed to find next ticket', details: err.message });
                        }
                        
                        if (!ticket) {
                            db.run('ROLLBACK');
                            return res.status(404).json({ error: 'No tickets waiting in queue' });
                        }
                        
                        const now = new Date().toISOString();
                        
                        db.run(
                            `UPDATE tickets 
                             SET state = 'called', 
                                 called_at = ?,
                                 served_at = ?,
                                 counter_id = ?,
                                 agent_id = ?,
                                 recall_count = recall_count + 1
                             WHERE id = ?`,
                            [now, now, counterId, agentId, ticket.id],
                            (err) => {
                                if (err) {
                                    db.run('ROLLBACK');
                                    return res.status(500).json({ error: 'Failed to update ticket' });
                                }
                                
                                db.run(
                                    `UPDATE counters 
                                     SET current_ticket_id = ?,
                                         current_agent_id = ?,
                                         state = 'serving'
                                     WHERE id = ?`,
                                    [ticket.id, agentId, counterId],
                                    (err) => {
                                        if (err) {
                                            db.run('ROLLBACK');
                                            return res.status(500).json({ error: 'Failed to update counter' });
                                        }
                                        
                                        // Log the event
                                        logEvent(
                                            EventTypes.TICKET_CALLED,
                                            'ticket',
                                            ticket.id,
                                            {
                                                ticketNumber: ticket.ticket_number,
                                                serviceId: ticket.service_id,
                                                counterId,
                                                agentId,
                                                previousState: 'waiting'
                                            },
                                            agentId,
                                            counterId
                                        ).catch(err => console.error('Event logging failed:', err));
                                        
                                        db.run('COMMIT', (err) => {
                                            if (err) {
                                                return res.status(500).json({ error: 'Failed to commit transaction' });
                                            }
                                            
                                            // Get counter and agent info (hardcoded for now)
                                            const counterData = { id: counterId, name: `Counter ${counterId}`, number: counterId };
                                            const agentData = { id: agentId, name: 'Agent' };
                                            
                                            // Broadcast the event with camelCase fields
                                            const io = req.app.get('io');
                                            if (io) {
                                                broadcastTicketCalled(io, {
                                                    id: ticket.id,
                                                    ticketNumber: ticket.ticket_number,
                                                    serviceId: ticket.service_id,
                                                    serviceName: ticket.service_name,
                                                    state: 'called',
                                                    counterId: counterId,
                                                    agentId: agentId,
                                                    customerName: ticket.customer_name,
                                                    calledAt: now
                                                }, counterData, agentData);
                                            }
                                            
                                            // Get queue counts for the service
                                            db.all(
                                                `SELECT state, COUNT(*) as count FROM tickets 
                                                 WHERE service_id = ? AND state IN ('waiting', 'called')
                                                 GROUP BY state`,
                                                [ticket.service_id],
                                                (err, counts) => {
                                                    let waitingCount = 0;
                                                    let servingCount = 0;
                                                    
                                                    if (counts && !err) {
                                                        counts.forEach(row => {
                                                            if (row.state === 'waiting') waitingCount = row.count;
                                                            if (row.state === 'called') servingCount = row.count;
                                                        });
                                                    }
                                                    
                                                    res.json({
                                                        ticket: {
                                                            id: ticket.id,
                                                            number: ticket.ticket_number,
                                                            serviceId: ticket.service_id,
                                                            serviceName: ticket.service_name,
                                                            customerName: ticket.customer_name,
                                                            state: 'called',
                                                            counterId,
                                                            agentId,
                                                            calledAt: now
                                                        },
                                                        queueUpdate: {
                                                            serviceId: ticket.service_id,
                                                            waiting: waitingCount,
                                                            serving: servingCount
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
    });
});

router.post('/terminal/complete', (req, res) => {
    const { ticketId, counterId, agentId, notes } = req.body;
    
    if (!ticketId || !counterId || !agentId) {
        return res.status(400).json({ error: 'ticketId, counterId, and agentId are required' });
    }
    
    const db = getDb();
    
    db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        
        db.get(
            `SELECT * FROM tickets WHERE id = ? AND counter_id = ? AND agent_id = ?`,
            [ticketId, counterId, agentId],
            (err, ticket) => {
                if (err) {
                    db.run('ROLLBACK');
                    return res.status(500).json({ error: 'Database error' });
                }
                
                if (!ticket) {
                    db.run('ROLLBACK');
                    return res.status(404).json({ error: 'Ticket not found or not assigned to this counter/agent' });
                }
                
                if (ticket.state === 'completed') {
                    db.run('ROLLBACK');
                    return res.status(400).json({ error: 'Ticket already completed' });
                }
                
                const now = new Date();
                const completedAt = now.toISOString();
                const servedAt = ticket.served_at || ticket.called_at;
                
                let actualWait = null;
                let serviceDuration = null;
                
                if (ticket.created_at && servedAt) {
                    actualWait = Math.floor((new Date(servedAt) - new Date(ticket.created_at)) / 1000);
                }
                
                if (servedAt) {
                    serviceDuration = Math.floor((now - new Date(servedAt)) / 1000);
                }
                
                db.run(
                    `UPDATE tickets 
                     SET state = 'completed',
                         completed_at = ?,
                         actual_wait = ?,
                         service_duration = ?,
                         notes = ?
                     WHERE id = ?`,
                    [completedAt, actualWait, serviceDuration, notes, ticketId],
                    (err) => {
                        if (err) {
                            db.run('ROLLBACK');
                            return res.status(500).json({ error: 'Failed to update ticket' });
                        }
                        
                        db.run(
                            `UPDATE counters 
                             SET current_ticket_id = NULL,
                                 state = 'available'
                             WHERE id = ?`,
                            [counterId],
                            (err) => {
                                if (err) {
                                    db.run('ROLLBACK');
                                    return res.status(500).json({ error: 'Failed to update counter' });
                                }
                                
                                // Log the event
                                logEvent(
                                    EventTypes.TICKET_COMPLETED,
                                    'ticket',
                                    ticketId,
                                    {
                                        ticketNumber: ticket.ticket_number,
                                        serviceId: ticket.service_id,
                                        serviceDurationSeconds: serviceDuration,
                                        actualWaitSeconds: actualWait
                                    },
                                    agentId,
                                    counterId
                                ).catch(err => console.error('Event logging failed:', err));
                                
                                db.run('COMMIT', (err) => {
                                    if (err) {
                                        return res.status(500).json({ error: 'Failed to commit transaction' });
                                    }
                                    
                                    // Get queue counts for the service
                                    db.all(
                                        `SELECT state, COUNT(*) as count FROM tickets 
                                         WHERE service_id = ? AND state IN ('waiting', 'called')
                                         GROUP BY state`,
                                        [ticket.service_id],
                                        (err, counts) => {
                                            let waitingCount = 0;
                                            let servingCount = 0;
                                            
                                            if (counts && !err) {
                                                counts.forEach(row => {
                                                    if (row.state === 'waiting') waitingCount = row.count;
                                                    if (row.state === 'called') servingCount = row.count;
                                                });
                                            }
                                            
                                            // Broadcast completion event with camelCase fields
                                            const io = req.app.get('io');
                                            if (io) {
                                                broadcastTicketCompleted(io, {
                                                    id: ticketId,
                                                    ticketNumber: ticket.ticket_number,
                                                    serviceId: ticket.service_id,
                                                    state: 'completed',
                                                    counterId: counterId,
                                                    agentId: agentId,
                                                    completedAt: completedAt,
                                                    serviceDuration: serviceDuration,
                                                    actualWait: actualWait
                                                }, {
                                                    serviceId: ticket.service_id,
                                                    waiting: waitingCount
                                                });
                                            }
                                            
                                            res.json({
                                                ticket: {
                                                    id: ticketId,
                                                    number: ticket.ticket_number,
                                                    state: 'completed',
                                                    completedAt
                                                },
                                                queueUpdate: {
                                                    serviceId: ticket.service_id,
                                                    waiting: waitingCount,
                                                    serving: servingCount
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
});

router.get('/terminal/queue/:serviceId', (req, res) => {
    const serviceId = parseInt(req.params.serviceId);
    
    if (isNaN(serviceId)) {
        return res.status(400).json({ error: 'Invalid service ID' });
    }
    
    const db = getDb();
    
    // Get service details
    db.get(
        'SELECT * FROM services WHERE id = ? AND is_active = 1',
        [serviceId],
        (err, service) => {
            if (err) {
                return res.status(500).json({ error: 'Database error' });
            }
            
            if (!service) {
                return res.status(404).json({ error: 'Service not found' });
            }
            
            // Get waiting tickets for this service
            db.all(
                `SELECT id, ticket_number as number, state, estimated_wait, 
                        created_at, customer_name, priority
                 FROM tickets 
                 WHERE service_id = ? AND state = 'waiting'
                 ORDER BY priority DESC, created_at ASC`,
                [serviceId],
                (err, tickets) => {
                    if (err) {
                        return res.status(500).json({ error: 'Failed to fetch queue' });
                    }
                    
                    // Get queue statistics
                    db.all(
                        `SELECT state, COUNT(*) as count FROM tickets 
                         WHERE service_id = ? AND state IN ('waiting', 'called')
                         GROUP BY state`,
                        [serviceId],
                        (err, counts) => {
                            let waitingCount = 0;
                            let servingCount = 0;
                            
                            if (counts && !err) {
                                counts.forEach(row => {
                                    if (row.state === 'waiting') waitingCount = row.count;
                                    if (row.state === 'called') servingCount = row.count;
                                });
                            }
                            
                            // Calculate average wait time (mock for now)
                            db.get(
                                `SELECT AVG(actual_wait) as avg_wait 
                                 FROM tickets 
                                 WHERE service_id = ? 
                                 AND state = 'completed' 
                                 AND actual_wait IS NOT NULL
                                 AND created_at > datetime('now', '-1 hour')`,
                                [serviceId],
                                (err, avgResult) => {
                                    const averageWait = avgResult && avgResult.avg_wait 
                                        ? Math.round(avgResult.avg_wait) 
                                        : 180; // Default 3 minutes
                                    
                                    // Format tickets with estimated wait
                                    const formattedTickets = tickets.map(ticket => ({
                                        id: ticket.id,
                                        number: ticket.number,
                                        state: ticket.state,
                                        estimatedWait: ticket.estimated_wait || averageWait,
                                        priority: ticket.priority || 0,
                                        createdAt: ticket.created_at
                                    }));
                                    
                                    res.json({
                                        service: {
                                            id: service.id,
                                            name: service.name,
                                            prefix: service.prefix
                                        },
                                        queue: formattedTickets,
                                        stats: {
                                            waiting: waitingCount,
                                            serving: servingCount,
                                            averageWait: averageWait
                                        }
                                    });
                                }
                            );
                        }
                    );
                }
            );
        }
    );
});

router.get('/terminal/session', (req, res) => {
    // For development, return mock session data
    // In production, this would check actual session/auth status
    
    // Mock session exists - in real app, check auth headers or session
    const hasSession = true;
    
    if (!hasSession) {
        return res.status(404).json({ error: 'No active session' });
    }
    
    // Mock session data
    const sessionData = {
        agentId: 1,
        agentName: "John Smith",
        counterId: 1,
        counterNumber: 1,
        serviceName: "General Service",
        services: [1],
        loginTime: new Date().toISOString()
    };
    
    res.json(sessionData);
});

router.post('/terminal/login', (req, res) => {
    const { username, password, counterId } = req.body;
    
    if (!username || !password || !counterId) {
        return res.status(400).json({ error: 'username, password, and counterId are required' });
    }
    
    const db = getDb();
    
    // For development, accept any credentials
    // In production, validate against database
    const mockValidCredentials = true;
    
    if (!mockValidCredentials) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    // Mock agent data - in production, fetch from database
    const agentId = 1;
    const agentName = username === 'john.smith' ? 'John Smith' : 'Agent';
    
    // Get counter details
    db.get(
        'SELECT * FROM counters WHERE id = ?',
        [counterId],
        (err, counter) => {
            if (err) {
                return res.status(500).json({ error: 'Database error' });
            }
            
            if (!counter) {
                return res.status(404).json({ error: 'Counter not found' });
            }
            
            // Get agent's assigned services
            db.all(
                'SELECT service_id FROM agent_services WHERE agent_id = ? ORDER BY priority',
                [agentId],
                (err, services) => {
                    if (err) {
                        return res.status(500).json({ error: 'Failed to fetch agent services' });
                    }
                    
                    const serviceIds = services.map(s => s.service_id);
                    const loginTime = new Date().toISOString();
                    
                    // Update counter with current agent
                    db.run(
                        'UPDATE counters SET current_agent_id = ?, state = ? WHERE id = ?',
                        [agentId, 'available', counterId],
                        (err) => {
                            if (err) {
                                return res.status(500).json({ error: 'Failed to update counter' });
                            }
                            
                            // Log the event
                            logEvent(
                                EventTypes.AGENT_LOGIN,
                                'agent',
                                agentId,
                                {
                                    agentName,
                                    counterId,
                                    services: serviceIds
                                },
                                agentId,
                                counterId
                            ).catch(err => console.error('Event logging failed:', err));
                            
                            // Generate session ID (mock for now)
                            const sessionId = `session-${agentId}-${counterId}-${Date.now()}`;
                            
                            res.json({
                                session: {
                                    agentId,
                                    agentName,
                                    counterId: counter.id,
                                    counterNumber: counter.number,
                                    counterName: counter.name || `Counter ${counter.number}`,
                                    services: serviceIds,
                                    loginTime,
                                    sessionId
                                },
                                success: true
                            });
                        }
                    );
                }
            );
        }
    );
});

router.post('/terminal/logout', (req, res) => {
    const { agentId, counterId } = req.body;
    
    if (!agentId || !counterId) {
        return res.status(400).json({ error: 'agentId and counterId are required' });
    }
    
    const db = getDb();
    const logoutTime = new Date().toISOString();
    
    // Update counter to remove agent
    db.run(
        'UPDATE counters SET current_agent_id = NULL, state = ? WHERE id = ? AND current_agent_id = ?',
        ['offline', counterId, agentId],
        function(err) {
            if (err) {
                return res.status(500).json({ error: 'Failed to update counter' });
            }
            
            if (this.changes === 0) {
                return res.status(400).json({ error: 'Agent not logged in to this counter' });
            }
            
            // Log the event
            logEvent(
                EventTypes.AGENT_LOGOUT,
                'agent',
                agentId,
                {
                    counterId,
                    logoutTime
                },
                agentId,
                counterId
            ).catch(err => console.error('Event logging failed:', err));
            
            res.json({
                success: true,
                message: 'Agent logged out successfully',
                session: {
                    agentId,
                    counterId,
                    logoutTime
                }
            });
        }
    );
});

router.post('/terminal/recall', (req, res) => {
    const { ticketId, counterId, agentId } = req.body;
    
    if (!ticketId || !counterId || !agentId) {
        return res.status(400).json({ error: 'ticketId, counterId, and agentId are required' });
    }
    
    const db = getDb();
    
    db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        
        db.get(
            `SELECT t.*, s.name as service_name 
             FROM tickets t
             JOIN services s ON t.service_id = s.id
             WHERE t.id = ? AND t.state = 'called' AND t.counter_id = ? AND t.agent_id = ?`,
            [ticketId, counterId, agentId],
            (err, ticket) => {
                if (err) {
                    db.run('ROLLBACK');
                    return res.status(500).json({ error: 'Database error' });
                }
                
                if (!ticket) {
                    db.run('ROLLBACK');
                    return res.status(404).json({ error: 'Ticket not found or not in called state' });
                }
                
                const now = new Date().toISOString();
                
                db.run(
                    `UPDATE tickets 
                     SET recall_count = recall_count + 1,
                         called_at = ?
                     WHERE id = ?`,
                    [now, ticketId],
                    (err) => {
                        if (err) {
                            db.run('ROLLBACK');
                            return res.status(500).json({ error: 'Failed to update ticket' });
                        }
                        
                        // Log the event
                        logEvent(
                            EventTypes.TICKET_RECALLED,
                            'ticket',
                            ticketId,
                            {
                                ticketNumber: ticket.ticket_number,
                                serviceId: ticket.service_id,
                                counterId,
                                agentId,
                                recallCount: ticket.recall_count + 1
                            },
                            agentId,
                            counterId
                        ).catch(err => console.error('Event logging failed:', err));
                        
                        db.run('COMMIT', (err) => {
                            if (err) {
                                return res.status(500).json({ error: 'Failed to commit transaction' });
                            }
                            
                            // Get queue counts for the service
                            db.all(
                                `SELECT state, COUNT(*) as count FROM tickets 
                                 WHERE service_id = ? AND state IN ('waiting', 'called')
                                 GROUP BY state`,
                                [ticket.service_id],
                                (err, counts) => {
                                    let waitingCount = 0;
                                    let servingCount = 0;
                                    
                                    if (counts && !err) {
                                        counts.forEach(row => {
                                            if (row.state === 'waiting') waitingCount = row.count;
                                            if (row.state === 'called') servingCount = row.count;
                                        });
                                    }
                                    
                                    // Broadcast recall event with camelCase fields
                                    const io = req.app.get('io');
                                    if (io) {
                                        broadcastTicketCalled(io, {
                                            id: ticketId,
                                            ticketNumber: ticket.ticket_number,
                                            serviceId: ticket.service_id,
                                            serviceName: ticket.service_name,
                                            state: 'called',
                                            counterId: counterId,
                                            agentId: agentId,
                                            customerName: ticket.customer_name,
                                            calledAt: now,
                                            recallCount: ticket.recall_count + 1
                                        }, 
                                        { id: counterId, name: `Counter ${counterId}`, number: counterId },
                                        { id: agentId, name: 'Agent' });
                                    }
                                    
                                    res.json({
                                        ticket: {
                                            id: ticketId,
                                            number: ticket.ticket_number,
                                            state: 'called',
                                            serviceId: ticket.service_id,
                                            counterId,
                                            agentId,
                                            recallCount: ticket.recall_count + 1,
                                            calledAt: now
                                        },
                                        queueUpdate: {
                                            serviceId: ticket.service_id,
                                            waiting: waitingCount,
                            serving: servingCount
                                        }
                                    });
                                }
                            );
                        });
                    }
                );
            }
        );
    });
});

router.post('/terminal/no-show', (req, res) => {
    const { ticketId, counterId, agentId } = req.body;
    
    if (!ticketId || !counterId || !agentId) {
        return res.status(400).json({ error: 'ticketId, counterId, and agentId are required' });
    }
    
    const db = getDb();
    
    db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        
        db.get(
            `SELECT t.*, s.name as service_name 
             FROM tickets t
             JOIN services s ON t.service_id = s.id
             WHERE t.id = ? AND t.state = 'called' AND t.counter_id = ? AND t.agent_id = ?`,
            [ticketId, counterId, agentId],
            (err, ticket) => {
                if (err) {
                    db.run('ROLLBACK');
                    return res.status(500).json({ error: 'Database error' });
                }
                
                if (!ticket) {
                    db.run('ROLLBACK');
                    return res.status(404).json({ error: 'Ticket not found or not in called state' });
                }
                
                const now = new Date().toISOString();
                
                db.run(
                    `UPDATE tickets 
                     SET state = 'no_show',
                         completed_at = ?
                     WHERE id = ?`,
                    [now, ticketId],
                    (err) => {
                        if (err) {
                            db.run('ROLLBACK');
                            return res.status(500).json({ error: 'Failed to update ticket' });
                        }
                        
                        db.run(
                            `UPDATE counters 
                             SET current_ticket_id = NULL,
                                 state = 'available'
                             WHERE id = ?`,
                            [counterId],
                            (err) => {
                                if (err) {
                                    db.run('ROLLBACK');
                                    return res.status(500).json({ error: 'Failed to update counter' });
                                }
                                
                                // Log the event
                                logEvent(
                                    EventTypes.TICKET_NO_SHOW,
                                    'ticket',
                                    ticketId,
                                    {
                                        ticketNumber: ticket.ticket_number,
                                        serviceId: ticket.service_id,
                                        counterId,
                                        agentId
                                    },
                                    agentId,
                                    counterId
                                ).catch(err => console.error('Event logging failed:', err));
                                
                                db.run('COMMIT', (err) => {
                                    if (err) {
                                        return res.status(500).json({ error: 'Failed to commit transaction' });
                                    }
                                    
                                    // Get queue counts for the service
                                    db.all(
                                        `SELECT state, COUNT(*) as count FROM tickets 
                                         WHERE service_id = ? AND state IN ('waiting', 'called')
                                         GROUP BY state`,
                                        [ticket.service_id],
                                        (err, counts) => {
                                            let waitingCount = 0;
                                            let servingCount = 0;
                                            
                                            if (counts && !err) {
                                                counts.forEach(row => {
                                                    if (row.state === 'waiting') waitingCount = row.count;
                                                    if (row.state === 'called') servingCount = row.count;
                                                });
                                            }
                                            
                                            // Broadcast no-show event with camelCase fields
                                            const io = req.app.get('io');
                                            if (io) {
                                                broadcastTicketCompleted(io, {
                                                    id: ticketId,
                                                    ticketNumber: ticket.ticket_number,
                                                    serviceId: ticket.service_id,
                                                    serviceName: ticket.service_name,
                                                    state: 'no_show',
                                                    counterId: counterId,
                                                    agentId: agentId,
                                                    completedAt: now
                                                }, {
                                                    serviceId: ticket.service_id,
                                                    waiting: waitingCount
                                                });
                                            }
                                            
                                            res.json({
                                                ticket: {
                                                    id: ticketId,
                                                    number: ticket.ticket_number,
                                                    state: 'no_show',
                                                    serviceId: ticket.service_id,
                                                    counterId,
                                                    agentId,
                                                    completedAt: now
                                                },
                                                queueUpdate: {
                                                    serviceId: ticket.service_id,
                                                    waiting: waitingCount,
                                                    serving: servingCount
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
});

router.post('/terminal/transfer', (req, res) => {
    const { ticketId, targetServiceId, counterId, agentId } = req.body;
    
    if (!ticketId || !targetServiceId || !counterId || !agentId) {
        return res.status(400).json({ error: 'ticketId, targetServiceId, counterId, and agentId are required' });
    }
    
    const db = getDb();
    
    db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        
        // Get current ticket details
        db.get(
            `SELECT t.*, s.name as service_name 
             FROM tickets t
             JOIN services s ON t.service_id = s.id
             WHERE t.id = ? AND t.state = 'called' AND t.counter_id = ? AND t.agent_id = ?`,
            [ticketId, counterId, agentId],
            (err, ticket) => {
                if (err) {
                    db.run('ROLLBACK');
                    return res.status(500).json({ error: 'Database error' });
                }
                
                if (!ticket) {
                    db.run('ROLLBACK');
                    return res.status(404).json({ error: 'Ticket not found or not in called state' });
                }
                
                // Verify target service exists
                db.get(
                    'SELECT * FROM services WHERE id = ? AND is_active = 1',
                    [targetServiceId],
                    (err, targetService) => {
                        if (err || !targetService) {
                            db.run('ROLLBACK');
                            return res.status(400).json({ error: 'Invalid target service' });
                        }
                        
                        const originalServiceId = ticket.service_id;
                        const now = new Date().toISOString();
                        
                        // Update ticket with new service and reset to waiting state
                        db.run(
                            `UPDATE tickets 
                             SET service_id = ?,
                                 state = 'waiting',
                                 counter_id = NULL,
                                 agent_id = NULL,
                                 transferred_at = ?,
                                 original_service_id = COALESCE(original_service_id, ?)
                             WHERE id = ?`,
                            [targetServiceId, now, originalServiceId, ticketId],
                            (err) => {
                                if (err) {
                                    db.run('ROLLBACK');
                                    return res.status(500).json({ error: 'Failed to transfer ticket' });
                                }
                                
                                // Update counter state
                                db.run(
                                    `UPDATE counters 
                                     SET current_ticket_id = NULL,
                                         state = 'available'
                                     WHERE id = ?`,
                                    [counterId],
                                    (err) => {
                                        if (err) {
                                            db.run('ROLLBACK');
                                            return res.status(500).json({ error: 'Failed to update counter' });
                                        }
                                        
                                        // Log the event
                                        logEvent(
                                            EventTypes.TICKET_TRANSFERRED,
                                            'ticket',
                                            ticketId,
                                            {
                                                ticketNumber: ticket.ticket_number,
                                                fromServiceId: originalServiceId,
                                                toServiceId: targetServiceId,
                                                counterId,
                                                agentId
                                            },
                                            agentId,
                                            counterId
                                        ).catch(err => console.error('Event logging failed:', err));
                                        
                                        db.run('COMMIT', (err) => {
                                            if (err) {
                                                return res.status(500).json({ error: 'Failed to commit transaction' });
                                            }
                                            
                                            // Get queue counts for both services
                                            db.all(
                                                `SELECT service_id, state, COUNT(*) as count 
                                                 FROM tickets 
                                                 WHERE service_id IN (?, ?) AND state = 'waiting'
                                                 GROUP BY service_id, state`,
                                                [originalServiceId, targetServiceId],
                                                (err, counts) => {
                                                    let fromWaiting = 0;
                                                    let toWaiting = 0;
                                                    
                                                    if (counts && !err) {
                                                        counts.forEach(row => {
                                                            if (row.service_id === originalServiceId) {
                                                                fromWaiting = row.count;
                                                            } else if (row.service_id === targetServiceId) {
                                                                toWaiting = row.count;
                                                            }
                                                        });
                                                    }
                                                    
                                                    // Broadcast transfer event
                                                    const io = req.app.get('io');
                                                    if (io) {
                                                        broadcastQueueUpdated(io, {
                                                            serviceId: originalServiceId,
                                                            waiting: fromWaiting
                                                        });
                                                        broadcastQueueUpdated(io, {
                                                            serviceId: targetServiceId,
                                                            waiting: toWaiting
                                                        });
                                                    }
                                                    
                                                    res.json({
                                                        ticket: {
                                                            id: ticketId,
                                                            number: ticket.ticket_number,
                                                            state: 'waiting',
                                            serviceId: targetServiceId,
                                            originalServiceId: originalServiceId,
                                            transferredAt: now,
                                            counterId: null,
                                            agentId: null
                                        },
                                        queueUpdate: {
                                            fromService: {
                                                serviceId: originalServiceId,
                                                waiting: fromWaiting
                                            },
                                            toService: {
                                                serviceId: targetServiceId,
                                                waiting: toWaiting
                                            }
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
            }
        );
    });
});

// ===== MONITOR ENDPOINTS =====

// GET /api/monitor/counters - Get all counters with current tickets
router.get('/monitor/counters', (req, res) => {
    const db = getDb();
    
    db.all(
        `SELECT 
            c.*,
            t.id as ticket_id,
            t.ticket_number,
            t.service_id,
            s.name as service_name,
            s.prefix as service_prefix
        FROM counters c
        LEFT JOIN tickets t ON c.current_ticket_id = t.id AND t.state = 'called'
        LEFT JOIN services s ON t.service_id = s.id
        WHERE c.is_active = 1
        ORDER BY c.number`,
        (err, counters) => {
            if (err) {
                console.error('Error fetching counters:', err);
                return res.status(500).json({ 
                    success: false, 
                    error: 'Failed to fetch counters' 
                });
            }
            
            const formattedCounters = counters.map(counter => ({
                id: counter.id,
                name: counter.name,
                number: counter.number,
                location: counter.location,
                state: counter.state || 'offline',
                current_ticket: counter.ticket_id ? {
                    id: counter.ticket_id,
                    ticket_number: counter.ticket_number,
                    service_id: counter.service_id,
                    service_name: counter.service_name,
                    service_prefix: counter.service_prefix
                } : null,
                current_agent_id: counter.current_agent_id
            }));
            
            res.json({
                success: true,
                data: formattedCounters
            });
        }
    );
});

// GET /api/monitor/now-serving - Get currently serving tickets
router.get('/monitor/now-serving', (req, res) => {
    const db = getDb();
    
    db.all(
        `SELECT 
            t.id,
            t.ticket_number,
            t.service_id,
            t.customer_name,
            t.called_at,
            c.id as counter_id,
            c.number as counter_number,
            c.name as counter_name,
            c.location as counter_location,
            s.name as service_name,
            s.prefix as service_prefix,
            a.id as agent_id,
            a.name as agent_name
        FROM tickets t
        JOIN counters c ON t.counter_id = c.id
        JOIN services s ON t.service_id = s.id
        LEFT JOIN agents a ON t.agent_id = a.id
        WHERE t.state = 'called'
        ORDER BY t.called_at DESC`,
        (err, serving) => {
            if (err) {
                console.error('Error fetching now serving:', err);
                return res.status(500).json({ 
                    success: false, 
                    error: 'Failed to fetch now serving' 
                });
            }
            
            const formattedServing = serving.map(ticket => ({
                ticket: {
                    id: ticket.id,
                    number: ticket.ticket_number,
                    service_id: ticket.service_id,
                    service_name: ticket.service_name,
                    customer_name: ticket.customer_name,
                    called_at: ticket.called_at
                },
                counter: {
                    id: ticket.counter_id,
                    number: ticket.counter_number,
                    name: ticket.counter_name,
                    location: ticket.counter_location
                },
                agent: {
                    id: ticket.agent_id,
                    name: ticket.agent_name || 'Agent'
                }
            }));
            
            res.json({ 
                success: true, 
                data: formattedServing 
            });
        }
    );
});

// GET /api/monitor/queue/:serviceId - Get queue overview for a specific service
router.get('/monitor/queue/:serviceId', (req, res) => {
    const serviceId = parseInt(req.params.serviceId);
    const db = getDb();
    
    if (isNaN(serviceId)) {
        return res.status(400).json({ 
            success: false, 
            error: 'Invalid service ID' 
        });
    }
    
    // Get service details first
    db.get(
        'SELECT * FROM services WHERE id = ? AND is_active = 1',
        [serviceId],
        (err, service) => {
            if (err) {
                return res.status(500).json({ 
                    success: false, 
                    error: 'Database error' 
                });
            }
            
            if (!service) {
                return res.status(404).json({ 
                    success: false, 
                    error: 'Service not found' 
                });
            }
            
            // Get queue statistics and next tickets
            db.all(
                `SELECT 
                    ticket_number,
                    state,
                    priority,
                    created_at,
                    customer_name
                FROM tickets 
                WHERE service_id = ? AND state = 'waiting'
                ORDER BY priority DESC, created_at ASC
                LIMIT 10`,
                [serviceId],
                (err, nextTickets) => {
                    if (err) {
                        return res.status(500).json({ 
                            success: false, 
                            error: 'Failed to fetch queue' 
                        });
                    }
                    
                    // Get counts
                    db.all(
                        `SELECT state, COUNT(*) as count 
                         FROM tickets 
                         WHERE service_id = ? AND state IN ('waiting', 'called')
                         GROUP BY state`,
                        [serviceId],
                        (err, counts) => {
                            let waitingCount = 0;
                            let servingCount = 0;
                            
                            if (counts && !err) {
                                counts.forEach(row => {
                                    if (row.state === 'waiting') waitingCount = row.count;
                                    if (row.state === 'called') servingCount = row.count;
                                });
                            }
                            
                            res.json({
                                success: true,
                                data: {
                                    service: {
                                        id: service.id,
                                        name: service.name,
                                        prefix: service.prefix
                                    },
                                    stats: {
                                        waiting: waitingCount,
                                        serving: servingCount
                                    },
                                    next_tickets: nextTickets.map(t => t.ticket_number)
                                }
                            });
                        }
                    );
                }
            );
        }
    );
});

// ===== ADMIN ENDPOINTS =====

// GET /api/admin/settings - Get all settings
router.get('/admin/settings', (req, res) => {
  const { category } = req.query; // Optional category filter
  const db = getDb();
  
  let sql = 'SELECT * FROM settings';
  const params = [];
  
  if (category) {
    sql += ' WHERE category = ?';
    params.push(category);
  }
  
  sql += ' ORDER BY category, key';
  
  db.all(sql, params, (err, settings) => {
    if (err) {
      console.error('Settings fetch error:', err);
      return res.status(500).json({ error: 'Failed to fetch settings' });
    }
    
    res.json({ settings });
  });
});

// PUT /api/admin/settings - Update settings
router.put('/admin/settings', (req, res) => {
  const { updates } = req.body; // Array of {key, value} objects
  const db = getDb();
  
  if (!updates || !Array.isArray(updates)) {
    return res.status(400).json({ error: 'Updates array required' });
  }
  
  // Start transaction
  db.run('BEGIN TRANSACTION', (err) => {
    if (err) {
      return res.status(500).json({ error: 'Transaction failed' });
    }
    
    let completedUpdates = 0;
    let hasError = false;
    
    if (updates.length === 0) {
      db.run('COMMIT', (commitErr) => {
        if (commitErr) {
          return res.status(500).json({ error: 'Failed to commit updates' });
        }
        res.json({ message: 'No settings to update', count: 0 });
      });
      return;
    }
    
    updates.forEach((update, index) => {
      if (hasError) return;
      
      const { key, value } = update;
      if (!key || value === undefined) {
        hasError = true;
        db.run('ROLLBACK', () => {
          res.status(400).json({ error: 'Invalid update format' });
        });
        return;
      }
      
      const sql = 'UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?';
      db.run(sql, [value, key], function(updateErr) {
        if (updateErr || this.changes === 0) {
          hasError = true;
          db.run('ROLLBACK', () => {
            res.status(400).json({ error: `Failed to update setting: ${key}` });
          });
          return;
        }
        
        completedUpdates++;
        
        // If all updates complete, commit
        if (completedUpdates === updates.length) {
          db.run('COMMIT', (commitErr) => {
            if (commitErr) {
              return res.status(500).json({ error: 'Failed to commit updates' });
            }
            res.json({ message: 'Settings updated successfully', count: updates.length });
          });
        }
      });
    });
  });
});

module.exports = router;