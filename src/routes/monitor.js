const express = require('express');
const router = express.Router();
const { getDb } = require('../database/connection');

// ===== MONITOR ENDPOINTS =====

// GET /api/monitor/counters - Get all counters with current tickets
router.get('/counters', (req, res) => {
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
router.get('/now-serving', (req, res) => {
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
router.get('/queue/:serviceId', (req, res) => {
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

module.exports = router;