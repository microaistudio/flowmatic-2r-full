const { getDb } = require('./connection');

const EventTypes = {
  TICKET_CREATED: 'TICKET_CREATED',
  TICKET_CALLED: 'TICKET_CALLED',
  TICKET_COMPLETED: 'TICKET_COMPLETED',
  TICKET_RECALLED: 'TICKET_RECALLED',
  TICKET_NO_SHOW: 'TICKET_NO_SHOW',
  TICKET_TRANSFERRED: 'TICKET_TRANSFERRED',
  QUEUE_UPDATED: 'QUEUE_UPDATED',
  COUNTER_STATE_CHANGED: 'COUNTER_STATE_CHANGED',
  AGENT_LOGIN: 'AGENT_LOGIN',
  AGENT_LOGOUT: 'AGENT_LOGOUT'
};

function logEvent(eventType, entityType, entityId, data = {}, agentId = null, counterId = null) {
  return new Promise((resolve, reject) => {
    const sql = `
      INSERT INTO events (event_type, entity_type, entity_id, data, agent_id, counter_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `;
    
    const params = [eventType, entityType, entityId, JSON.stringify(data), agentId, counterId];
    
    const db = getDb();
    db.run(sql, params, function(err) {
      if (err) {
        console.error('Event logging error:', err);
        reject(err);
      } else {
        resolve({ id: this.lastID, eventType, entityType, entityId });
      }
    });
  });
}

module.exports = { logEvent, EventTypes };