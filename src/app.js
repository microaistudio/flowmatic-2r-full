const express = require('express');
const path = require('path');
const pinoHttp = require('pino-http');
const logger = require('./utils/logger');

const app = express();

app.use(
    pinoHttp({
        logger,
        serializers: {
            err: (err) => ({
                type: err?.name,
                message: err?.message,
                stack: err?.stack
            })
        },
        customSuccessMessage(res) {
            const method = res?.req?.method || 'unknown-method';
            const url = res?.req?.url || 'unknown-url';
            return `${method} ${url} completed`;
        },
        customErrorMessage(error, res) {
            const method = res?.req?.method || 'unknown-method';
            const url = res?.req?.url || 'unknown-url';
            return `${method} ${url} errored: ${error.message}`;
        }
    })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from public directory
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

app.use('/api/health', require('./routes/health'));
app.use('/api/kiosk', require('./routes/kiosk'));
app.use('/api/terminal', require('./routes/terminal'));
app.use('/api/monitor', require('./routes/monitor'));
app.use('/api/counters', require('./routes/counters'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/ticket', require('./routes/ticket'));

// API status endpoint
app.get('/api/status', (req, res) => {
    res.json({ 
        name: 'FlowMatic-SOLO R2', 
        version: '2.4.0',
        state: 'running',
        timestamp: new Date().toISOString()
    });
});

app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
    logger.error({ err }, 'Unhandled application error');
    res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
