// tests/connection-test.js
// TEST SCRIPT PROVIDED BY USER - DO NOT MODIFY

const io = require('socket.io-client');

// Test configuration
const SERVER_URL = 'http://localhost:5050';
const TEST_SERVICE_ID = 1;
const TEST_COUNTER_ID = 101;

// Color codes for output
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    red: '\x1b[31m',
    cyan: '\x1b[36m'
};

// Helper to log with namespace color
function log(namespace, message, data = null) {
    const timestamp = new Date().toISOString().split('T')[1].slice(0, 12);
    const namespaceColors = {
        '/monitor': colors.blue,
        '/terminal': colors.green,
        '/kiosk': colors.yellow,
        '/customer': colors.cyan
    };
    
    const color = namespaceColors[namespace] || colors.reset;
    console.log(`[${timestamp}] ${color}${namespace}${colors.reset}: ${message}`);
    if (data) {
        console.log('  Data:', JSON.stringify(data, null, 2));
    }
}

// Create test clients
async function runConnectionTest() {
    console.log(`${colors.bright}Starting Connection Test...${colors.reset}\n`);

    // 1. Create monitor client that joins 'all-updates' room
    const monitorClient = io(`${SERVER_URL}/monitor`, {
        reconnection: false
    });

    // 2. Create terminal client that joins specific service room
    const terminalClient = io(`${SERVER_URL}/terminal`, {
        reconnection: false
    });

    // 3. Create customer client that joins specific counter room
    const customerClient = io(`${SERVER_URL}/customer`, {
        reconnection: false
    });

    // Setup event handlers
    monitorClient.on('connect', () => {
        log('/monitor', `Connected: ${monitorClient.id}`);
        monitorClient.emit('join-all'); // Join all-updates room
    });

    monitorClient.on('joined', (data) => {
        log('/monitor', `Joined room: ${data.room}`);
    });

    monitorClient.on('ticket-created', (data) => {
        log('/monitor', `${colors.bright}RECEIVED: ticket-created${colors.reset}`, data);
    });

    monitorClient.on('queue-updated', (data) => {
        log('/monitor', `${colors.bright}RECEIVED: queue-updated${colors.reset}`, data);
    });

    terminalClient.on('connect', () => {
        log('/terminal', `Connected: ${terminalClient.id}`);
        terminalClient.emit('join-service', { serviceId: TEST_SERVICE_ID });
    });

    terminalClient.on('joined', (data) => {
        log('/terminal', `Joined room: ${data.room}`);
    });

    terminalClient.on('ticket-created', (data) => {
        log('/terminal', `${colors.bright}RECEIVED: ticket-created${colors.reset}`, data);
    });

    terminalClient.on('queue-updated', (data) => {
        log('/terminal', `${colors.bright}RECEIVED: queue-updated${colors.reset}`, data);
    });

    customerClient.on('connect', () => {
        log('/customer', `Connected: ${customerClient.id}`);
        customerClient.emit('join-counter', { counterId: TEST_COUNTER_ID });
    });

    customerClient.on('joined', (data) => {
        log('/customer', `Joined room: ${data.room}`);
    });

    customerClient.on('ticket-called', (data) => {
        log('/customer', `${colors.bright}RECEIVED: ticket-called${colors.reset}`, data);
    });

    // Wait for all connections
    await new Promise(resolve => setTimeout(resolve, 1000));

    console.log(`\n${colors.bright}Testing Room-Based Broadcasting...${colors.reset}\n`);

    // Test 1: Create a ticket (should broadcast to monitor all-updates and service room)
    console.log(`${colors.yellow}TEST 1: Creating ticket for service ${TEST_SERVICE_ID}${colors.reset}`);
    
    const ticketResponse = await fetch(`${SERVER_URL}/api/kiosk/tickets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceId: TEST_SERVICE_ID })
    });

    if (ticketResponse.ok) {
        const ticket = await ticketResponse.json();
        console.log(`${colors.green}✓ Ticket created: ${ticket.number}${colors.reset}`);
    } else {
        console.log(`${colors.red}✗ Failed to create ticket${colors.reset}`);
    }

    // Wait for broadcasts
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Test 2: Create ticket for different service (terminal should NOT receive)
    console.log(`\n${colors.yellow}TEST 2: Creating ticket for service 2 (different service)${colors.reset}`);
    
    const otherServiceResponse = await fetch(`${SERVER_URL}/api/kiosk/tickets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceId: 2 })
    });

    if (otherServiceResponse.ok) {
        console.log(`${colors.green}✓ Ticket created for service 2${colors.reset}`);
        console.log(`${colors.cyan}→ Terminal (service 1) should NOT receive this${colors.reset}`);
    }

    // Wait and then cleanup
    await new Promise(resolve => setTimeout(resolve, 2000));

    console.log(`\n${colors.bright}Test Complete! Check the logs above to verify:${colors.reset}`);
    console.log('1. Monitor received all events (joined all-updates)');
    console.log('2. Terminal only received events for service 1');
    console.log('3. Events were properly routed to rooms');

    // Disconnect all clients
    monitorClient.disconnect();
    terminalClient.disconnect();
    customerClient.disconnect();

    process.exit(0);
}

// Run the test
runConnectionTest().catch(error => {
    console.error(`${colors.red}Test failed:${colors.reset}`, error);
    process.exit(1);
});