const { EVENTS } = require('./eventTypes');

/**
 * Broadcast ticket created event to all relevant namespaces
 * @param {Object} io - Socket.IO instance
 * @param {Object} ticketData - The ticket information
 * @param {Object} queueData - Current queue statistics
 */
function broadcastTicketCreated(io, ticketData, queueData) {
    try {
        const eventData = {
            ticket: ticketData,
            queue: queueData,
            timestamp: new Date().toISOString()
        };

        // Broadcast to kiosk namespace - all-updates room for confirmation
        io.of('/kiosk').to('all-updates').emit(EVENTS.TICKET_CREATED, eventData);
        io.of('/kiosk').to(`service-${ticketData.serviceId}`).emit(EVENTS.TICKET_CREATED, eventData);

        // Broadcast to terminal namespace - both all-updates and service-specific rooms
        io.of('/terminal').to('all-updates').emit(EVENTS.TICKET_CREATED, eventData);
        io.of('/terminal').to(`service-${ticketData.serviceId}`).emit(EVENTS.TICKET_CREATED, eventData);

        // Broadcast to monitor namespace - both all-updates and service-specific rooms
        io.of('/monitor').to('all-updates').emit(EVENTS.QUEUE_UPDATED, {
            serviceId: ticketData.serviceId,
            queue: queueData,
            timestamp: new Date().toISOString()
        });
        io.of('/monitor').to(`service-${ticketData.serviceId}`).emit(EVENTS.QUEUE_UPDATED, {
            serviceId: ticketData.serviceId,
            queue: queueData,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('❌ Error broadcasting ticket-created:', error.message);
    }
}

/**
 * Broadcast ticket called event to all relevant namespaces
 * @param {Object} io - Socket.IO instance
 * @param {Object} ticketData - The ticket information
 * @param {Object} counterData - The counter information
 * @param {Object} agentData - The agent information
 */
function broadcastTicketCalled(io, ticketData, counterData, agentData) {
    try {
        const ticketCalledData = {
            ticket: ticketData,
            counter: counterData,
            agent: agentData,
            timestamp: new Date().toISOString()
        };

        // Broadcast to monitor namespace - all rooms
        io.of('/monitor').to('all-updates').emit(EVENTS.TICKET_CALLED, ticketCalledData);
        io.of('/monitor').to(`service-${ticketData.serviceId}`).emit(EVENTS.TICKET_CALLED, ticketCalledData);
        io.of('/monitor').to(`counter-${counterData.id}`).emit(EVENTS.TICKET_CALLED, ticketCalledData);

        // Broadcast to customer namespace - counter-specific room
        io.of('/customer').to(`counter-${counterData.id}`).emit(EVENTS.TICKET_CALLED, {
            ticket: ticketData,
            counter: counterData,
            timestamp: new Date().toISOString()
        });

        // Broadcast to terminal namespace - all rooms
        io.of('/terminal').to('all-updates').emit(EVENTS.TICKET_CALLED, ticketCalledData);
        io.of('/terminal').to(`service-${ticketData.serviceId}`).emit(EVENTS.TICKET_CALLED, ticketCalledData);
        io.of('/terminal').to(`counter-${counterData.id}`).emit(EVENTS.TICKET_CALLED, ticketCalledData);

        // Update counter status
        const counterUpdateData = {
            counter: counterData,
            status: 'serving',
            currentTicket: ticketData,
            timestamp: new Date().toISOString()
        };
        io.of('/monitor').to('all-updates').emit(EVENTS.COUNTER_UPDATED, counterUpdateData);
        io.of('/monitor').to(`counter-${counterData.id}`).emit(EVENTS.COUNTER_UPDATED, counterUpdateData);
    } catch (error) {
        console.error('❌ Error broadcasting ticket-called:', error.message);
    }
}

/**
 * Broadcast ticket completed event to all relevant namespaces
 * @param {Object} io - Socket.IO instance
 * @param {Object} ticketData - The ticket information
 * @param {Object} queueData - Updated queue statistics
 */
function broadcastTicketCompleted(io, ticketData, queueData) {
    try {
        const completedData = {
            ticket: ticketData,
            queue: queueData,
            timestamp: new Date().toISOString()
        };

        // Broadcast to terminal namespace - both all-updates and service-specific rooms
        io.of('/terminal').to('all-updates').emit(EVENTS.TICKET_COMPLETED, completedData);
        io.of('/terminal').to(`service-${ticketData.serviceId}`).emit(EVENTS.TICKET_COMPLETED, completedData);

        // Broadcast to monitor namespace - both all-updates and service-specific rooms
        io.of('/monitor').to('all-updates').emit(EVENTS.TICKET_COMPLETED, {
            ticket: ticketData,
            timestamp: new Date().toISOString()
        });
        io.of('/monitor').to(`service-${ticketData.serviceId}`).emit(EVENTS.TICKET_COMPLETED, {
            ticket: ticketData,
            timestamp: new Date().toISOString()
        });

        // Update queue on monitor
        const queueUpdateData = {
            serviceId: ticketData.serviceId,
            queue: queueData,
            timestamp: new Date().toISOString()
        };
        io.of('/monitor').to('all-updates').emit(EVENTS.QUEUE_UPDATED, queueUpdateData);
        io.of('/monitor').to(`service-${ticketData.serviceId}`).emit(EVENTS.QUEUE_UPDATED, queueUpdateData);

        // Update counter status (now available)
        if (ticketData.counterId) {
            const counterUpdateData = {
                counterId: ticketData.counterId,
                status: 'available',
                currentTicket: null,
                timestamp: new Date().toISOString()
            };
            io.of('/monitor').to('all-updates').emit(EVENTS.COUNTER_UPDATED, counterUpdateData);
            io.of('/monitor').to(`counter-${ticketData.counterId}`).emit(EVENTS.COUNTER_UPDATED, counterUpdateData);
        }
    } catch (error) {
        console.error('❌ Error broadcasting ticket-completed:', error.message);
    }
}

/**
 * Broadcast queue update to all relevant namespaces
 * @param {Object} io - Socket.IO instance
 * @param {Number} serviceId - The service ID
 * @param {Object} queueData - Current queue statistics
 */
function broadcastQueueUpdated(io, serviceId, queueData) {
    try {
        const queueUpdateData = {
            serviceId: serviceId,
            queue: queueData,
            timestamp: new Date().toISOString()
        };

        // Broadcast to monitor namespace - service-specific room only
        io.of('/monitor').to(`service-${serviceId}`).emit(EVENTS.QUEUE_UPDATED, queueUpdateData);

        // Broadcast to terminal namespace - service-specific room only
        io.of('/terminal').to(`service-${serviceId}`).emit(EVENTS.QUEUE_UPDATED, queueUpdateData);

        // Broadcast to kiosk namespace - service-specific room only
        io.of('/kiosk').to(`service-${serviceId}`).emit(EVENTS.QUEUE_UPDATED, queueUpdateData);
    } catch (error) {
        console.error('❌ Error broadcasting queue-updated:', error.message);
    }
}

// ========== NEW FUNCTIONS FOR ADVANCED FEATURES ==========

/**
 * Broadcast ticket parked event
 * @param {Object} io - Socket.IO instance
 * @param {Object} ticketData - The ticket information
 * @param {Number} counterId - The counter ID
 */
function broadcastTicketParked(io, ticketData, counterId) {
    try {
        const eventData = {
            ticket: ticketData,
            counterId: counterId,
            timestamp: new Date().toISOString()
        };

        // Broadcast to terminal namespace - service-specific room
        io.of('/terminal').to(`service-${ticketData.serviceId}`).emit(EVENTS.TICKET_PARKED, eventData);
        io.of('/terminal').to('all-updates').emit(EVENTS.TICKET_PARKED, eventData);

        // Update counter status (now available)
        if (counterId) {
            const counterUpdateData = {
                counterId: counterId,
                status: 'available',
                currentTicket: null,
                timestamp: new Date().toISOString()
            };
            io.of('/monitor').to('all-updates').emit(EVENTS.COUNTER_UPDATED, counterUpdateData);
            io.of('/monitor').to(`counter-${counterId}`).emit(EVENTS.COUNTER_UPDATED, counterUpdateData);
        }
    } catch (error) {
        console.error('❌ Error broadcasting ticket-parked:', error.message);
    }
}

/**
 * Broadcast ticket recycled event
 * @param {Object} io - Socket.IO instance
 * @param {Object} ticketData - The ticket information
 * @param {Number} position - Position in queue where ticket was placed
 */
function broadcastTicketRecycled(io, ticketData, position) {
    try {
        const eventData = {
            ticket: ticketData,
            position: position,
            timestamp: new Date().toISOString()
        };

        // Broadcast to terminal namespace
        io.of('/terminal').to(`service-${ticketData.serviceId}`).emit(EVENTS.TICKET_RECYCLED, eventData);
        io.of('/terminal').to('all-updates').emit(EVENTS.TICKET_RECYCLED, eventData);

        // Broadcast to monitor namespace
        io.of('/monitor').to(`service-${ticketData.serviceId}`).emit(EVENTS.TICKET_RECYCLED, eventData);
        io.of('/monitor').to('all-updates').emit(EVENTS.TICKET_RECYCLED, eventData);
    } catch (error) {
        console.error('❌ Error broadcasting ticket-recycled:', error.message);
    }
}

/**
 * Broadcast ticket transferred event (SOLO: service-to-service only)
 * @param {Object} io - Socket.IO instance
 * @param {Object} ticketData - The ticket information
 * @param {Number} fromServiceId - Original service ID
 * @param {Number} toServiceId - Target service ID
 * @param {String} toServiceName - Target service name
 */
function broadcastTicketTransferred(io, ticketData, fromServiceId, toServiceId, toServiceName) {
    try {
        const eventData = {
            ticket: {
                id: ticketData.id,
                number: ticketData.ticket_number,
                fromServiceId: fromServiceId,
                toServiceId: toServiceId,
                toServiceName: toServiceName
            },
            timestamp: new Date().toISOString()
        };

        // Broadcast to both service rooms in terminal
        io.of('/terminal').to(`service-${fromServiceId}`).emit(EVENTS.TICKET_TRANSFERRED, eventData);
        io.of('/terminal').to(`service-${toServiceId}`).emit(EVENTS.TICKET_TRANSFERRED, eventData);
        io.of('/terminal').to('all-updates').emit(EVENTS.TICKET_TRANSFERRED, eventData);

        // Broadcast to monitor
        io.of('/monitor').to(`service-${fromServiceId}`).emit(EVENTS.TICKET_TRANSFERRED, eventData);
        io.of('/monitor').to(`service-${toServiceId}`).emit(EVENTS.TICKET_TRANSFERRED, eventData);
        io.of('/monitor').to('all-updates').emit(EVENTS.TICKET_TRANSFERRED, eventData);
    } catch (error) {
        console.error('❌ Error broadcasting ticket-transferred:', error.message);
    }
}

/**
 * Broadcast system alert to specified namespaces
 * @param {Object} io - Socket.IO instance
 * @param {String} message - Alert message
 * @param {String} type - Alert type (info, warning, error, success)
 * @param {Array} targetNamespaces - Array of namespaces to broadcast to (empty = all)
 */
function broadcastSystemAlert(io, message, type = 'info', targetNamespaces = []) {
    try {
        const eventData = {
            message: message,
            type: type,
            timestamp: new Date().toISOString()
        };

        // If no specific namespaces, broadcast to all
        const namespaces = targetNamespaces.length > 0 ? targetNamespaces : ['kiosk', 'terminal', 'monitor', 'customer'];
        
        namespaces.forEach(namespace => {
            io.of(`/${namespace}`).emit(EVENTS.SYSTEM_ALERT, eventData);
        });

        console.log(`📢 System alert broadcasted: ${message} (${type})`);
    } catch (error) {
        console.error('❌ Error broadcasting system-alert:', error.message);
    }
}

/**
 * Broadcast counter status update
 * @param {Object} io - Socket.IO instance
 * @param {Object} counterData - The counter information
 */
function broadcastCounterUpdated(io, counterData) {
    try {
        const eventData = {
            counter: counterData,
            timestamp: new Date().toISOString()
        };

        // Broadcast to monitor namespace
        io.of('/monitor').to('all-updates').emit(EVENTS.COUNTER_UPDATED, eventData);
        io.of('/monitor').to(`counter-${counterData.id}`).emit(EVENTS.COUNTER_UPDATED, eventData);

        // Broadcast to customer display for specific counter
        io.of('/customer').to(`counter-${counterData.id}`).emit(EVENTS.COUNTER_UPDATED, eventData);

        // Broadcast to terminal namespace
        io.of('/terminal').to('all-updates').emit(EVENTS.COUNTER_UPDATED, eventData);
        io.of('/terminal').to(`counter-${counterData.id}`).emit(EVENTS.COUNTER_UPDATED, eventData);
    } catch (error) {
        console.error('❌ Error broadcasting counter-updated:', error.message);
    }
}

/**
 * Broadcast voice announcement (for multi-language support)
 * @param {Object} io - Socket.IO instance
 * @param {Object} ticketData - The ticket information
 * @param {Object} counterData - The counter information
 * @param {String} language - Language code (en, th, hi)
 */
function broadcastVoiceAnnouncement(io, ticketData, counterData, language = 'en') {
    try {
        const announcements = {
            en: `Ticket ${ticketData.ticket_number}, please proceed to counter ${counterData.number}`,
            th: `หมายเลข ${ticketData.ticket_number} กรุณาไปที่เคาน์เตอร์ ${counterData.number}`,
            hi: `टिकट ${ticketData.ticket_number}, कृपया काउंटर ${counterData.number} पर जाएं`
        };

        const eventData = {
            ticket: ticketData,
            counter: counterData,
            text: announcements[language] || announcements.en,
            language: language,
            timestamp: new Date().toISOString()
        };

        // Broadcast to monitor namespace (displays with speakers)
        io.of('/monitor').emit('voice-announcement', eventData);
    } catch (error) {
        console.error('❌ Error broadcasting voice-announcement:', error.message);
    }
}

module.exports = {
    // Original core functions (ESSENTIAL - don't remove these!)
    broadcastTicketCreated,
    broadcastTicketCalled,
    broadcastTicketCompleted,
    broadcastQueueUpdated,
    
    // New advanced functions for Phase 3+ features
    broadcastTicketParked,
    broadcastTicketRecycled,
    broadcastTicketTransferred,
    broadcastSystemAlert,
    broadcastCounterUpdated,
    broadcastVoiceAnnouncement
};