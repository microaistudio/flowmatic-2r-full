const express = require('express');
const router = express.Router();
const { getDb } = require('../database/connection');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

// Admin authentication configuration
const ADMIN_CONFIG = {
    JWT_SECRET: process.env.SESSION_SECRET || 'flowmatic-admin-secret',
    DEFAULT_PASSWORD: process.env.ADMIN_PASSWORD || 'admin123',
    SESSION_TIMEOUT: 8 * 60 * 60 * 1000 // 8 hours
};

// Password verification utility
const verifyPassword = async (inputPassword) => {
    // Simple comparison for now (upgrade to bcrypt in production)
    return inputPassword === ADMIN_CONFIG.DEFAULT_PASSWORD;
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

// POST /api/admin/login - Admin authentication
router.post('/login', async (req, res) => {
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
        if (typeof logEvent === 'function') {
            logEvent(
                'ADMIN_LOGIN',
                'admin',
                1,
                {
                    loginTime: new Date().toISOString(),
                    ip: req.ip || req.connection.remoteAddress
                }
            ).catch(err => console.error('Event logging failed:', err));
        }
        
        res.json({
            success: true,
            token: token,
            message: 'Admin login successful',
            expiresIn: '8 hours'
        });
        
    } catch (error) {
        console.error('Admin login error:', error);
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
router.get('/settings', (req, res) => {
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
router.put('/settings', (req, res) => {
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