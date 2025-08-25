/**
 * Socket.IO Event Types
 * Constants for all real-time events in the system
 */

// Outbound Events (Server -> Client)
const OUTBOUND_EVENTS = {
    TICKET_CREATED: 'ticket-created',
    TICKET_CALLED: 'ticket-called',
    TICKET_COMPLETED: 'ticket-completed',
    TICKET_PARKED: 'ticket-parked',
    TICKET_RECYCLED: 'ticket-recycled',
    TICKET_TRANSFERRED: 'ticket-transferred',
    QUEUE_UPDATED: 'queue-updated',
    COUNTER_UPDATED: 'counter-updated',
    SYSTEM_ALERT: 'system-alert'
};

// Inbound Events (Client -> Server)
const INBOUND_EVENTS = {
    JOIN_SERVICE: 'join-service',
    JOIN_COUNTER: 'join-counter',
    JOIN_ALL: 'join-all'
};

// Combined exports for convenience
const EVENTS = {
    ...OUTBOUND_EVENTS,
    ...INBOUND_EVENTS
};

module.exports = {
    OUTBOUND_EVENTS,
    INBOUND_EVENTS,
    EVENTS
};