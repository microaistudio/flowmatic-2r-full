# FlowMatic-SOLO R2 Routes Refactoring Task

## TASK DESCRIPTION
Split the monolithic `routes.js` file (1577 lines) into 5 organized route files and update `app.js` imports. This is a PURE ORGANIZATION task - NO logic changes, NO URL changes, NO functionality changes.

## CRITICAL CONSTRAINTS
- ❌ NEVER modify any route logic or functionality
- ❌ NEVER change any URL endpoints or HTTP methods
- ❌ NEVER alter request/response formats
- ❌ NEVER modify database calls or queries
- ❌ NEVER change variable names or function signatures
- ❌ NEVER add new functionality or features
- ✅ ONLY move existing code to organized files
- ✅ ONLY update route path prefixes (remove redundant parts)

## INPUT FILES
- `src/routes.js` (current monolithic file - 1577 lines)
- `src/app.js` (needs import updates)

## OUTPUT STRUCTURE
Create these 5 new files in `src/routes/` directory:

```
src/routes/
├── health.js       # Health check endpoint
├── kiosk.js        # Customer kiosk endpoints (/api/kiosk/*)
├── terminal.js     # Agent terminal endpoints (/api/terminal/*)
├── monitor.js      # Display/monitor endpoints (/api/monitor/*)
└── admin.js        # Admin panel endpoints (/api/admin/*)
```

## ROUTE DISTRIBUTION MAP

### routes/health.js
```javascript
// MOVE: router.get('/health', ...)
// RESULT: router.get('/', ...) // Note: path becomes '/' since app.js adds '/api/health'
```

### routes/kiosk.js
```javascript
// MOVE: router.get('/kiosk/services', ...)
// MOVE: router.post('/kiosk/tickets', ...)
// RESULT: router.get('/services', ...) // Remove '/kiosk' prefix
// RESULT: router.post('/tickets', ...)
```

### routes/terminal.js
```javascript
// MOVE: router.post('/terminal/call-next', ...)
// MOVE: router.post('/terminal/complete', ...)
// MOVE: router.get('/terminal/queue/:serviceId', ...)
// MOVE: router.get('/terminal/session', ...)
// MOVE: router.post('/terminal/login', ...)
// MOVE: router.post('/terminal/logout', ...)
// MOVE: router.post('/terminal/recall', ...)
// MOVE: router.post('/terminal/no-show', ...)
// MOVE: router.post('/terminal/transfer', ...)
// RESULT: Remove '/terminal' prefix from all paths
```

### routes/monitor.js
```javascript
// MOVE: router.get('/monitor/counters', ...)
// MOVE: router.get('/monitor/now-serving', ...)
// MOVE: router.get('/monitor/queue/:serviceId', ...)
// RESULT: Remove '/monitor' prefix from all paths
```

### routes/admin.js
```javascript
// MOVE: router.get('/admin/settings', ...)
// MOVE: router.put('/admin/settings', ...)
// RESULT: Remove '/admin' prefix from all paths
```

## EXACT FILE TEMPLATES

### src/routes/health.js
```javascript
const express = require('express');
const router = express.Router();
const { getDb } = require('../database/connection');

// MOVE health check route here
// Change router.get('/health', ...) to router.get('/', ...)

module.exports = router;
```

### src/routes/kiosk.js
```javascript
const express = require('express');
const router = express.Router();
const { getDb } = require('../database/connection');
const { logEvent, EventTypes } = require('../database/events');
const { broadcastTicketCreated } = require('../realtime/eventBroadcaster');

// MOVE all kiosk routes here
// Remove '/kiosk' prefix from route paths

module.exports = router;
```

### src/routes/terminal.js
```javascript
const express = require('express');
const router = express.Router();
const { getDb } = require('../database/connection');
const { logEvent, EventTypes } = require('../database/events');
const { broadcastTicketCalled, broadcastTicketCompleted, broadcastQueueUpdated } = require('../realtime/eventBroadcaster');

// MOVE all terminal routes here
// Remove '/terminal' prefix from route paths

module.exports = router;
```

### src/routes/monitor.js
```javascript
const express = require('express');
const router = express.Router();
const { getDb } = require('../database/connection');

// MOVE all monitor routes here
// Remove '/monitor' prefix from route paths

module.exports = router;
```

### src/routes/admin.js
```javascript
const express = require('express');
const router = express.Router();
const { getDb } = require('../database/connection');

// MOVE all admin routes here
// Remove '/admin' prefix from route paths

module.exports = router;
```

## UPDATE app.js
Replace the single route import:
```javascript
// REMOVE this line:
app.use('/api', routes);

// ADD these lines:
app.use('/api/health', require('./routes/health'));
app.use('/api/kiosk', require('./routes/kiosk'));
app.use('/api/terminal', require('./routes/terminal'));
app.use('/api/monitor', require('./routes/monitor'));
app.use('/api/admin', require('./routes/admin'));
```

## VALIDATION CHECKLIST
After refactoring, these URLs must work EXACTLY the same:

### Health
- GET /api/health

### Kiosk  
- GET /api/kiosk/services
- POST /api/kiosk/tickets

### Terminal
- POST /api/terminal/call-next
- POST /api/terminal/complete
- GET /api/terminal/queue/:serviceId
- GET /api/terminal/session
- POST /api/terminal/login
- POST /api/terminal/logout
- POST /api/terminal/recall
- POST /api/terminal/no-show
- POST /api/terminal/transfer

### Monitor
- GET /api/monitor/counters
- GET /api/monitor/now-serving
- GET /api/monitor/queue/:serviceId

### Admin
- GET /api/admin/settings
- PUT /api/admin/settings

## CRITICAL SUCCESS CRITERIA
1. ✅ All existing API endpoints respond with identical behavior
2. ✅ All frontend interfaces (kiosk, terminal, monitor) work unchanged
3. ✅ No breaking changes to request/response formats
4. ✅ Database operations remain identical
5. ✅ Socket.IO broadcasting continues working
6. ✅ Error handling remains the same

## FINAL FILE STRUCTURE
```
src/
├── app.js                 # Updated imports
├── server.js             # Unchanged
├── routes/               # New directory
│   ├── health.js         # ~50 lines
│   ├── kiosk.js          # ~300 lines
│   ├── terminal.js       # ~800 lines
│   ├── monitor.js        # ~200 lines
│   └── admin.js          # ~100 lines
└── [other files unchanged]
```

## EXECUTION STEPS
1. Create `src/routes/` directory
2. Create 5 route files with proper imports
3. Move route definitions to appropriate files
4. Update route paths (remove redundant prefixes)
5. Update `app.js` imports
6. Verify all imports and dependencies are correct
7. Ensure no syntax errors in any file

## TESTING COMMAND
After refactoring, test with:
```bash
# Restart server
pm2 restart flowmatic-staging

# Test key endpoints
curl http://34.101.92.179:5050/api/health
curl http://34.101.92.179:5050/api/kiosk/services
curl -X POST http://34.101.92.179:5050/api/terminal/login -H "Content-Type: application/json" -d '{"username":"test","password":"test","counterId":1}'
```

All endpoints must return the same responses as before refactoring.

## DELIVERABLES
- 5 new route files in `src/routes/` directory
- Updated `src/app.js` with new imports
- All existing functionality preserved
- Zero breaking changes