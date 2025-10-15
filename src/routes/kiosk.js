const express = require('express');
const router = express.Router();
const { all, get, withTransaction } = require('../database/dbClient');
const { logEvent, EventTypes } = require('../database/events');
const { broadcastTicketCreated } = require('../realtime/eventBroadcaster');
const logger = require('../utils/logger');

const MAX_NAME_LENGTH = 120;
const MAX_PHONE_LENGTH = 30;
const MAX_EMAIL_LENGTH = 180;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

function sanitizeString(value, maxLength) {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }
    return trimmed.slice(0, maxLength);
}

function httpError(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
}

function validateTicketPayload(body) {
    const errors = [];
    const serviceId = Number(body.serviceId);
    if (!Number.isInteger(serviceId) || serviceId <= 0) {
        errors.push('serviceId must be a positive integer');
    }

    const priorityRaw = body.priority ?? 0;
    const priority = Number(priorityRaw);
    if (!Number.isInteger(priority) || priority < 0 || priority > 2) {
        errors.push('priority must be an integer between 0 and 2');
    }

    const customerName = sanitizeString(body.customerName, MAX_NAME_LENGTH);
    const customerPhone = sanitizeString(body.customerPhone, MAX_PHONE_LENGTH);
    const customerEmail = sanitizeString(body.customerEmail, MAX_EMAIL_LENGTH);

    if (customerEmail && !EMAIL_REGEX.test(customerEmail)) {
        errors.push('customerEmail is invalid');
    }

    if (errors.length > 0) {
        return { errors };
    }

    return {
        serviceId,
        priority,
        customerName,
        customerPhone,
        customerEmail
    };
}

router.get('/services', async (req, res) => {
    try {
        const services = await all(
            'SELECT * FROM services WHERE is_active = 1 ORDER BY id'
        );

        if (!services || services.length === 0) {
            res.json({ services: [] });
            return;
        }

        const results = await Promise.all(
            services.map(async (service) => {
                const stats =
                    (await get(
                        `SELECT 
                            COUNT(CASE WHEN state = 'waiting' THEN 1 END) as waiting_count,
                            COUNT(CASE WHEN state = 'called' THEN 1 END) as serving_count,
                            MIN(CASE WHEN state = 'called' THEN ticket_number END) as current_serving
                         FROM tickets 
                         WHERE service_id = ? AND state IN ('waiting', 'called')`,
                        [service.id]
                    )) || {
                        waiting_count: 0,
                        serving_count: 0,
                        current_serving: null
                    };

                const avgRow =
                    (await get(
                        `SELECT AVG(actual_wait) as avg_wait 
                         FROM tickets 
                         WHERE service_id = ? 
                         AND state = 'completed' 
                         AND actual_wait IS NOT NULL
                         AND created_at > datetime('now', '-1 hour')`,
                        [service.id]
                    )) || {};

                const avgWaitSeconds = avgRow.avg_wait
                    ? Math.round(avgRow.avg_wait)
                    : 180;
                const avgWaitMinutes = Math.ceil(avgWaitSeconds / 60);

                const estimatedWaitMinutes =
                    stats.waiting_count > 0
                        ? Math.ceil((stats.waiting_count * avgWaitSeconds) / 60)
                        : 0;

                const realWaitTime =
                    estimatedWaitMinutes > 0
                        ? Math.max(
                              1,
                              estimatedWaitMinutes + Math.floor(Math.random() * 3) - 1
                          )
                        : 0;

                return {
                    id: service.id,
                    name: service.name,
                    description:
                        service.description ||
                        `${service.name} - Professional service`,
                    prefix: service.prefix,
                    queueCount: stats.waiting_count || 0,
                    nowServing: stats.current_serving || 'None',
                    realWaitTime,
                    estimatedWaitMinutes,
                    currentServing: stats.current_serving || null,
                    servingCount: stats.serving_count || 0,
                    serving: stats.serving_count || 0,
                    avgWaitTime: avgWaitMinutes
                };
            })
        );

        res.json({ services: results });
    } catch (error) {
        logger.error({ err: error }, 'Error fetching kiosk services');
        res.status(500).json({ error: 'Failed to fetch services' });
    }
});

router.post('/tickets', async (req, res) => {
    try {
        const payload = validateTicketPayload(req.body || {});
        if (payload.errors) {
            res.status(400).json({ error: payload.errors.join(', ') });
            return;
        }

        const nowIso = new Date().toISOString();
        const result = await withTransaction(async (tx) => {
            const service = await tx.get(
                'SELECT * FROM services WHERE id = ? AND is_active = 1',
                [payload.serviceId]
            );

            if (!service) {
                throw httpError(404, 'Service not found or inactive');
            }

            const baseNumber = Math.max(
                service.current_number ?? 0,
                (service.range_start ?? 1) - 1
            );
            const nextNumber = baseNumber + 1;

            if (service.range_end && nextNumber > service.range_end) {
                throw httpError(409, 'Service ticket range exhausted');
            }

            const ticketNumber = `${service.prefix}${String(nextNumber).padStart(3, '0')}`;

            await tx.run(
                'UPDATE services SET current_number = ? WHERE id = ?',
                [nextNumber, payload.serviceId]
            );

            const estimatedServiceTime = service.estimated_service_time || 300;
            const estimatedWait =
                Math.max(0, estimatedServiceTime * (nextNumber - 1));

            const insertResult = await tx.run(
                `INSERT INTO tickets (
                    ticket_number,
                    service_id,
                    state,
                    customer_name,
                    customer_phone,
                    customer_email,
                    estimated_wait,
                    priority
                ) VALUES (?, ?, 'waiting', ?, ?, ?, ?, ?)`,
                [
                    ticketNumber,
                    payload.serviceId,
                    payload.customerName,
                    payload.customerPhone,
                    payload.customerEmail,
                    estimatedWait,
                    payload.priority
                ]
            );

            const queueRow =
                (await tx.get(
                    'SELECT COUNT(*) as count FROM tickets WHERE service_id = ? AND state = ?',
                    [payload.serviceId, 'waiting']
                )) || {};

            const queueCount = queueRow.count || 0;

            return {
                service,
                ticket: {
                    id: insertResult.lastID,
                    ticketNumber,
                    serviceId: payload.serviceId,
                    serviceName: service.name,
                    state: 'waiting',
                    estimatedWait,
                    estimatedWaitMinutes: Math.ceil(estimatedWait / 60),
                    createdAt: nowIso,
                    queuePosition: queueCount,
                    customerName: payload.customerName || 'Anonymous'
                },
                queue: {
                    serviceId: payload.serviceId,
                    waiting: queueCount
                }
            };
        });

        await logEvent(
            EventTypes.TICKET_CREATED,
            'ticket',
            result.ticket.id,
            {
                ticketNumber: result.ticket.ticketNumber,
                serviceId: result.ticket.serviceId,
                serviceName: result.service.name,
                customerName: result.ticket.customerName
            }
        ).catch((err) => console.error('Event logging failed:', err));

        const io = req.app.get('io');
        if (io) {
            broadcastTicketCreated(
                io,
                {
                    id: result.ticket.id,
                    ticketNumber: result.ticket.ticketNumber,
                    serviceId: result.ticket.serviceId,
                    serviceName: result.service.name,
                    state: 'waiting',
                    customerName: result.ticket.customerName,
                    createdAt: result.ticket.createdAt
                },
                result.queue
            );
        }

        res.status(201).json({
            success: true,
            ticket: result.ticket
        });
    } catch (error) {
        const status = error.status || 500;
        if (!error.status) {
            logger.error({ err: error }, 'Error creating kiosk ticket');
        }
        res.status(status).json({ error: error.message || 'Internal server error' });
    }
});

router.post('/print-ticket', async (req, res) => {
    try {
        const { ticketData } = req.body || {};

        if (!ticketData || !ticketData.number) {
            res.status(400).json({
                success: false,
                error: 'ticketData with number is required'
            });
            return;
        }

        logger.info({ ticket: ticketData.number }, 'Print ticket request received');

        res.json({
            success: true,
            message: 'Print data validated',
            ticket: ticketData.number,
            timestamp: new Date().toISOString(),
            note: 'Client-side printing enabled'
        });
    } catch (error) {
        logger.error({ err: error }, 'Print validation error');
        res.status(500).json({
            success: false,
            error: 'Print validation failed',
            details: error.message
        });
    }
});

router.get('/printer-config', async (req, res) => {
    try {
        const rows = await all(
            "SELECT key, value FROM settings WHERE key LIKE 'printer.%'"
        );

        const config = rows.reduce((acc, row) => {
            const key = row.key.replace('printer.', '');
            acc[key] = row.value;
            return acc;
        }, {});

        res.json({
            method: config.method || 'browser',
            printerName: config.name || 'TM-T203',
            paperWidth: parseInt(config.width, 10) || 58,
            autoprint: config.autoprint === 'true',
            localServerUrl: config.localServerUrl || 'http://localhost:9100',
            ...config
        });
    } catch (error) {
        logger.error({ err: error }, 'Error fetching printer config');
        res.status(500).json({ error: 'Failed to fetch printer settings' });
    }
});

router.get('/printer-health', (req, res) => {
    res.json({
        status: 'ok',
        message: 'Server ready for print requests',
        clientPrinting: true,
        timestamp: new Date().toISOString()
    });
});

module.exports = router;
