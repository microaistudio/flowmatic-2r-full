const express = require('express');
const router = express.Router();
const { getClient } = require('../database/dbClient');

router.get('/', async (_req, res) => {
    try {
        const db = getClient();
        const counters = await db.all(`
            SELECT c.id,
                   c.name,
                   c.number,
                   c.state,
                   c.current_agent_id,
                   c.current_ticket_id,
                   c.location,
                   a.name AS agent_name
            FROM counters c
            LEFT JOIN agents a ON a.id = c.current_agent_id
            ORDER BY c.number
        `);

        res.json({
            counters: counters.map((counter) => ({
                id: counter.id,
                name: counter.name || `Counter ${counter.number}`,
                number: counter.number,
                state: counter.state || 'offline',
                currentAgentId: counter.current_agent_id,
                currentAgentName: counter.agent_name || null,
                currentTicketId: counter.current_ticket_id,
                location: counter.location || null
            }))
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch counters' });
    }
});

module.exports = router;
