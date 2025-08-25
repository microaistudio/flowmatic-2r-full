// Sample test data for FlowMatic-SOLO tests

// Sample services (2-3)
const testServices = [
    {
        id: 1,
        name: 'General Service',
        prefix: 'A',
        description: 'General inquiries and services',
        range_start: 1,
        range_end: 199,
        current_number: 5,
        is_active: true,
        estimated_service_time: 300
    },
    {
        id: 2,
        name: 'Account Services',
        prefix: 'B',
        description: 'Account opening, modifications',
        range_start: 200,
        range_end: 399,
        current_number: 3,
        is_active: true,
        estimated_service_time: 600
    },
    {
        id: 3,
        name: 'VIP Services',
        prefix: 'C',
        description: 'Premium customer services',
        range_start: 1,
        range_end: 99,
        current_number: 1,
        is_active: true,
        estimated_service_time: 450
    }
];

// Sample agents (2)
const testAgents = [
    {
        id: 1,
        username: 'agent1',
        name: 'John Smith',
        email: 'john.smith@flowmatic.com',
        role: 'agent',
        is_active: true
    },
    {
        id: 2,
        username: 'agent2',
        name: 'Jane Doe',
        email: 'jane.doe@flowmatic.com',
        role: 'supervisor',
        is_active: true
    }
];

// Sample counters
const testCounters = [
    {
        id: 1,
        name: 'Counter 1',
        number: 1,
        location: 'Main Hall',
        is_active: true,
        state: 'available'
    },
    {
        id: 2,
        name: 'Counter 2',
        number: 2,
        location: 'Main Hall',
        is_active: true,
        state: 'serving',
        current_ticket_id: 2,
        current_agent_id: 1
    }
];

// Sample tickets (3-4)
const testTickets = [
    {
        id: 1,
        ticket_number: 'A001',
        service_id: 1,
        state: 'waiting',
        priority: 0,
        customer_name: 'Customer One',
        customer_phone: '1234567890',
        customer_email: 'customer1@example.com',
        estimated_wait: 600,
        recall_count: 0
    },
    {
        id: 2,
        ticket_number: 'A002',
        service_id: 1,
        state: 'serving',
        priority: 0,
        customer_name: 'Customer Two',
        customer_phone: '0987654321',
        counter_id: 2,
        agent_id: 1,
        estimated_wait: 900,
        actual_wait: 450,
        recall_count: 0
    },
    {
        id: 3,
        ticket_number: 'B001',
        service_id: 2,
        state: 'waiting',
        priority: 1,
        customer_name: 'Priority Customer',
        customer_email: 'priority@example.com',
        estimated_wait: 300,
        recall_count: 0
    },
    {
        id: 4,
        ticket_number: 'C001',
        service_id: 3,
        state: 'completed',
        priority: 2,
        customer_name: 'VIP Customer',
        customer_phone: '5555555555',
        customer_email: 'vip@example.com',
        counter_id: 1,
        agent_id: 2,
        estimated_wait: 0,
        actual_wait: 120,
        service_duration: 480,
        recall_count: 0,
        notes: 'VIP service completed successfully'
    }
];

// Sample agent-service assignments
const testAgentServices = [
    {
        agent_id: 1,
        service_id: 1,
        priority: 1
    },
    {
        agent_id: 1,
        service_id: 2,
        priority: 2
    },
    {
        agent_id: 2,
        service_id: 1,
        priority: 2
    },
    {
        agent_id: 2,
        service_id: 3,
        priority: 1
    }
];

// Function to insert test data
function insertTestData(db) {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            // Insert services
            const serviceStmt = db.prepare(
                'INSERT INTO services (name, prefix, description, range_start, range_end, current_number, is_active, estimated_service_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
            );
            testServices.forEach(service => {
                serviceStmt.run(
                    service.name,
                    service.prefix,
                    service.description,
                    service.range_start,
                    service.range_end,
                    service.current_number,
                    service.is_active,
                    service.estimated_service_time
                );
            });
            serviceStmt.finalize();

            // Insert agents
            const agentStmt = db.prepare(
                'INSERT INTO agents (username, name, email, role, is_active) VALUES (?, ?, ?, ?, ?)'
            );
            testAgents.forEach(agent => {
                agentStmt.run(
                    agent.username,
                    agent.name,
                    agent.email,
                    agent.role,
                    agent.is_active
                );
            });
            agentStmt.finalize();

            // Insert counters
            const counterStmt = db.prepare(
                'INSERT INTO counters (name, number, location, is_active, state, current_ticket_id, current_agent_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
            );
            testCounters.forEach(counter => {
                counterStmt.run(
                    counter.name,
                    counter.number,
                    counter.location,
                    counter.is_active,
                    counter.state,
                    counter.current_ticket_id || null,
                    counter.current_agent_id || null
                );
            });
            counterStmt.finalize();

            // Insert tickets
            const ticketStmt = db.prepare(
                'INSERT INTO tickets (ticket_number, service_id, state, priority, customer_name, customer_phone, customer_email, counter_id, agent_id, estimated_wait, actual_wait, service_duration, recall_count, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            );
            testTickets.forEach(ticket => {
                ticketStmt.run(
                    ticket.ticket_number,
                    ticket.service_id,
                    ticket.state,
                    ticket.priority,
                    ticket.customer_name || null,
                    ticket.customer_phone || null,
                    ticket.customer_email || null,
                    ticket.counter_id || null,
                    ticket.agent_id || null,
                    ticket.estimated_wait,
                    ticket.actual_wait || null,
                    ticket.service_duration || null,
                    ticket.recall_count,
                    ticket.notes || null
                );
            });
            ticketStmt.finalize();

            // Insert agent-service assignments
            const agentServiceStmt = db.prepare(
                'INSERT INTO agent_services (agent_id, service_id, priority) VALUES (?, ?, ?)'
            );
            testAgentServices.forEach(assignment => {
                agentServiceStmt.run(
                    assignment.agent_id,
                    assignment.service_id,
                    assignment.priority
                );
            });
            agentServiceStmt.finalize();

            db.run('PRAGMA foreign_keys = ON', (err) => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    });
}

module.exports = {
    testServices,
    testAgents,
    testCounters,
    testTickets,
    testAgentServices,
    insertTestData
};