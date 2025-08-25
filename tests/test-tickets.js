const { setupTestEnvironment, cleanup } = require('./setup');
const { insertTestData } = require('./fixtures/testData');

// Test results tracking
let passCount = 0;
let failCount = 0;

function printResult(testName, passed, error = null) {
    if (passed) {
        console.log(`✓ PASS: ${testName}`);
        passCount++;
    } else {
        console.log(`✗ FAIL: ${testName}`);
        if (error) console.log(`  Error: ${error.message}`);
        failCount++;
    }
}

// Test: Create a new ticket
function testCreateTicket(db) {
    return new Promise((resolve) => {
        const testName = 'Create new ticket';
        
        // First get a service to use
        db.get('SELECT id, prefix, current_number FROM services WHERE id = 1', (err, service) => {
            if (err) {
                printResult(testName, false, err);
                return resolve();
            }
            
            const nextNumber = service.current_number + 1;
            const ticketNumber = `${service.prefix}${String(nextNumber).padStart(3, '0')}`;
            
            // Insert new ticket
            const sql = `INSERT INTO tickets (
                ticket_number, service_id, state, customer_name, 
                customer_phone, estimated_wait
            ) VALUES (?, ?, 'waiting', ?, ?, ?)`;
            
            db.run(sql, [ticketNumber, service.id, 'Test Customer', '1234567890', 300], function(err) {
                if (err) {
                    printResult(testName, false, err);
                } else {
                    printResult(testName, true);
                }
                resolve();
            });
        });
    });
}

// Test: Verify ticket was created
function testVerifyTicket(db) {
    return new Promise((resolve) => {
        const testName = 'Verify ticket exists';
        
        db.get('SELECT * FROM tickets WHERE customer_name = ?', ['Test Customer'], (err, ticket) => {
            if (err) {
                printResult(testName, false, err);
            } else if (!ticket) {
                printResult(testName, false, new Error('Ticket not found'));
            } else {
                printResult(testName, true);
            }
            resolve();
        });
    });
}

// Test: Check ticket state
function testTicketState(db) {
    return new Promise((resolve) => {
        const testName = 'Check ticket state is waiting';
        
        db.get('SELECT state FROM tickets WHERE customer_name = ?', ['Test Customer'], (err, ticket) => {
            if (err) {
                printResult(testName, false, err);
            } else if (!ticket) {
                printResult(testName, false, new Error('Ticket not found'));
            } else if (ticket.state !== 'waiting') {
                printResult(testName, false, new Error(`Expected state 'waiting', got '${ticket.state}'`));
            } else {
                printResult(testName, true);
            }
            resolve();
        });
    });
}

// Test: Count total tickets
function testCountTickets(db) {
    return new Promise((resolve) => {
        const testName = 'Count total tickets';
        
        db.get('SELECT COUNT(*) as count FROM tickets', (err, result) => {
            if (err) {
                printResult(testName, false, err);
            } else if (result.count !== 5) { // 4 from fixtures + 1 we created
                printResult(testName, false, new Error(`Expected 5 tickets, got ${result.count}`));
            } else {
                printResult(testName, true);
            }
            resolve();
        });
    });
}

// Test: Check ticket number format
function testTicketNumberFormat(db) {
    return new Promise((resolve) => {
        const testName = 'Check ticket number format';
        
        db.get('SELECT ticket_number FROM tickets WHERE customer_name = ?', ['Test Customer'], (err, ticket) => {
            if (err) {
                printResult(testName, false, err);
            } else if (!ticket) {
                printResult(testName, false, new Error('Ticket not found'));
            } else if (!/^[A-Z]\d{3}$/.test(ticket.ticket_number)) {
                printResult(testName, false, new Error(`Invalid ticket format: ${ticket.ticket_number}`));
            } else {
                printResult(testName, true);
            }
            resolve();
        });
    });
}

// Main test runner
async function runTests() {
    console.log('=== Running Ticket Tests ===\n');
    
    try {
        // Setup
        const db = await setupTestEnvironment();
        await insertTestData(db);
        
        // Run tests
        await testCreateTicket(db);
        await testVerifyTicket(db);
        await testTicketState(db);
        await testCountTickets(db);
        await testTicketNumberFormat(db);
        
        // Summary
        console.log('\n=== Test Summary ===');
        console.log(`Total tests: ${passCount + failCount}`);
        console.log(`Passed: ${passCount}`);
        console.log(`Failed: ${failCount}`);
        
        // Cleanup
        db.close(() => {
            cleanup().then(() => {
                process.exit(failCount > 0 ? 1 : 0);
            });
        });
        
    } catch (error) {
        console.error('Test setup failed:', error);
        process.exit(1);
    }
}

// Run the tests
runTests();