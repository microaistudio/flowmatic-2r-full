const express = require('express');
const router = express.Router();
const { getDb } = require('../database/connection');
const { logEvent, EventTypes } = require('../database/events');
const { broadcastTicketCalled, broadcastTicketCompleted, broadcastQueueUpdated } = require('../realtime/eventBroadcaster');

router.post('/call-next', (req, res) => {
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

router.post('/complete', (req, res) => {
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

router.get('/queue/:serviceId', (req, res) => {
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

router.get('/session', (req, res) => {
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

router.post('/login', (req, res) => {
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

router.post('/logout', (req, res) => {
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

router.post('/recall', (req, res) => {
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

router.post('/no-show', (req, res) => {
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

router.post('/transfer', (req, res) => {
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
                    console.error('Error finding ticket:', err);
                    db.run('ROLLBACK');
                    return res.status(500).json({ error: 'Database error', details: err.message });
                }
                
                if (!ticket) {
                    db.run('ROLLBACK');
                    return res.status(404).json({ error: 'Ticket not found or not in called state' });
                }
                
                // Verify target service exists and is different from current
                db.get(
                    'SELECT * FROM services WHERE id = ? AND is_active = 1',
                    [targetServiceId],
                    (err, targetService) => {
                        if (err) {
                            console.error('Error finding target service:', err);
                            db.run('ROLLBACK');
                            return res.status(500).json({ error: 'Database error', details: err.message });
                        }
                        
                        if (!targetService) {
                            db.run('ROLLBACK');
                            return res.status(400).json({ error: 'Invalid target service' });
                        }
                        
                        if (targetService.id === ticket.service_id) {
                            db.run('ROLLBACK');
                            return res.status(400).json({ error: 'Cannot transfer to the same service' });
                        }
                        
                        const originalServiceId = ticket.service_id;
                        const now = new Date().toISOString();
                        
                        // Generate new ticket number with target service prefix
                        db.get(
                            `SELECT MAX(CAST(SUBSTR(ticket_number, LENGTH(prefix) + 1) AS INTEGER)) as max_num 
                             FROM tickets t
                             JOIN services s ON t.service_id = s.id 
                             WHERE t.service_id = ? 
                             AND DATE(t.created_at) = DATE('now')`,
                            [targetServiceId],
                            (err, result) => {
                                if (err) {
                                    console.error('Error calculating next number:', err);
                                    db.run('ROLLBACK');
                                    return res.status(500).json({ error: 'Failed to calculate ticket number' });
                                }
                                
                                const nextNumber = (result && result.max_num) ? result.max_num + 1 : 1;
                                const newTicketNumber = `${targetService.prefix}${nextNumber.toString().padStart(3, '0')}`;
                                
                                // Update ticket with new service, ticket number, and reset to waiting state
                                db.run(
                                    `UPDATE tickets 
                                     SET service_id = ?,
                                         ticket_number = ?,
                                         state = 'waiting',
                                         counter_id = NULL,
                                         agent_id = NULL,
                                         transferred_at = ?,
                                         original_service_id = COALESCE(original_service_id, ?)
                                     WHERE id = ?`,
                                    [targetServiceId, newTicketNumber, now, originalServiceId, ticketId],
                                    (err) => {
                                        if (err) {
                                            console.error('Error updating ticket:', err);
                                            db.run('ROLLBACK');
                                            return res.status(500).json({ error: 'Failed to transfer ticket', details: err.message });
                                        }
                                        
                                        // Update counter state to available
                                        db.run(
                                            `UPDATE counters 
                                             SET current_ticket_id = NULL,
                                                 state = 'available'
                                             WHERE id = ?`,
                                            [counterId],
                                            (err) => {
                                                if (err) {
                                                    console.error('Error updating counter:', err);
                                                    db.run('ROLLBACK');
                                                    return res.status(500).json({ error: 'Failed to update counter', details: err.message });
                                                }
                                                
                                                // Log the event
                                                logEvent(
                                                    EventTypes.TICKET_TRANSFERRED,
                                                    'ticket',
                                                    ticketId,
                                                    {
                                                        ticketNumber: ticket.ticket_number,
                                                        newTicketNumber: newTicketNumber,
                                                        fromServiceId: originalServiceId,
                                                        toServiceId: targetServiceId,
                                                        targetServiceName: targetService.name,
                                                        counterId,
                                                        agentId
                                                    },
                                                    agentId,
                                                    counterId
                                                ).catch(err => console.error('Event logging failed:', err));
                                                
                                                db.run('COMMIT', (err) => {
                                                    if (err) {
                                                        console.error('Transaction commit failed:', err);
                                                        return res.status(500).json({ error: 'Failed to commit transaction', details: err.message });
                                                    }
                                                    
                                                    // Get updated queue counts for both services
                                                    db.all(
                                                        `SELECT service_id, state, COUNT(*) as count 
                                                         FROM tickets 
                                                         WHERE service_id IN (?, ?) AND state IN ('waiting', 'called')
                                                         GROUP BY service_id, state`,
                                                        [originalServiceId, targetServiceId],
                                                        (err, counts) => {
                                                            let fromWaiting = 0, fromServing = 0;
                                                            let toWaiting = 0, toServing = 0;
                                                            
                                                            if (counts && !err) {
                                                                counts.forEach(row => {
                                                                    if (row.service_id === originalServiceId) {
                                                                        if (row.state === 'waiting') fromWaiting = row.count;
                                                                        if (row.state === 'called') fromServing = row.count;
                                                                    } else if (row.service_id === targetServiceId) {
                                                                        if (row.state === 'waiting') toWaiting = row.count;
                                                                        if (row.state === 'called') toServing = row.count;
                                                                    }
                                                                });
                                                            }
                                                            
                                                            // Broadcast transfer events
                                                            const io = req.app.get('io');
                                                            if (io) {
                                                                // Broadcast ticket transferred event
                                                                io.emit('ticket-transferred', {
                                                                    ticket: {
                                                                        id: ticketId,
                                                                        oldNumber: ticket.ticket_number,
                                                                        newNumber: newTicketNumber,
                                                                        fromServiceId: originalServiceId,
                                                                        toServiceId: targetServiceId,
                                                                        toServiceName: targetService.name,
                                                                        state: 'waiting',
                                                                        transferredAt: now
                                                                    }
                                                                });
                                                                
                                                                // Broadcast queue updates for both services
                                                                broadcastQueueUpdated(io, {
                                                                    serviceId: originalServiceId,
                                                                    waiting: fromWaiting,
                                                                    serving: fromServing
                                                                });
                                                                
                                                                broadcastQueueUpdated(io, {
                                                                    serviceId: targetServiceId,
                                                                    waiting: toWaiting,
                                                                    serving: toServing
                                                                });
                                                            }
                                                            
                                                            res.json({
                                                                success: true,
                                                                ticket: {
                                                                    id: ticketId,
                                                                    oldNumber: ticket.ticket_number,
                                                                    newNumber: newTicketNumber,
                                                                    state: 'waiting',
                                                                    serviceId: targetServiceId,
                                                                    serviceName: targetService.name,
                                                                    originalServiceId: originalServiceId,
                                                                    transferredAt: now,
                                                                    counterId: null,
                                                                    agentId: null
                                                                },
                                                                queueUpdate: {
                                                                    fromService: {
                                                                        serviceId: originalServiceId,
                                                                        waiting: fromWaiting,
                                                                        serving: fromServing
                                                                    },
                                                                    toService: {
                                                                        serviceId: targetServiceId,
                                                                        waiting: toWaiting,
                                                                        serving: toServing
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
            }
        );
    });
});

module.exports = router;