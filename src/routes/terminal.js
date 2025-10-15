const express = require('express');
const router = express.Router();
const { getDb } = require('../database/connection');
const { withTransaction } = require('../database/dbClient');
const { logEvent, EventTypes } = require('../database/events');
const {
    broadcastTicketCalled,
    broadcastTicketCompleted,
    broadcastQueueUpdated,
    broadcastTicketRecycled
} = require('../realtime/eventBroadcaster');
const logger = require('../utils/logger');

function parsePositiveInt(value, field) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        const error = new Error(`${field} must be a positive integer`);
        error.status = 400;
        throw error;
    }
    return parsed;
}

function httpError(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
}

async function getQueueSnapshot(tx, serviceId) {
    const [counts, waitingTickets] = await Promise.all([
        tx.all(
            `SELECT state, COUNT(*) as count
             FROM tickets
             WHERE service_id = ?
               AND state IN ('waiting', 'recycled', 'called')
             GROUP BY state`,
            [serviceId]
        ),
        tx.all(
            `SELECT id,
                    ticket_number,
                    service_id,
                    priority,
                    created_at,
                    estimated_wait,
                    customer_name,
                    customer_phone,
                    state
             FROM tickets
             WHERE service_id = ?
               AND state IN ('waiting', 'recycled')
             ORDER BY priority DESC, created_at ASC`,
            [serviceId]
        )
    ]);

    const snapshot = { serviceId, waiting: 0, serving: 0, tickets: [] };

    if (counts) {
        counts.forEach((row) => {
            if (row.state === 'called') {
                snapshot.serving = row.count;
                return;
            }

            if (row.state === 'waiting' || row.state === 'recycled') {
                snapshot.waiting += row.count;
            }
        });
    }

    if (waitingTickets?.length) {
        snapshot.tickets = waitingTickets.map((row) => {
            const state = row.state || 'waiting';
            const isRecycled = state === 'recycled';

            return {
                id: row.id,
                ticket_number: row.ticket_number,
                ticketNumber: row.ticket_number,
                number: row.ticket_number,
                service_id: row.service_id,
                serviceId: row.service_id,
                priority: row.priority,
                created_at: row.created_at,
                createdAt: row.created_at,
                estimated_wait: row.estimated_wait,
                estimatedWait: row.estimated_wait,
                customer_name: row.customer_name,
                customerName: row.customer_name,
                customer_phone: row.customer_phone,
                customerPhone: row.customer_phone,
                state,
                ticketState: state,
                isRecycled,
                is_recycled: isRecycled,
                recycled: isRecycled
            };
        });
    }

    return snapshot;
}

router.get('/agent/:agentId/services', (req, res) => {
    try {
        const agentId = parsePositiveInt(req.params.agentId, 'agentId');
        const db = getDb();

        db.all(
            `SELECT s.id,
                    s.name,
                    s.prefix,
                    s.description,
                    a.priority
             FROM agent_services a
             JOIN services s ON s.id = a.service_id
             WHERE a.agent_id = ?
             ORDER BY a.priority, s.name`,
            [agentId],
            (err, rows) => {
                if (err) {
                    logger.error({ err }, 'Failed to load agent services');
                    res.status(500).json({ error: 'Failed to fetch agent services' });
                    return;
                }

                res.json({
                    services: rows?.map((row) => ({
                        id: row.id,
                        service_id: row.id,
                        name: row.name,
                        prefix: row.prefix,
                        description: row.description,
                        priority: row.priority
                    })) || []
                });
            }
        );
    } catch (error) {
        const status = error.status || 500;
        res.status(status).json({
            error: error.message || 'Failed to fetch agent services'
        });
    }
});

router.post('/call-next', async (req, res) => {
    try {
        const counterId = parsePositiveInt(req.body?.counterId, 'counterId');
        const agentId = parsePositiveInt(req.body?.agentId, 'agentId');
        const requestedServiceId = req.body?.serviceId
            ? parsePositiveInt(req.body.serviceId, 'serviceId')
            : null;
        const requestedTicketId = req.body?.ticketId
            ? parsePositiveInt(req.body.ticketId, 'ticketId')
            : null;

        const payloadLength = JSON.stringify(req.body || {}).length;
        logger.info({ body: req.body, payloadLength }, 'call-next payload');

        const result = await withTransaction(async (tx) => {
            let ticket;
            let serviceContext = null;

            if (requestedTicketId) {
                ticket = await tx.get(
                    `SELECT t.*, s.name as service_name, s.prefix
                     FROM tickets t
                     JOIN services s ON t.service_id = s.id
                     WHERE t.id = ? AND t.state = 'waiting'`,
                    [requestedTicketId]
                );

                if (!ticket) {
                    throw httpError(404, 'Requested ticket is not available for calling');
                }

                const authorized = await tx.get(
                    `SELECT 1 FROM agent_services WHERE agent_id = ? AND service_id = ?`,
                    [agentId, ticket.service_id]
                );

                if (!authorized) {
                    throw httpError(403, 'Agent is not authorized for this service');
                }
            } else {
                const agentServices = await tx.all(
                    `SELECT service_id
                     FROM agent_services
                     WHERE agent_id = ?
                     ORDER BY priority`,
                    [agentId]
                );

                const hasAssignments = Array.isArray(agentServices) && agentServices.length > 0;

                if (requestedServiceId) {
                    serviceContext = await tx.get(
                        `SELECT s.id, s.name, s.prefix
                         FROM services s
                         WHERE s.id = ? AND s.is_active = 1`,
                        [requestedServiceId]
                    );

                    if (!serviceContext) {
                        throw httpError(404, 'Requested service not found');
                    }

                    if (
                        hasAssignments &&
                        !agentServices.some((row) => row.service_id === requestedServiceId)
                    ) {
                        throw httpError(403, 'Agent is not assigned to this service');
                    }
                } else if (hasAssignments) {
                    serviceContext = await tx.get(
                        `SELECT s.id, s.name, s.prefix
                         FROM services s
                         WHERE s.id = ? AND s.is_active = 1`,
                        [agentServices[0].service_id]
                    );
                } else {
                    // No explicit assignment; fall back to the agent's counter default service if available
                    serviceContext = await tx.get(
                        `SELECT s.id, s.name, s.prefix
                         FROM counters c
                         JOIN services s ON s.id = c.default_service_id
                         WHERE c.id = ? AND s.is_active = 1`,
                        [counterId]
                    );

                    if (!serviceContext) {
                        // Final fallback: select the first active service
                        serviceContext = await tx.get(
                            `SELECT id, name, prefix
                             FROM services
                             WHERE is_active = 1
                             ORDER BY priority, id
                             LIMIT 1`
                        );
                    }
                }

                if (!serviceContext) {
                    throw httpError(400, 'Unable to determine service for agent');
                }

                ticket = await tx.get(
                    `SELECT t.*, s.name as service_name, s.prefix
                     FROM tickets t
                     JOIN services s ON t.service_id = s.id
                     WHERE t.service_id = ? AND t.state = 'waiting'
                     ORDER BY t.created_at
                     LIMIT 1`,
                    [serviceContext.id]
                );

                if (!ticket) {
                    throw httpError(404, 'No tickets waiting in queue');
                }
            }

            const now = new Date().toISOString();

            await tx.run(
                `UPDATE tickets
                 SET state = 'called',
                     called_at = ?,
                     served_at = ?,
                     counter_id = ?,
                     agent_id = ?,
                     recall_count = recall_count + 1
                 WHERE id = ?`,
                [now, now, counterId, agentId, ticket.id]
            );

            await tx.run(
                `UPDATE counters
                 SET current_ticket_id = ?,
                     current_agent_id = ?,
                    state = 'serving'
                 WHERE id = ?`,
                [ticket.id, agentId, counterId]
            );

            if (!serviceContext) {
                serviceContext = {
                    id: ticket.service_id,
                    name: ticket.service_name,
                    prefix: ticket.prefix
                };
            }

            const queueSnapshot = await getQueueSnapshot(tx, ticket.service_id);

            return {
                audit: {
                    ticketNumber: ticket.ticket_number,
                    serviceId: ticket.service_id,
                    counterId,
                    agentId
                },
                ticket: {
                    id: ticket.id,
                    number: ticket.ticket_number,
                    serviceId: ticket.service_id,
                    serviceName: ticket.service_name,
                    customerName: ticket.customer_name || 'Customer',
                    state: 'called',
                    counterId,
                    agentId,
                    calledAt: now
                },
                queue: queueSnapshot
            };
        });

        await logEvent(
            EventTypes.TICKET_CALLED,
            'ticket',
            result.ticket.id,
            {
                ticketNumber: result.audit.ticketNumber,
                serviceId: result.audit.serviceId,
                counterId: result.audit.counterId,
                agentId: result.audit.agentId,
                previousState: 'waiting'
            },
            result.audit.agentId,
            result.audit.counterId
        ).catch((err) => logger.error({ err }, 'Event logging failed for call-next'));

        const io = req.app.get('io');
        if (io) {
            const counterData = { id: result.ticket.counterId, name: `Counter ${result.ticket.counterId}`, number: result.ticket.counterId };
            const agentData = { id: result.ticket.agentId, name: 'Agent' };

            broadcastTicketCalled(
                io,
                {
                    id: result.ticket.id,
                    ticketNumber: result.ticket.number,
                    serviceId: result.ticket.serviceId,
                    serviceName: result.ticket.serviceName,
                    state: 'called',
                    counterId: result.ticket.counterId,
                    agentId: result.ticket.agentId,
                    customerName: result.ticket.customerName,
                    calledAt: result.ticket.calledAt
                },
                counterData,
                agentData
            );

            broadcastQueueUpdated(io, result.queue.serviceId, result.queue);
        }

        res.json({
            ticket: result.ticket,
            queueUpdate: result.queue
        });
    } catch (error) {
        const status = error.status || 500;
        if (!error.status) {
            logger.error({ err: error }, 'Error in POST /terminal/call-next');
        }
        res.status(status).json({
            error: error.message || 'Internal server error'
        });
    }
});

router.post('/complete', async (req, res) => {
    try {
        const ticketId = parsePositiveInt(req.body?.ticketId, 'ticketId');
        const counterId = parsePositiveInt(req.body?.counterId, 'counterId');
        const agentId = parsePositiveInt(req.body?.agentId, 'agentId');
        const notes =
            typeof req.body?.notes === 'string' && req.body.notes.trim()
                ? req.body.notes.trim()
                : null;

        const result = await withTransaction(async (tx) => {
            const ticket = await tx.get(
                `SELECT t.*, s.name as service_name
                 FROM tickets t
                 JOIN services s ON t.service_id = s.id
                 WHERE t.id = ? AND t.counter_id = ? AND t.agent_id = ?`,
                [ticketId, counterId, agentId]
            );

            if (!ticket) {
                throw httpError(404, 'Ticket not found or not assigned to this counter/agent');
            }

            if (ticket.state === 'completed') {
                throw httpError(400, 'Ticket already completed');
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

            await tx.run(
                `UPDATE tickets
                 SET state = 'completed',
                     completed_at = ?,
                     actual_wait = ?,
                     service_duration = ?,
                     notes = ?
                 WHERE id = ?`,
                [completedAt, actualWait, serviceDuration, notes, ticketId]
            );

            await tx.run(
                `UPDATE counters
                 SET current_ticket_id = NULL,
                     state = 'available'
                 WHERE id = ?`,
                [counterId]
            );

            const queueSnapshot = await getQueueSnapshot(tx, ticket.service_id);

            return {
                audit: {
                    ticketNumber: ticket.ticket_number,
                    serviceId: ticket.service_id,
                    counterId,
                    agentId
                },
                ticket: {
                    id: ticketId,
                    number: ticket.ticket_number,
                    serviceId: ticket.service_id,
                    serviceName: ticket.service_name,
                    state: 'completed',
                    counterId,
                    agentId,
                    completedAt,
                    serviceDuration,
                    actualWait
                },
                queue: queueSnapshot
            };
        });

        await logEvent(
            EventTypes.TICKET_COMPLETED,
            'ticket',
            result.ticket.id,
            {
                ticketNumber: result.audit.ticketNumber,
                serviceId: result.audit.serviceId,
                serviceDurationSeconds: result.ticket.serviceDuration,
                actualWaitSeconds: result.ticket.actualWait
            },
            result.audit.agentId,
            result.audit.counterId
        ).catch((err) => logger.error({ err }, 'Event logging failed for complete'));

        const io = req.app.get('io');
        if (io) {
            broadcastTicketCompleted(
                io,
                {
                    id: result.ticket.id,
                    ticketNumber: result.ticket.number,
                    serviceId: result.ticket.serviceId,
                    state: 'completed',
                    counterId: result.ticket.counterId,
                    agentId: result.ticket.agentId,
                    completedAt: result.ticket.completedAt,
                    serviceDuration: result.ticket.serviceDuration,
                    actualWait: result.ticket.actualWait
                },
                result.queue
            );
        }

        res.json({
            ticket: {
                id: result.ticket.id,
                number: result.ticket.number,
                state: 'completed',
                completedAt: result.ticket.completedAt
            },
            queueUpdate: result.queue
        });
    } catch (error) {
        const status = error.status || 500;
        if (!error.status) {
            logger.error({ err: error }, 'Error in POST /terminal/complete');
        }
        res.status(status).json({
            error: error.message || 'Internal server error'
        });
    }
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

router.post('/recall', async (req, res) => {
    try {
        const ticketId = parsePositiveInt(req.body?.ticketId, 'ticketId');
        const counterId = parsePositiveInt(req.body?.counterId, 'counterId');
        const agentId = parsePositiveInt(req.body?.agentId, 'agentId');

        const result = await withTransaction(async (tx) => {
            const ticket = await tx.get(
                `SELECT t.*, s.name as service_name
                 FROM tickets t
                 JOIN services s ON t.service_id = s.id
                 WHERE t.id = ? AND t.state = 'called' AND t.counter_id = ? AND t.agent_id = ?`,
                [ticketId, counterId, agentId]
            );

            if (!ticket) {
                throw httpError(404, 'Ticket not found or not in called state');
            }

            const now = new Date().toISOString();

            await tx.run(
                `UPDATE tickets
                 SET recall_count = recall_count + 1,
                     called_at = ?
                 WHERE id = ?`,
                [now, ticketId]
            );

            const queueSnapshot = await getQueueSnapshot(tx, ticket.service_id);

            return {
                audit: {
                    ticketNumber: ticket.ticket_number,
                    serviceId: ticket.service_id,
                    counterId,
                    agentId,
                    recallCount: (ticket.recall_count || 0) + 1
                },
                ticket: {
                    id: ticketId,
                    number: ticket.ticket_number,
                    serviceId: ticket.service_id,
                    serviceName: ticket.service_name,
                    state: 'called',
                    counterId,
                    agentId,
                    recallCount: (ticket.recall_count || 0) + 1,
                    calledAt: now,
                    customerName: ticket.customer_name || 'Customer'
                },
                queue: queueSnapshot
            };
        });

        await logEvent(
            EventTypes.TICKET_RECALLED,
            'ticket',
            ticketId,
            {
                ticketNumber: result.audit.ticketNumber,
                serviceId: result.audit.serviceId,
                counterId: result.audit.counterId,
                agentId: result.audit.agentId,
                recallCount: result.audit.recallCount
            },
            result.audit.agentId,
            result.audit.counterId
        ).catch((err) => logger.error({ err }, 'Event logging failed for recall'));

        const io = req.app.get('io');
        if (io) {
            broadcastTicketCalled(
                io,
                {
                    id: result.ticket.id,
                    ticketNumber: result.ticket.number,
                    serviceId: result.ticket.serviceId,
                    serviceName: result.ticket.serviceName,
                    state: 'called',
                    counterId: result.ticket.counterId,
                    agentId: result.ticket.agentId,
                    customerName: result.ticket.customerName,
                    calledAt: result.ticket.calledAt,
                    recallCount: result.ticket.recallCount
                },
                { id: result.ticket.counterId, name: `Counter ${result.ticket.counterId}`, number: result.ticket.counterId },
                { id: result.ticket.agentId, name: 'Agent' }
            );

            broadcastQueueUpdated(io, result.queue.serviceId, result.queue);
        }

        res.json({
            ticket: result.ticket,
            queueUpdate: result.queue
        });
    } catch (error) {
        const status = error.status || 500;
        if (!error.status) {
            logger.error({ err: error }, 'Error in POST /terminal/recall');
        }
        res.status(status).json({
            error: error.message || 'Internal server error'
        });
    }
});

router.post('/no-show', async (req, res) => {
    try {
        const ticketId = parsePositiveInt(req.body?.ticketId, 'ticketId');
        const counterId = parsePositiveInt(req.body?.counterId, 'counterId');
        const agentId = parsePositiveInt(req.body?.agentId, 'agentId');

        const result = await withTransaction(async (tx) => {
            const ticket = await tx.get(
                `SELECT t.*, s.name as service_name
                 FROM tickets t
                 JOIN services s ON t.service_id = s.id
                 WHERE t.id = ? AND t.state = 'called' AND t.counter_id = ? AND t.agent_id = ?`,
                [ticketId, counterId, agentId]
            );

            if (!ticket) {
                throw httpError(404, 'Ticket not found or not in called state');
            }

            const now = new Date().toISOString();

            await tx.run(
                `UPDATE tickets
                 SET state = 'no_show',
                     completed_at = ?
                 WHERE id = ?`,
                [now, ticketId]
            );

            await tx.run(
                `UPDATE counters
                 SET current_ticket_id = NULL,
                     state = 'available'
                 WHERE id = ?`,
                [counterId]
            );

            const queueSnapshot = await getQueueSnapshot(tx, ticket.service_id);

            return {
                audit: {
                    ticketNumber: ticket.ticket_number,
                    serviceId: ticket.service_id,
                    counterId,
                    agentId
                },
                ticket: {
                    id: ticketId,
                    number: ticket.ticket_number,
                    serviceId: ticket.service_id,
                    serviceName: ticket.service_name,
                    state: 'no_show',
                    counterId,
                    agentId,
                    completedAt: now
                },
                queue: queueSnapshot
            };
        });

        await logEvent(
            EventTypes.TICKET_NO_SHOW,
            'ticket',
            ticketId,
            {
                ticketNumber: result.audit.ticketNumber,
                serviceId: result.audit.serviceId,
                counterId: result.audit.counterId,
                agentId: result.audit.agentId
            },
            result.audit.agentId,
            result.audit.counterId
        ).catch((err) => logger.error({ err }, 'Event logging failed for no-show'));

        const io = req.app.get('io');
        if (io) {
            broadcastTicketCompleted(
                io,
                {
                    id: result.ticket.id,
                    ticketNumber: result.ticket.number,
                    serviceId: result.ticket.serviceId,
                    serviceName: result.ticket.serviceName,
                    state: 'no_show',
                    counterId: result.ticket.counterId,
                    agentId: result.ticket.agentId,
                    completedAt: result.ticket.completedAt
                },
                result.queue
            );

            broadcastQueueUpdated(io, result.queue.serviceId, result.queue);
        }

        res.json({
            ticket: result.ticket,
            queueUpdate: result.queue
        });
    } catch (error) {
        const status = error.status || 500;
        if (!error.status) {
            logger.error({ err: error }, 'Error in POST /terminal/no-show');
        }
        res.status(status).json({
            error: error.message || 'Internal server error'
        });
    }
});

router.post('/recycle', async (req, res) => {
    try {
        const ticketId = parsePositiveInt(req.body?.ticketId, 'ticketId');
        const counterId = parsePositiveInt(req.body?.counterId, 'counterId');
        const agentId = parsePositiveInt(req.body?.agentId, 'agentId');
        const requestedPosition = req.body?.position
            ? parsePositiveInt(req.body.position, 'position')
            : 3;

        const result = await withTransaction(async (tx) => {
            const ticket = await tx.get(
                `SELECT t.*, s.name as service_name
                 FROM tickets t
                 JOIN services s ON t.service_id = s.id
                 WHERE t.id = ?
                   AND t.counter_id = ?
                   AND t.agent_id = ?`,
                [ticketId, counterId, agentId]
            );

            if (!ticket) {
                throw httpError(404, 'Ticket not found or not assigned to this counter/agent');
            }

            if (ticket.state !== 'called') {
                throw httpError(400, 'Ticket is not currently being served');
            }

            const now = new Date().toISOString();

            await tx.run(
                `UPDATE tickets
                 SET state = 'waiting',
                     counter_id = NULL,
                     agent_id = NULL,
                     called_at = NULL,
                     served_at = NULL
                 WHERE id = ?`,
                [ticketId]
            );

            await tx.run(
                `UPDATE counters
                 SET current_ticket_id = NULL,
                     state = 'available'
                 WHERE id = ?`,
                [counterId]
            );

            const queueSnapshot = await getQueueSnapshot(tx, ticket.service_id);

            return {
                audit: {
                    ticketNumber: ticket.ticket_number,
                    serviceId: ticket.service_id,
                    counterId,
                    agentId,
                    position: requestedPosition
                },
                ticket: {
                    id: ticketId,
                    number: ticket.ticket_number,
                    serviceId: ticket.service_id,
                    serviceName: ticket.service_name,
                    state: 'waiting',
                    recycledAt: now,
                    requestedPosition
                },
                queue: queueSnapshot
            };
        });

        await logEvent(
            EventTypes.TICKET_RECYCLED,
            'ticket',
            result.ticket.id,
            {
                ticketNumber: result.audit.ticketNumber,
                serviceId: result.audit.serviceId,
                requestedPosition: result.audit.position
            },
            result.audit.agentId,
            result.audit.counterId
        ).catch((err) => logger.error({ err }, 'Event logging failed for recycle'));

        const io = req.app.get('io');
        if (io) {
            broadcastTicketRecycled(
                io,
                {
                    id: result.ticket.id,
                    ticketNumber: result.ticket.number,
                    serviceId: result.ticket.serviceId,
                    serviceName: result.ticket.serviceName,
                    state: 'waiting',
                    recycledAt: result.ticket.recycledAt
                },
                result.audit.position
            );

            broadcastQueueUpdated(io, result.queue.serviceId, result.queue);
        }

        res.json({
            ticket: {
                id: result.ticket.id,
                number: result.ticket.number,
                serviceId: result.ticket.serviceId,
                state: 'waiting',
                recycledAt: result.ticket.recycledAt,
                requestedPosition: result.ticket.requestedPosition
            },
            queueUpdate: result.queue
        });
    } catch (error) {
        const status = error.status || 500;
        if (!error.status) {
            logger.error({ err: error }, 'Error in POST /terminal/recycle');
        }
        res.status(status).json({
            error: error.message || 'Internal server error'
        });
    }
});

router.post('/transfer', async (req, res) => {
    try {
        const ticketId = parsePositiveInt(req.body?.ticketId, 'ticketId');
        const targetServiceId = parsePositiveInt(req.body?.targetServiceId, 'targetServiceId');
        const counterId = parsePositiveInt(req.body?.counterId, 'counterId');
        const agentId = parsePositiveInt(req.body?.agentId, 'agentId');

        const result = await withTransaction(async (tx) => {
            const ticket = await tx.get(
                `SELECT t.*, s.name as service_name
                 FROM tickets t
                 JOIN services s ON t.service_id = s.id
                 WHERE t.id = ? AND t.state = 'called' AND t.counter_id = ? AND t.agent_id = ?`,
                [ticketId, counterId, agentId]
            );

            if (!ticket) {
                throw httpError(404, 'Ticket not found or not in called state');
            }

            const targetService = await tx.get(
                'SELECT * FROM services WHERE id = ? AND is_active = 1',
                [targetServiceId]
            );

            if (!targetService) {
                throw httpError(400, 'Invalid target service');
            }

            if (targetService.id === ticket.service_id) {
                throw httpError(400, 'Cannot transfer to the same service');
            }

            const fromServiceId = ticket.service_id;
            const originalServiceId = ticket.original_service_id || ticket.service_id;
            const now = new Date().toISOString();
            const createdAt = ticket.created_at || now;

            const priority = Number.isInteger(ticket.priority) ? ticket.priority : 0;
            const estimatedWait = ticket.estimated_wait ?? null;
            const notes = ticket.notes ?? null;
            const recallCount = Number.isInteger(ticket.recall_count) ? ticket.recall_count : 0;
            const newTicketNumber = ticket.ticket_number;

            const inserted = await tx.run(
                `INSERT INTO tickets (
                    ticket_number,
                    service_id,
                    state,
                    priority,
                    customer_name,
                    customer_phone,
                    customer_email,
                    created_at,
                    called_at,
                    served_at,
                    completed_at,
                    estimated_wait,
                    actual_wait,
                    service_duration,
                    counter_id,
                    agent_id,
                    original_service_id,
                    transferred_at,
                    recall_count,
                    notes
                 )
                 VALUES (
                    ?, ?, 'waiting',
                    ?, ?, ?, ?,
                    ?, NULL, NULL, NULL,
                    ?, NULL, NULL,
                    NULL, NULL,
                    ?, ?, ?, ?
                 )`,
                [
                    newTicketNumber,
                    targetServiceId,
                    priority,
                    ticket.customer_name || null,
                    ticket.customer_phone || null,
                    ticket.customer_email || null,
                    createdAt,
                    estimatedWait,
                    originalServiceId,
                    now,
                    recallCount,
                    notes
                ]
            );

            const newTicketId = inserted.lastID;

            await tx.run(
                `UPDATE counters
                 SET current_ticket_id = NULL,
                     state = 'available'
                 WHERE id = ?`,
                [counterId]
            );

            await tx.run('DELETE FROM tickets WHERE id = ?', [ticketId]);

            const fromQueue = await getQueueSnapshot(tx, fromServiceId);
            const toQueue = await getQueueSnapshot(tx, targetServiceId);

            return {
                audit: {
                    ticketNumber: ticket.ticket_number,
                    newTicketNumber,
                    fromServiceId,
                    toServiceId: targetServiceId,
                    counterId,
                    agentId,
                    oldTicketId: ticketId,
                    newTicketId
                },
                ticket: {
                    id: newTicketId,
                    oldNumber: ticket.ticket_number,
                    newNumber: newTicketNumber,
                    state: 'waiting',
                    serviceId: targetServiceId,
                    serviceName: targetService.name,
                    originalServiceId,
                    transferredAt: now,
                    priority,
                    customerName: ticket.customer_name || null,
                    customerPhone: ticket.customer_phone || null,
                    customerEmail: ticket.customer_email || null,
                    createdAt
                },
                queues: {
                    from: fromQueue,
                    to: toQueue
                }
            };
        });

        await logEvent(
            EventTypes.TICKET_TRANSFERRED,
            'ticket',
            result.ticket.id,
            {
                ticketNumber: result.audit.ticketNumber,
                newTicketNumber: result.audit.newTicketNumber,
                fromServiceId: result.audit.fromServiceId,
                toServiceId: result.audit.toServiceId
            },
            result.audit.agentId,
            result.audit.counterId
        ).catch((err) => logger.error({ err }, 'Event logging failed for transfer'));

        const io = req.app.get('io');
        if (io) {
            io.emit('ticket-transferred', {
                ticket: {
                    id: result.ticket.id,
                    oldNumber: result.ticket.oldNumber,
                    newNumber: result.ticket.newNumber,
                    number: result.ticket.newNumber,
                    fromServiceId: result.ticket.originalServiceId,
                    toServiceId: result.ticket.serviceId,
                    toServiceName: result.ticket.serviceName,
                    state: 'waiting',
                    transferredAt: result.ticket.transferredAt
                }
            });

            broadcastQueueUpdated(io, result.queues.from.serviceId, result.queues.from);

            broadcastQueueUpdated(io, result.queues.to.serviceId, result.queues.to);
        }

        res.json({
            success: true,
            ticket: {
                id: result.ticket.id,
                oldNumber: result.ticket.oldNumber,
                newNumber: result.ticket.newNumber,
                state: 'waiting',
                serviceId: result.ticket.serviceId,
                serviceName: result.ticket.serviceName,
                originalServiceId: result.ticket.originalServiceId,
                transferredAt: result.ticket.transferredAt,
                priority: result.ticket.priority,
                createdAt: result.ticket.createdAt,
                customerName: result.ticket.customerName,
                customerPhone: result.ticket.customerPhone,
                customerEmail: result.ticket.customerEmail,
                counterId: null,
                agentId: null
            },
            queueUpdate: {
                fromService: result.queues.from,
                toService: result.queues.to
            }
        });
    } catch (error) {
        const status = error.status || 500;
        if (!error.status) {
            logger.error({ err: error }, 'Error transferring ticket');
        }
        res.status(status).json({
            error: error.message || 'Internal server error'
        });
    }
});

module.exports = router;
