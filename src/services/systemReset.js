const { getDb } = require('../database/connection');
const { withTransaction } = require('../database/dbClient');
const { broadcastQueueUpdated, broadcastSystemAlert } = require('../realtime/eventBroadcaster');
const { logEvent, EventTypes } = require('../database/events');
const logger = require('../utils/logger');
const { invalidateSettingsCache } = require('../database/db');

const RESET_TIME_KEY = 'config.reset_time';
const RESET_ENABLED_KEY = 'config.daily_reset';

let ioInstance = null;
let schedulerTimer = null;
let schedulerConfig = {
    enabled: false,
    time: '00:00',
    minutes: 0
};
let lastResetAt = null;
let lastResetReason = null;
let lastResetSummary = null;
let lastResetDayKey = null;
let resetInProgress = false;

function setIoInstance(io) {
    ioInstance = io;
}

function parseTimeToMinutes(timeString) {
    if (typeof timeString !== 'string') {
        return 0;
    }

    const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(timeString.trim());
    if (!match) {
        return 0;
    }

    const hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);
    return hours * 60 + minutes;
}

function getTodayKey(date = new Date()) {
    return date.toISOString().slice(0, 10);
}

function computeNextRunIso() {
    if (!schedulerConfig.enabled) {
        return null;
    }

    const now = new Date();
    const target = new Date(now);
    target.setHours(0, schedulerConfig.minutes, 0, 0);

    if (now.getHours() * 60 + now.getMinutes() >= schedulerConfig.minutes) {
        target.setDate(target.getDate() + 1);
    }

    return target.toISOString();
}

async function loadResetSettingsFromDb() {
    const db = getDb();
    const keys = [RESET_TIME_KEY, RESET_ENABLED_KEY];

    return new Promise((resolve, reject) => {
        db.all(
            `SELECT key, value FROM settings WHERE key IN (${keys.map(() => '?').join(',')})`,
            keys,
            (err, rows) => {
                if (err) {
                    reject(err);
                    return;
                }

                const values = rows.reduce((acc, row) => {
                    acc[row.key] = row.value;
                    return acc;
                }, {});

                resolve({
                    time: values[RESET_TIME_KEY] || '00:00',
                    enabled: values[RESET_ENABLED_KEY] === 'true'
                });
            }
        );
    });
}

function updateSchedulerConfig(config) {
    const minutes = parseTimeToMinutes(config.time);
    schedulerConfig = {
        enabled: Boolean(config.enabled),
        time: config.time || '00:00',
        minutes
    };
}

async function ensureSchedulerTimer() {
    if (schedulerTimer) {
        clearInterval(schedulerTimer);
        schedulerTimer = null;
    }

    if (!schedulerConfig.enabled) {
        return;
    }

    schedulerTimer = setInterval(async () => {
        try {
            await maybeRunScheduledReset();
        } catch (error) {
            logger.error({ err: error }, 'Scheduled reset check failed');
        }
    }, 60 * 1000);
}

async function maybeRunScheduledReset() {
    if (!schedulerConfig.enabled || resetInProgress) {
        return;
    }

    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    if (nowMinutes < schedulerConfig.minutes) {
        return;
    }

    const todayKey = getTodayKey(now);
    if (lastResetDayKey === todayKey) {
        return;
    }

    await performSystemReset({
        reason: 'scheduled',
        initiatedBy: 'scheduler',
        silent: false
    });

    lastResetDayKey = todayKey;
}

async function synchronizeScheduler(io) {
    if (io) {
        setIoInstance(io);
    }

    try {
        const config = await loadResetSettingsFromDb();
        updateSchedulerConfig(config);
        await ensureSchedulerTimer();
        logger.info(
            {
                enabled: schedulerConfig.enabled,
                time: schedulerConfig.time
            },
            'Queue reset scheduler synchronised'
        );
    } catch (error) {
        logger.error({ err: error }, 'Failed to synchronise reset scheduler');
    }
}

async function upsertSetting(key, value) {
    const db = getDb();
    return new Promise((resolve, reject) => {
        db.run(
            `
            INSERT INTO settings (key, value, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = CURRENT_TIMESTAMP
        `,
            [key, value],
            (err) => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            }
        );
    });
}

async function performSystemReset({ reason = 'manual', initiatedBy = 'admin', silent = false } = {}) {
    if (resetInProgress) {
        return {
            skipped: true,
            message: 'Reset already in progress'
        };
    }

    resetInProgress = true;

    try {
        const result = await withTransaction(async (tx) => {
            const ticketRow = await tx.get('SELECT COUNT(*) as total FROM tickets');
            const deletedTickets = ticketRow?.total || 0;

            await tx.run(
                `UPDATE counters
                 SET current_ticket_id = NULL,
                     state = CASE WHEN state = 'serving' THEN 'available' ELSE state END`
            );
            await tx.run('DELETE FROM tickets');
            await tx.run("DELETE FROM sqlite_sequence WHERE name = 'tickets'");
            await tx.run('UPDATE services SET current_number = 0');

            const services = await tx.all(
                'SELECT id, name, prefix FROM services WHERE is_active = 1'
            );

            return {
                deletedTickets,
                services
            };
        });

        lastResetAt = new Date().toISOString();
        lastResetReason = reason;
        lastResetSummary = result;

        logEvent(EventTypes.SYSTEM_RESET, 'system', 0, {
            reason,
            deletedTickets: result.deletedTickets,
            timestamp: lastResetAt,
            initiatedBy
        }).catch((err) => logger.error({ err }, 'Failed to log system reset event'));

        if (ioInstance) {
            result.services.forEach((service) => {
                broadcastQueueUpdated(ioInstance, service.id, {
                    serviceId: service.id,
                    waiting: 0,
                    serving: 0,
                    tickets: []
                });
            });

            if (!silent) {
                broadcastSystemAlert(
                    ioInstance,
                    `Queues reset (${reason}).`,
                    'warning',
                    ['terminal', 'monitor', 'kiosk']
                );
            }
        }

        return {
            ...result,
            resetAt: lastResetAt,
            reason
        };
    } catch (error) {
        logger.error({ err: error }, 'System reset failed');
        throw error;
    } finally {
        resetInProgress = false;
    }
}

async function presetServiceQueue({
    serviceId,
    startNumber,
    count,
    priority = 0,
    initiatedBy = 'admin'
}) {
    if (!Number.isInteger(serviceId) || serviceId <= 0) {
        throw new Error('serviceId must be a positive integer');
    }
    if (!Number.isInteger(startNumber) || startNumber < 0) {
        throw new Error('startNumber must be zero or positive integer');
    }
    if (!Number.isInteger(count) || count <= 0) {
        throw new Error('count must be a positive integer');
    }
    if (count > 500) {
        throw new Error('count may not exceed 500 tickets per request');
    }

    const result = await withTransaction(async (tx) => {
        const service = await tx.get(
            'SELECT * FROM services WHERE id = ? AND is_active = 1',
            [serviceId]
        );

        if (!service) {
            throw new Error('Service not found or inactive');
        }

        const baseQueueRow =
            (await tx.get(
                `SELECT COUNT(*) as waiting
                 FROM tickets
                 WHERE service_id = ?
                   AND state IN ('waiting', 'recycled', 'called')`,
                [serviceId]
            )) || {};

        const existingWaiting = baseQueueRow.waiting || 0;
        const estimatedServiceTime = service.estimated_service_time || 300;

        const insertedTickets = [];
        const skippedTickets = [];

        for (let i = 1; i <= count; i += 1) {
            const numberValue = startNumber + i;
            const ticketNumber = `${service.prefix}${String(numberValue).padStart(3, '0')}`;

            const alreadyExists = await tx.get(
                'SELECT id FROM tickets WHERE service_id = ? AND ticket_number = ?',
                [serviceId, ticketNumber]
            );

            if (alreadyExists) {
                skippedTickets.push(ticketNumber);
                continue;
            }

            const queuePosition = existingWaiting + insertedTickets.length;
            const createdAt = new Date(Date.now() + insertedTickets.length).toISOString();
            const estimatedWait = estimatedServiceTime * queuePosition;

            const insertResult = await tx.run(
                `INSERT INTO tickets (
                    ticket_number,
                    service_id,
                    state,
                    priority,
                    created_at,
                    estimated_wait
                ) VALUES (?, ?, 'waiting', ?, ?, ?)`,
                [ticketNumber, serviceId, priority, createdAt, estimatedWait]
            );

            insertedTickets.push({
                id: insertResult.lastID,
                ticket_number: ticketNumber,
                created_at: createdAt,
                priority
            });
        }

        const targetCurrentNumber = startNumber + count;
        const newCurrentNumber = Math.max(service.current_number || 0, targetCurrentNumber);

        await tx.run('UPDATE services SET current_number = ? WHERE id = ?', [
            newCurrentNumber,
            serviceId
        ]);

        const queueRows = await tx.all(
            `SELECT id,
                    ticket_number,
                    priority,
                    created_at,
                    estimated_wait,
                    state
             FROM tickets
             WHERE service_id = ?
               AND state = 'waiting'
             ORDER BY priority DESC, created_at ASC`,
            [serviceId]
        );

        const servingRow =
            (await tx.get(
                `SELECT COUNT(*) as serving
                 FROM tickets
                 WHERE service_id = ?
                   AND state = 'called'`,
                [serviceId]
            )) || {};

        return {
            insertedTickets,
            skippedTickets,
            service: {
                id: service.id,
                name: service.name,
                prefix: service.prefix
            },
            finalNumber: newCurrentNumber,
            queueSnapshot: {
                serviceId,
                waiting: queueRows.length,
                serving: servingRow.serving || 0,
                tickets: queueRows.map((row) => ({
                    id: row.id,
                    ticket_number: row.ticket_number,
                    number: row.ticket_number,
                    priority: row.priority,
                    created_at: row.created_at,
                    estimated_wait: row.estimated_wait,
                    state: row.state
                }))
            }
        };
    });

    if (ioInstance) {
        broadcastQueueUpdated(ioInstance, serviceId, result.queueSnapshot);
    }

    logEvent(EventTypes.QUEUE_PRESET, 'service', serviceId, {
        inserted: result.insertedTickets.length,
        skipped: result.skippedTickets.length,
        finalNumber: result.finalNumber,
        initiatedBy
    }).catch((err) => logger.error({ err }, 'Failed to log queue preset event'));

    return result;
}

async function updateResetConfiguration({ resetTime, dailyReset }) {
    if (!resetTime || !/^([01]?\d|2[0-3]):([0-5]\d)$/.test(resetTime)) {
        throw new Error('resetTime must be in HH:MM 24h format');
    }

    const normalizedEnabled =
        typeof dailyReset === 'boolean'
            ? dailyReset
            : typeof dailyReset === 'string'
              ? dailyReset.toLowerCase() === 'true'
              : Boolean(dailyReset);

    await Promise.all([
        upsertSetting(RESET_TIME_KEY, resetTime),
        upsertSetting(RESET_ENABLED_KEY, normalizedEnabled ? 'true' : 'false')
    ]);

    await synchronizeScheduler();
    invalidateSettingsCache();
}

function getResetStatus() {
    return {
        enabled: schedulerConfig.enabled,
        resetTime: schedulerConfig.time,
        nextRunAt: computeNextRunIso(),
        lastResetAt,
        lastResetReason,
        lastResetSummary,
        inProgress: resetInProgress
    };
}

module.exports = {
    performSystemReset,
    presetServiceQueue,
    initializeResetScheduler: synchronizeScheduler,
    reloadResetScheduler: synchronizeScheduler,
    updateResetConfiguration,
    getResetStatus
};
