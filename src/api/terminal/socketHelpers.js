// src/api/terminal/socketHelpers.js
// Helper functions to integrate Socket.IO broadcasts with terminal API operations

const { getIO } = require('../../realtime/socketManager');
const broadcaster = require('../../realtime/eventBroadcaster');
const db = require('../../database/db');

/**
 * Emit ticket called event when agent calls next ticket
 */
async function emitTicketCalled(ticket, counter, agent) {
    try {
        const io = getIO();
        
        // Get full ticket data with service info
        const ticketData = {
            id: ticket.id,
            ticket_number: ticket.ticket_number,
            serviceId: ticket.service_id,
            service_name: ticket.service_name || 'General Service',
            priority: ticket.priority,
            customer_name: ticket.customer_name,
            customer_phone: ticket.customer_phone
        };

        const counterData = {
            id: counter.id,
            name: counter.name,
            number: counter.number,
            location: counter.location
        };

        const agentData = {
            id: agent.id,
            name: agent.name,
            username: agent.username
        };

        // Broadcast the event
        broadcaster.broadcastTicketCalled(io, ticketData, counterData, agentData);
        
        // Also broadcast voice announcement if enabled
        const settings = await db.getSettings();
        if (settings['feature.voice_announcements'] === 'true') {
            const language = settings['config.default_language'] || 'en';
            broadcaster.broadcastVoiceAnnouncement(io, ticketData, counterData, language);
        }
    } catch (error) {
        console.error('❌ Error emitting ticket-called:', error.message);
    }
}

/**
 * Emit ticket completed event
 */
async function emitTicketCompleted(ticket, queueStats) {
    try {
        const io = getIO();
        
        const ticketData = {
            id: ticket.id,
            ticket_number: ticket.ticket_number,
            serviceId: ticket.service_id,
            counterId: ticket.counter_id,
            service_duration: ticket.service_duration
        };

        broadcaster.broadcastTicketCompleted(io, ticketData, queueStats);
    } catch (error) {
        console.error('❌ Error emitting ticket-completed:', error.message);
    }
}

/**
 * Emit ticket parked event
 */
async function emitTicketParked(ticket, counterId) {
    try {
        const io = getIO();
        
        const ticketData = {
            id: ticket.id,
            ticket_number: ticket.ticket_number,
            serviceId: ticket.service_id
        };

        broadcaster.broadcastTicketParked(io, ticketData, counterId);
    } catch (error) {
        console.error('❌ Error emitting ticket-parked:', error.message);
    }
}

/**
 * Emit ticket transferred event
 */
async function emitTicketTransferred(ticket, fromServiceId, toService) {
    try {
        const io = getIO();
        
        const ticketData = {
            id: ticket.id,
            ticket_number: ticket.ticket_number
        };

        broadcaster.broadcastTicketTransferred(
            io, 
            ticketData, 
            fromServiceId, 
            toService.id, 
            toService.name
        );
    } catch (error) {
        console.error('❌ Error emitting ticket-transferred:', error.message);
    }
}

/**
 * Emit queue update after any operation that changes queue
 */
async function emitQueueUpdate(serviceId) {
    try {
        const io = getIO();
        
        // Get current queue stats
        const queueStats = await db.getQueueStats(serviceId);
        
        broadcaster.broadcastQueueUpdated(io, serviceId, queueStats);
    } catch (error) {
        console.error('❌ Error emitting queue-update:', error.message);
    }
}

/**
 * Emit counter status update
 */
async function emitCounterUpdate(counter) {
    try {
        const io = getIO();
        
        broadcaster.broadcastCounterUpdated(io, counter);
    } catch (error) {
        console.error('❌ Error emitting counter-update:', error.message);
    }
}

/**
 * Emit system alert
 */
async function emitSystemAlert(message, type = 'info', targetNamespaces = []) {
    try {
        const io = getIO();
        
        broadcaster.broadcastSystemAlert(io, message, type, targetNamespaces);
    } catch (error) {
        console.error('❌ Error emitting system-alert:', error.message);
    }
}

module.exports = {
    emitTicketCalled,
    emitTicketCompleted,
    emitTicketParked,
    emitTicketTransferred,
    emitQueueUpdate,
    emitCounterUpdate,
    emitSystemAlert
};