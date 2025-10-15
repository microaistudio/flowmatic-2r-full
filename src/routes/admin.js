const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { getDb } = require('../database/connection');
const { logEvent, EventTypes } = require('../database/events');
const logger = require('../utils/logger');
const systemResetService = require('../services/systemReset');
const { invalidateSettingsCache } = require('../database/db');

function buildAdminConfig() {
    const rawPassword = process.env.ADMIN_PASSWORD;
    const sessionSecret = process.env.SESSION_SECRET;

    if (!rawPassword || !rawPassword.trim()) {
        logger.fatal('ADMIN_PASSWORD environment variable must be set for admin access.');
        throw new Error('ADMIN_PASSWORD environment variable missing');
    }

    if (rawPassword === 'admin123') {
        logger.fatal('ADMIN_PASSWORD cannot use the insecure default value.');
        throw new Error('ADMIN_PASSWORD uses insecure default value');
    }

    if (!sessionSecret || !sessionSecret.trim()) {
        logger.fatal('SESSION_SECRET environment variable must be set for JWT signing.');
        throw new Error('SESSION_SECRET environment variable missing');
    }

    if (sessionSecret === 'flowmatic-admin-secret') {
        logger.fatal('SESSION_SECRET cannot use the insecure default value.');
        throw new Error('SESSION_SECRET uses insecure default value');
    }

    return {
        JWT_SECRET: sessionSecret,
        PASSWORD_HASH: bcrypt.hashSync(rawPassword, 10),
        SESSION_TIMEOUT: 8 * 60 * 60 * 1000 // 8 hours
    };
}

// Admin authentication configuration
const ADMIN_CONFIG = buildAdminConfig();

// Ensure agents table has password_hash column for credential management
(() => {
    try {
        const schemaDb = getDb();
        schemaDb.run('ALTER TABLE agents ADD COLUMN password_hash TEXT', (err) => {
            if (err && !/duplicate column name/i.test(err.message)) {
                logger.warn({ err }, 'Unable to ensure agents.password_hash column');
            }
        });
    } catch (err) {
        logger.warn({ err }, 'Failed to verify agents schema');
    }
})();

const loginLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        error: 'Too many login attempts. Please try again shortly.'
    }
});

// Password verification utility
const verifyPassword = async (inputPassword) => {
    return bcrypt.compare(inputPassword, ADMIN_CONFIG.PASSWORD_HASH);
};

// Admin authentication middleware
const verifyAdminAuth = (req, res, next) => {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN
    
    if (!token) {
        return res.status(401).json({
            success: false,
            error: 'Authentication token required'
        });
    }
    
    try {
        const decoded = jwt.verify(token, ADMIN_CONFIG.JWT_SECRET);
        req.admin = decoded;
        next();
    } catch (error) {
        return res.status(401).json({
            success: false,
            error: 'Invalid or expired token'
        });
    }
};

const SETTINGS_KEY_MAP = {
    // Feature flags
    voiceEnabled: 'feature.voice_announcements',
    cherryPickEnabled: 'feature.cherry_pick',
    parkEnabled: 'feature.park_unpark',
    recycleEnabled: 'feature.recycle',
    multiServiceEnabled: 'feature.multi_service',
    languagesEnabled: 'feature.languages',
    // Queue / config values
    maxRecalls: 'config.max_recall_count',
    autoComplete: 'config.auto_complete_timeout',
    recyclePosition: 'config.recycle_position',
    resetTime: 'config.reset_time',
    dailyReset: 'config.daily_reset',
    defaultLanguage: 'config.default_language',
    enabledLanguages: 'config.enabled_languages',
    timeFormat: 'config.time_format',
    timezone: 'config.timezone',
    dateFormat: 'config.date_format',
    autoBackup: 'config.auto_backup',
    backupFrequency: 'config.backup_frequency',
    dataRetention: 'config.data_retention_days',
    logRetention: 'config.log_retention_days'
};

function coerceSettingValue(value) {
    if (typeof value === 'boolean') {
        return value ? 'true' : 'false';
    }
    if (Array.isArray(value)) {
        return JSON.stringify(value);
    }
    if (value === null || value === undefined) {
        return null;
    }
    return String(value);
}

function normalizeSettingsRows(rows = []) {
    const valueMap = rows.reduce((acc, row) => {
        acc[row.key] = row.value;
        return acc;
    }, {});

    const normalized = {};

    Object.entries(SETTINGS_KEY_MAP).forEach(([clientKey, dbKey]) => {
        if (Object.prototype.hasOwnProperty.call(valueMap, dbKey)) {
            const rawValue = valueMap[dbKey];
            if (rawValue === 'true' || rawValue === 'false') {
                normalized[clientKey] = rawValue === 'true';
            } else if (clientKey === 'enabledLanguages') {
                try {
                    normalized[clientKey] = JSON.parse(rawValue);
                } catch {
                    normalized[clientKey] = Array.isArray(rawValue) ? rawValue : String(rawValue || '').split(',').filter(Boolean);
                }
            } else if (
                ['maxRecalls', 'recallInterval', 'ticketTimeout', 'maxWaitingTickets', 'refreshInterval', 'sessionTimeout', 'adminSessionTimeout', 'dataRetention', 'logRetention', 'recyclePosition'].includes(clientKey)
            ) {
                const parsed = parseInt(rawValue, 10);
                normalized[clientKey] = Number.isNaN(parsed) ? null : parsed;
            } else {
                normalized[clientKey] = rawValue;
            }
        }
    });

    return normalized;
}

function dbAll(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

function dbGet(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function dbRun(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function runCallback(err) {
            if (err) reject(err);
            else resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

function toBoolean(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    if (typeof value === 'string') {
        return value.toLowerCase() === 'true' || value === '1';
    }
    return false;
}

function mapServiceRow(row, stats = {}) {
    return {
        id: row.id,
        name: row.name,
        prefix: row.prefix,
        description: row.description || '',
        range_start: row.range_start,
        range_end: row.range_end,
        current_number: row.current_number || 0,
        is_active: toBoolean(row.is_active),
        estimated_service_time: row.estimated_service_time || 0,
        tickets_today: stats.tickets_today || 0,
        avg_wait_today: stats.avg_wait_today || 0
    };
}

async function getServiceStats(db, serviceId) {
    const row = await dbGet(
        db,
        `SELECT COUNT(*) as tickets_today,
                AVG(actual_wait) as avg_wait_seconds
         FROM tickets
         WHERE service_id = ?
           AND DATE(created_at) = DATE('now')`,
        [serviceId]
    );

    const avgWaitSeconds = row?.avg_wait_seconds || 0;
    return {
        tickets_today: row?.tickets_today || 0,
        avg_wait_today: avgWaitSeconds ? Number((avgWaitSeconds / 60).toFixed(1)) : 0
    };
}

async function getServiceById(db, serviceId) {
    const row = await dbGet(db, 'SELECT * FROM services WHERE id = ?', [serviceId]);
    if (!row) {
        return null;
    }
    const stats = await getServiceStats(db, serviceId);
    return mapServiceRow(row, stats);
}

function validateServicePayload(body = {}, { isUpdate = false } = {}) {
    const errors = [];

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const prefix = typeof body.prefix === 'string' ? body.prefix.trim() : '';
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    const rangeStartRaw = body.range_start ?? body.rangeStart;
    const rangeEndRaw = body.range_end ?? body.rangeEnd;
    const currentNumberRaw = body.current_number ?? body.currentNumber;
    const estimatedTimeRaw = body.estimated_service_time ?? body.estimatedServiceTime;
    const isActiveRaw = body.is_active ?? body.isActive;

    const rangeStart = parseInt(rangeStartRaw, 10);
    const rangeEnd = parseInt(rangeEndRaw, 10);
    const currentNumber = Number.isNaN(parseInt(currentNumberRaw, 10)) ? 0 : parseInt(currentNumberRaw, 10);
    const estimatedServiceTime = Number.isNaN(parseInt(estimatedTimeRaw, 10)) ? 300 : parseInt(estimatedTimeRaw, 10);
    const isActive = toBoolean(isActiveRaw ?? true);

    if (!name) {
        errors.push('Service name is required');
    }

    if (!prefix) {
        errors.push('Service prefix is required');
    } else if (prefix.length > 3) {
        errors.push('Service prefix must be three characters or fewer');
    }

    if (!Number.isInteger(rangeStart) || rangeStart < 1) {
        errors.push('Range start must be a positive integer');
    }

    if (!Number.isInteger(rangeEnd) || rangeEnd < 1) {
        errors.push('Range end must be a positive integer');
    }

    if (Number.isInteger(rangeStart) && Number.isInteger(rangeEnd) && rangeStart >= rangeEnd) {
        errors.push('Range end must be greater than range start');
    }

    if (errors.length > 0) {
        return { errors };
    }

    return {
        errors,
        data: {
            name,
            prefix,
            description,
            range_start: rangeStart,
            range_end: rangeEnd,
            current_number: currentNumber >= 0 ? currentNumber : 0,
            estimated_service_time: estimatedServiceTime > 0 ? estimatedServiceTime : 300,
            is_active: isActive ? 1 : 0
        }
    };
}

async function getAllAgents(db) {
    const agentRows = await dbAll(
        db,
        `SELECT a.*, c.id AS counter_id, c.name AS counter_name, c.state AS counter_state
         FROM agents a
         LEFT JOIN counters c ON c.current_agent_id = a.id
         ORDER BY LOWER(a.name)`
    );

    const serviceRows = await dbAll(
        db,
        `SELECT asg.agent_id,
                asg.service_id,
                asg.priority,
                s.name AS service_name,
                s.prefix
         FROM agent_services asg
         JOIN services s ON s.id = asg.service_id
         ORDER BY asg.agent_id, asg.priority`
    );

    const statsRows = await dbAll(
        db,
        `SELECT agent_id,
                COUNT(*) AS tickets_today,
                AVG(service_duration) AS avg_service_seconds
         FROM tickets
         WHERE agent_id IS NOT NULL
           AND DATE(created_at) = DATE('now')
         GROUP BY agent_id`
    );

    const servicesByAgent = serviceRows.reduce((acc, row) => {
        if (!acc[row.agent_id]) {
            acc[row.agent_id] = [];
        }
        acc[row.agent_id].push({
            service_id: row.service_id,
            service_name: row.service_name,
            prefix: row.prefix,
            priority: row.priority
        });
        return acc;
    }, {});

    const statsByAgent = statsRows.reduce((acc, row) => {
        const avgMinutes = row.avg_service_seconds
            ? Number((row.avg_service_seconds / 60).toFixed(1))
            : 0;
        const efficiency = avgMinutes
            ? Math.max(0, Math.min(100, Math.round(100 - avgMinutes * 5)))
            : 100;
        acc[row.agent_id] = {
            tickets_today: row.tickets_today || 0,
            avg_service_minutes: avgMinutes,
            efficiency
        };
        return acc;
    }, {});

    return agentRows.map((row) =>
        mapAgentRow(row, servicesByAgent[row.id] || [], statsByAgent[row.id] || {})
    );
}

async function getAgentById(db, agentId) {
    const row = await dbGet(
        db,
        `SELECT a.*, c.id AS counter_id, c.name AS counter_name, c.state AS counter_state
         FROM agents a
         LEFT JOIN counters c ON c.current_agent_id = a.id
         WHERE a.id = ?`,
        [agentId]
    );

    if (!row) {
        return null;
    }

    const services = await dbAll(
        db,
        `SELECT asg.service_id,
                asg.priority,
                s.name AS service_name,
                s.prefix
         FROM agent_services asg
         JOIN services s ON s.id = asg.service_id
         WHERE asg.agent_id = ?
         ORDER BY asg.priority, s.name`,
        [agentId]
    );

    const statsRow = await dbGet(
        db,
        `SELECT COUNT(*) AS tickets_today,
                AVG(service_duration) AS avg_service_seconds
         FROM tickets
         WHERE agent_id = ?
           AND DATE(created_at) = DATE('now')`,
        [agentId]
    );

    const avgMinutes = statsRow?.avg_service_seconds
        ? Number((statsRow.avg_service_seconds / 60).toFixed(1))
        : 0;
    const efficiency = avgMinutes
        ? Math.max(0, Math.min(100, Math.round(100 - avgMinutes * 5)))
        : 100;

    return mapAgentRow(row, services, {
        tickets_today: statsRow?.tickets_today || 0,
        avg_service_minutes: avgMinutes,
        efficiency
    });
}

async function replaceAgentServices(db, agentId, services = []) {
    await dbRun(db, 'DELETE FROM agent_services WHERE agent_id = ?', [agentId]);

    if (!services.length) {
        return;
    }

    for (const service of services) {
        await dbRun(
            db,
            'INSERT INTO agent_services (agent_id, service_id, priority) VALUES (?, ?, ?)',
            [agentId, service.service_id, service.priority]
        );
    }
}

function mapAgentRow(row, services = [], stats = {}) {
    const active = toBoolean(row.is_active);
    const status = active && row.counter_id
        ? row.counter_state === 'break'
            ? 'break'
            : 'online'
        : 'offline';

    const avgServiceMinutes = stats.avg_service_minutes || 0;

    return {
        id: row.id,
        name: row.name,
        username: row.username,
        email: row.email || null,
        role: row.role ? row.role.toLowerCase() : 'agent',
        is_active: active,
        status,
        current_counter: row.counter_name || null,
        services: services.map((service) => ({
            service_id: service.service_id,
            service_name: service.service_name,
            prefix: service.prefix,
            priority: service.priority
        })),
        performance: {
            tickets_today: stats.tickets_today || 0,
            avg_service_time: avgServiceMinutes,
            efficiency: stats.efficiency || 100
        }
    };
}

function validateAgentPayload(body = {}) {
    const errors = [];

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const usernameRaw = typeof body.username === 'string' ? body.username.trim() : '';
    const username = usernameRaw.toLowerCase();
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const roleRaw = typeof body.role === 'string' ? body.role.trim().toLowerCase() : 'agent';
    const isActive = toBoolean(body.is_active ?? true);
    const password = typeof body.password === 'string' ? body.password.trim() : '';
    const servicesInput = Array.isArray(body.services) ? body.services : [];

    if (!name) {
        errors.push('Agent name is required');
    }

    if (!username) {
        errors.push('Username is required');
    } else if (username.length < 3) {
        errors.push('Username must be at least 3 characters');
    }

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        errors.push('Invalid email address');
    }

    const allowedRoles = new Set(['agent', 'supervisor', 'admin']);
    const role = allowedRoles.has(roleRaw) ? roleRaw : 'agent';

    const servicesMap = new Map();
    servicesInput.forEach((service) => {
        const serviceId = parseInt(service.service_id ?? service.id, 10);
        if (Number.isNaN(serviceId)) {
            return;
        }
        const rawPriority = parseInt(service.priority ?? 1, 10);
        const priority = rawPriority === 2 ? 2 : 1;
        servicesMap.set(serviceId, {
            service_id: serviceId,
            priority
        });
    });

    const services = Array.from(servicesMap.values());

    if (services.length === 0) {
        errors.push('At least one service must be assigned');
    }

    return {
        errors,
        data: {
            name,
            username,
            email,
            role,
            is_active: isActive ? 1 : 0,
            services,
            password
        }
    };
}

function generateTemporaryPassword(length = 10) {
    const raw = crypto.randomBytes(Math.ceil((length * 3) / 4)).toString('base64');
    const sanitized = raw.replace(/[^a-zA-Z0-9]/g, '');
    return sanitized.slice(0, length) || 'Agent123';
}

// POST /api/admin/login - Admin authentication
router.post('/login', loginLimiter, async (req, res) => {
    try {
        const { password } = req.body;
        
        if (!password) {
            return res.status(400).json({
                success: false,
                error: 'Password is required'
            });
        }
        
        const isValid = await verifyPassword(password);
        
        if (!isValid) {
            return res.status(401).json({
                success: false,
                error: 'Invalid admin password'
            });
        }
        
        // Generate JWT token
        const token = jwt.sign(
            { 
                userId: 'admin', 
                role: 'admin',
                loginTime: Date.now()
            }, 
            ADMIN_CONFIG.JWT_SECRET, 
            { expiresIn: '8h' }
        );
        
        // Log the admin login event (use existing logEvent if available)
        logEvent(
            'ADMIN_LOGIN',
            'admin',
            1,
            {
                loginTime: new Date().toISOString(),
                ip: req.ip || req.connection?.remoteAddress
            }
        ).catch((err) =>
            logger.error({ err }, 'Event logging failed for admin login')
        );
        
        res.json({
            success: true,
            token: token,
            message: 'Admin login successful',
            expiresIn: '8 hours'
        });
        
    } catch (error) {
        logger.error({ err: error }, 'Admin login error');
        res.status(500).json({
            success: false,
            error: 'Login failed due to server error'
        });
    }
});

// GET /api/admin/verify - Verify admin token
router.get('/verify', verifyAdminAuth, (req, res) => {
    res.json({
        success: true,
        admin: {
            userId: req.admin.userId,
            role: req.admin.role,
            loginTime: req.admin.loginTime
        },
        message: 'Token is valid'
    });
});

// ===== ADMIN ENDPOINTS =====

// GET /api/admin/settings - Get all settings
router.get('/settings', verifyAdminAuth, (req, res) => {
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
      logger.error({ err }, 'Settings fetch error');
      return res.status(500).json({ error: 'Failed to fetch settings' });
    }

    const normalized = normalizeSettingsRows(settings);
    res.json({ settings, normalized });
  });
});

router.get('/dashboard/summary', verifyAdminAuth, async (_req, res) => {
  const db = getDb();

  try {
    const ticketsTodayRow = await dbGet(
      db,
      `SELECT COUNT(*) AS total
       FROM tickets
       WHERE DATE(created_at) = DATE('now')`
    );

    const waitingRow = await dbGet(
      db,
      `SELECT COUNT(DISTINCT service_id) AS active_queues,
              SUM(CASE WHEN state IN ('waiting','recycled') THEN 1 ELSE 0 END) AS waiting_tickets
       FROM tickets
       WHERE state IN ('waiting','recycled')`
    );

    const agentsRow = await dbGet(
      db,
      `SELECT
          (SELECT COUNT(*) FROM agents) AS total_agents,
          (SELECT COUNT(*) FROM sessions WHERE is_active = 1) AS online_agents`
    );

    const avgWaitRow = await dbGet(
      db,
      `SELECT AVG(actual_wait) AS avg_wait
       FROM tickets
       WHERE actual_wait IS NOT NULL
         AND DATE(served_at) = DATE('now')`
    );

    const summary = {
      ticketsToday: ticketsTodayRow?.total || 0,
      waitingTickets: waitingRow?.waiting_tickets || 0,
      activeQueues: waitingRow?.active_queues || 0,
      agentsOnline: agentsRow?.online_agents || 0,
      totalAgents: agentsRow?.total_agents || 0,
      avgWaitMinutes: avgWaitRow?.avg_wait ? Number((avgWaitRow.avg_wait / 60).toFixed(1)) : 0
    };

    res.json({ success: true, summary });
  } catch (error) {
    logger.error({ err: error }, 'Failed to build dashboard summary');
    res.status(500).json({ success: false, error: 'Failed to load dashboard summary' });
  }
});

router.get('/dashboard/queues', verifyAdminAuth, async (_req, res) => {
  const db = getDb();

  try {
    const rows = await dbAll(
      db,
      `SELECT s.id,
              s.name,
              s.prefix,
              s.description,
              SUM(CASE WHEN t.state IN ('waiting','recycled') THEN 1 ELSE 0 END) AS waiting
       FROM services s
       LEFT JOIN tickets t ON t.service_id = s.id
       GROUP BY s.id
       ORDER BY s.id`
    );

    const queues = rows.map((row) => ({
      serviceId: row.id,
      name: row.name,
      prefix: row.prefix,
      description: row.description || '',
      waiting: row.waiting || 0
    }));

    res.json({ success: true, queues });
  } catch (error) {
    logger.error({ err: error }, 'Failed to load queue status');
    res.status(500).json({ success: false, error: 'Failed to load queue status' });
  }
});

router.get('/dashboard/activity', verifyAdminAuth, async (_req, res) => {
  const db = getDb();

  const describeEvent = (event) => {
    const payload = (() => {
      try {
        return event.data ? JSON.parse(event.data) : {};
      } catch (err) {
        return {};
      }
    })();

    switch (event.event_type) {
      case EventTypes.TICKET_CREATED:
        return `Ticket ${payload.ticketNumber || payload.ticket_number || ''} created`;
      case EventTypes.TICKET_CALLED:
        return `Ticket ${payload.ticketNumber || payload.ticket_number || ''} called at counter ${payload.counterId || payload.counter_id || ''}`;
      case EventTypes.TICKET_COMPLETED:
        return `Ticket ${payload.ticketNumber || payload.ticket_number || ''} completed`;
      case EventTypes.TICKET_TRANSFERRED:
        return `Ticket ${payload.ticketNumber || payload.ticket_number || ''} transferred to service ${payload.toServiceId || payload.to_service_id || ''}`;
      case EventTypes.TICKET_RECYCLED:
        return `Ticket ${payload.ticketNumber || payload.ticket_number || ''} recycled`;
      case EventTypes.TICKET_NO_SHOW:
        return `Ticket ${payload.ticketNumber || payload.ticket_number || ''} marked no-show`;
      case EventTypes.AGENT_LOGIN:
        return 'Agent logged in';
      case EventTypes.AGENT_LOGOUT:
        return 'Agent logged out';
      case EventTypes.SYSTEM_RESET:
        return `System reset (${payload.reason || 'manual'})`;
      default:
        return event.event_type.replace(/_/g, ' ');
    }
  };

  try {
    const rows = await dbAll(
      db,
      `SELECT event_type, data, created_at
       FROM events
       ORDER BY created_at DESC
       LIMIT 12`
    );

    const activity = rows.map((row) => ({
      type: row.event_type,
      timestamp: row.created_at,
      description: describeEvent(row)
    }));

    res.json({ success: true, activity });
  } catch (error) {
    logger.error({ err: error }, 'Failed to load recent activity');
    res.status(500).json({ success: false, error: 'Failed to load activity feed' });
  }
});

// PUT /api/admin/settings - Update settings
router.put('/settings', verifyAdminAuth, (req, res) => {
  const db = getDb();

  let updates = req.body?.updates;

  if (!updates || !Array.isArray(updates) || updates.length === 0) {
    const body = req.body || {};
    const derivedUpdates = [];

    Object.entries(SETTINGS_KEY_MAP).forEach(([clientKey, dbKey]) => {
      if (Object.prototype.hasOwnProperty.call(body, clientKey)) {
        const coerced = coerceSettingValue(body[clientKey]);
        if (coerced !== null && coerced !== undefined) {
          derivedUpdates.push({ key: dbKey, value: coerced });
        }
      }
    });

    if (derivedUpdates.length === 0) {
      return res.status(400).json({ error: 'No valid settings provided' });
    }

    updates = derivedUpdates;
  }
  
  // Start transaction
  const resetSettingKeys = new Set(['config.reset_time', 'config.daily_reset']);
  let shouldReloadResetScheduler = false;

  const processedUpdates = [];
  updates.forEach(({ key, value }) => {
    const coercedValue = coerceSettingValue(value);
    if (!key || coercedValue === null || coercedValue === undefined) {
      return;
    }
    if (resetSettingKeys.has(key)) {
      shouldReloadResetScheduler = true;
    }
    processedUpdates.push({ key, value: coercedValue });
  });

  updates = processedUpdates;

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No valid settings provided' });
  }

  logger.info({ updates }, 'Admin settings update request');

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
    
    updates.forEach((update) => {
      if (hasError) return;
      
      const { key, value } = update;
      if (!key || value === undefined) {
        hasError = true;
        db.run('ROLLBACK', () => {
          res.status(400).json({ error: 'Invalid update format' });
        });
        return;
      }
      
      const sql = `
        INSERT INTO settings (key, value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = CURRENT_TIMESTAMP
      `;
      db.run(sql, [key, value], function(updateErr) {
        if (updateErr) {
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
            if (shouldReloadResetScheduler) {
              systemResetService
                .reloadResetScheduler(req.app.get('io'))
                .catch((err) =>
                  logger.error({ err }, 'Failed to reload reset scheduler after settings update')
                );
            }
            invalidateSettingsCache();
            res.json({ message: 'Settings updated successfully', count: updates.length });
          });
        }
      });
    });
  });
});

router.get('/system/reset-status', verifyAdminAuth, (req, res) => {
  const status = systemResetService.getResetStatus();
  res.json({ success: true, status });
});

router.put('/system/reset-config', verifyAdminAuth, async (req, res) => {
  try {
    const { resetTime, dailyReset } = req.body || {};

    if (typeof resetTime !== 'string' || !resetTime.trim()) {
      return res.status(400).json({ error: 'resetTime is required (HH:MM)' });
    }

    await systemResetService.updateResetConfiguration({
      resetTime: resetTime.trim(),
      dailyReset
    });

    res.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, 'Failed to update reset configuration');
    const statusCode = /format|integer/i.test(error.message || '') ? 400 : 500;
    res.status(statusCode).json({ success: false, error: error.message || 'Failed to update reset configuration' });
  }
});

router.post('/system/reset', verifyAdminAuth, async (req, res) => {
  try {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : 'manual';
    const silent = Boolean(req.body?.silent);

    const summary = await systemResetService.performSystemReset({
      reason,
      initiatedBy: req.admin?.userId || 'admin',
      silent
    });

    if (summary.skipped) {
      return res.status(409).json({ success: false, error: summary.message || 'Reset already in progress' });
    }

    res.json({ success: true, summary });
  } catch (error) {
    logger.error({ err: error }, 'Manual system reset failed');
    res.status(500).json({ success: false, error: error.message || 'Failed to reset system' });
  }
});

router.post('/system/preset-queue', verifyAdminAuth, async (req, res) => {
  try {
    const serviceId = parseInt(req.body?.serviceId, 10);
    const startNumber = parseInt(req.body?.startNumber, 10);
    const count = parseInt(req.body?.count, 10);
    const priorityRaw = req.body?.priority;
    const priorityParsed = priorityRaw === undefined ? 0 : parseInt(priorityRaw, 10);
    const priority = Number.isNaN(priorityParsed) ? 0 : Math.max(0, Math.min(priorityParsed, 2));

    if (!Number.isInteger(serviceId) || serviceId <= 0) {
      return res.status(400).json({ success: false, error: 'serviceId must be a positive integer' });
    }
    if (!Number.isInteger(startNumber) || startNumber < 0) {
      return res.status(400).json({ success: false, error: 'startNumber must be zero or a positive integer' });
    }
    if (!Number.isInteger(count) || count <= 0) {
      return res.status(400).json({ success: false, error: 'count must be a positive integer' });
    }

    const result = await systemResetService.presetServiceQueue({
      serviceId,
      startNumber,
      count,
      priority,
      initiatedBy: req.admin?.userId || 'admin'
    });

    res.json({ success: true, result });
  } catch (error) {
    logger.error({ err: error }, 'Preset queue creation failed');
    const statusCode = /service|count|start/i.test(error.message || '') ? 400 : 500;
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to create preset queue'
    });
  }
});

// Services management
router.get('/services', verifyAdminAuth, async (_req, res) => {
  const db = getDb();

  try {
    const rows = await dbAll(db, 'SELECT * FROM services ORDER BY id');
    const services = await Promise.all(
      rows.map(async (row) => {
        const stats = await getServiceStats(db, row.id);
        return mapServiceRow(row, stats);
      })
    );

    res.json({ services });
  } catch (error) {
    logger.error({ err: error }, 'Failed to fetch services');
    res.status(500).json({ error: 'Failed to fetch services' });
  }
});

router.post('/services', verifyAdminAuth, async (req, res) => {
  const db = getDb();

  try {
    const { errors, data } = validateServicePayload(req.body || {});
    if (errors.length) {
      return res.status(400).json({ error: errors.join(', ') });
    }

    const duplicate = await dbGet(
      db,
      'SELECT id FROM services WHERE LOWER(prefix) = LOWER(?)',
      [data.prefix]
    );

    if (duplicate) {
      return res.status(409).json({ error: 'Service prefix already exists' });
    }

    const result = await dbRun(
      db,
      `INSERT INTO services (name, prefix, description, range_start, range_end, current_number, is_active, estimated_service_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)` ,
      [
        data.name,
        data.prefix,
        data.description,
        data.range_start,
        data.range_end,
        data.current_number,
        data.is_active,
        data.estimated_service_time
      ]
    );

    const service = await getServiceById(db, result.lastID);
    res.status(201).json({ service });
  } catch (error) {
    logger.error({ err: error }, 'Failed to create service');
    res.status(500).json({ error: 'Failed to create service' });
  }
});

router.put('/services/:serviceId', verifyAdminAuth, async (req, res) => {
  const db = getDb();
  const serviceId = parseInt(req.params.serviceId, 10);

  if (Number.isNaN(serviceId)) {
    return res.status(400).json({ error: 'Invalid service ID' });
  }

  try {
    const existing = await dbGet(db, 'SELECT * FROM services WHERE id = ?', [serviceId]);
    if (!existing) {
      return res.status(404).json({ error: 'Service not found' });
    }

    const { errors, data } = validateServicePayload(req.body || {}, { isUpdate: true });
    if (errors.length) {
      return res.status(400).json({ error: errors.join(', ') });
    }

    const duplicate = await dbGet(
      db,
      'SELECT id FROM services WHERE LOWER(prefix) = LOWER(?) AND id != ?',
      [data.prefix, serviceId]
    );

    if (duplicate) {
      return res.status(409).json({ error: 'Service prefix already exists' });
    }

    await dbRun(
      db,
      `UPDATE services
       SET name = ?,
           prefix = ?,
           description = ?,
           range_start = ?,
           range_end = ?,
           current_number = ?,
           is_active = ?,
           estimated_service_time = ?
       WHERE id = ?`,
      [
        data.name,
        data.prefix,
        data.description,
        data.range_start,
        data.range_end,
        data.current_number,
        data.is_active,
        data.estimated_service_time,
        serviceId
      ]
    );

    const service = await getServiceById(db, serviceId);
    res.json({ service });
  } catch (error) {
    logger.error({ err: error }, 'Failed to update service');
    res.status(500).json({ error: 'Failed to update service' });
  }
});

router.delete('/services/:serviceId', verifyAdminAuth, async (req, res) => {
  const db = getDb();
  const serviceId = parseInt(req.params.serviceId, 10);

  if (Number.isNaN(serviceId)) {
    return res.status(400).json({ error: 'Invalid service ID' });
  }

  try {
    const existing = await dbGet(db, 'SELECT * FROM services WHERE id = ?', [serviceId]);
    if (!existing) {
      return res.status(404).json({ error: 'Service not found' });
    }

    const ticketCount = await dbGet(
      db,
      'SELECT COUNT(*) as count FROM tickets WHERE service_id = ?',
      [serviceId]
    );

    if (ticketCount?.count > 0) {
      return res.status(400).json({ error: 'Cannot delete service with existing tickets' });
    }

    await dbRun(db, 'DELETE FROM services WHERE id = ?', [serviceId]);
    res.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, 'Failed to delete service');
    res.status(500).json({ error: 'Failed to delete service' });
  }
});

// Agents management
router.get('/agents', verifyAdminAuth, async (_req, res) => {
  const db = getDb();

  try {
    const agents = await getAllAgents(db);
    res.json({ agents });
  } catch (error) {
    logger.error({ err: error }, 'Failed to fetch agents');
    res.status(500).json({ error: 'Failed to fetch agents' });
  }
});

router.get('/agents/:agentId', verifyAdminAuth, async (req, res) => {
  const db = getDb();
  const agentId = parseInt(req.params.agentId, 10);

  if (Number.isNaN(agentId)) {
    return res.status(400).json({ error: 'Invalid agent ID' });
  }

  try {
    const agent = await getAgentById(db, agentId);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    res.json({ agent });
  } catch (error) {
    logger.error({ err: error }, 'Failed to fetch agent');
    res.status(500).json({ error: 'Failed to fetch agent' });
  }
});

router.post('/agents', verifyAdminAuth, async (req, res) => {
  const db = getDb();

  try {
    const { errors, data } = validateAgentPayload(req.body || {});
    if (errors.length) {
      return res.status(400).json({ error: errors.join(', ') });
    }

    const existing = await dbGet(
      db,
      'SELECT id FROM agents WHERE LOWER(username) = ?',
      [data.username]
    );

    if (existing) {
      return res.status(409).json({ error: 'Username already exists' });
    }

    const services = await dbAll(db, 'SELECT id, name, prefix FROM services');
    const serviceMap = new Map(services.map((svc) => [svc.id, svc]));

    const assignments = data.services
      .filter((service) => serviceMap.has(service.service_id))
      .map((service) => ({
        service_id: service.service_id,
        priority: service.priority,
        service_name: serviceMap.get(service.service_id).name,
        prefix: serviceMap.get(service.service_id).prefix
      }));

    if (assignments.length === 0) {
      return res.status(400).json({ error: 'At least one valid service assignment is required' });
    }

    let temporaryPassword = data.password;
    if (!temporaryPassword) {
      temporaryPassword = generateTemporaryPassword();
    }

    const passwordHash = await bcrypt.hash(temporaryPassword, 10);

    const result = await dbRun(
      db,
      `INSERT INTO agents (username, name, email, role, is_active, password_hash)
       VALUES (?, ?, ?, ?, ?, ?)` ,
      [
        data.username,
        data.name,
        data.email || null,
        data.role,
        data.is_active,
        passwordHash
      ]
    );

    await replaceAgentServices(db, result.lastID, assignments);

    const agent = await getAgentById(db, result.lastID);
    res.status(201).json({ agent, temporaryPassword });
  } catch (error) {
    logger.error({ err: error }, 'Failed to create agent');
    res.status(500).json({ error: 'Failed to create agent' });
  }
});

router.put('/agents/:agentId', verifyAdminAuth, async (req, res) => {
  const db = getDb();
  const agentId = parseInt(req.params.agentId, 10);

  if (Number.isNaN(agentId)) {
    return res.status(400).json({ error: 'Invalid agent ID' });
  }

  try {
    const existing = await dbGet(db, 'SELECT * FROM agents WHERE id = ?', [agentId]);
    if (!existing) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const { errors, data } = validateAgentPayload(req.body || {});
    if (errors.length) {
      return res.status(400).json({ error: errors.join(', ') });
    }

    const duplicate = await dbGet(
      db,
      'SELECT id FROM agents WHERE LOWER(username) = ? AND id != ?',
      [data.username, agentId]
    );

    if (duplicate) {
      return res.status(409).json({ error: 'Username already exists' });
    }

    const services = await dbAll(db, 'SELECT id, name, prefix FROM services');
    const serviceMap = new Map(services.map((svc) => [svc.id, svc]));

    const assignments = data.services
      .filter((service) => serviceMap.has(service.service_id))
      .map((service) => ({
        service_id: service.service_id,
        priority: service.priority,
        service_name: serviceMap.get(service.service_id).name,
        prefix: serviceMap.get(service.service_id).prefix
      }));

    if (assignments.length === 0) {
      return res.status(400).json({ error: 'At least one valid service assignment is required' });
    }

    let temporaryPassword = null;
    if (data.password) {
      temporaryPassword = data.password;
    }

    if (temporaryPassword) {
      const passwordHash = await bcrypt.hash(temporaryPassword, 10);
      await dbRun(
        db,
        `UPDATE agents
         SET name = ?,
             username = ?,
             email = ?,
             role = ?,
             is_active = ?,
             password_hash = ?
         WHERE id = ?`,
        [
          data.name,
          data.username,
          data.email || null,
          data.role,
          data.is_active,
          passwordHash,
          agentId
        ]
      );
    } else {
      await dbRun(
        db,
        `UPDATE agents
         SET name = ?,
             username = ?,
             email = ?,
             role = ?,
             is_active = ?
         WHERE id = ?`,
        [
          data.name,
          data.username,
          data.email || null,
          data.role,
          data.is_active,
          agentId
        ]
      );
    }

    await replaceAgentServices(db, agentId, assignments);

    const agent = await getAgentById(db, agentId);
    const payload = { agent };
    if (temporaryPassword) {
      payload.temporaryPassword = temporaryPassword;
    }
    res.json(payload);
  } catch (error) {
    logger.error({ err: error }, 'Failed to update agent');
    res.status(500).json({ error: 'Failed to update agent' });
  }
});

router.delete('/agents/:agentId', verifyAdminAuth, async (req, res) => {
  const db = getDb();
  const agentId = parseInt(req.params.agentId, 10);

  if (Number.isNaN(agentId)) {
    return res.status(400).json({ error: 'Invalid agent ID' });
  }

  try {
    const existing = await dbGet(db, 'SELECT * FROM agents WHERE id = ?', [agentId]);
    if (!existing) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const ticketCount = await dbGet(
      db,
      'SELECT COUNT(*) AS count FROM tickets WHERE agent_id = ?',
      [agentId]
    );

    if (ticketCount?.count > 0) {
      return res.status(400).json({ error: 'Cannot delete agent with existing tickets' });
    }

    await dbRun(db, 'UPDATE counters SET current_agent_id = NULL WHERE current_agent_id = ?', [agentId]);
    await dbRun(db, 'DELETE FROM agent_services WHERE agent_id = ?', [agentId]);
    await dbRun(db, 'DELETE FROM agents WHERE id = ?', [agentId]);

    res.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, 'Failed to delete agent');
    res.status(500).json({ error: 'Failed to delete agent' });
  }
});

router.post('/agents/:agentId/reset-password', verifyAdminAuth, async (req, res) => {
  const db = getDb();
  const agentId = parseInt(req.params.agentId, 10);

  if (Number.isNaN(agentId)) {
    return res.status(400).json({ error: 'Invalid agent ID' });
  }

  try {
    const existing = await dbGet(db, 'SELECT id FROM agents WHERE id = ?', [agentId]);
    if (!existing) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await bcrypt.hash(temporaryPassword, 10);

    await dbRun(
      db,
      'UPDATE agents SET password_hash = ? WHERE id = ?',
      [passwordHash, agentId]
    );

    res.json({ temporaryPassword });
  } catch (error) {
    logger.error({ err: error }, 'Failed to reset agent password');
    res.status(500).json({ error: 'Failed to reset agent password' });
  }
});

module.exports = router;
