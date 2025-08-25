const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'test.db');
const SCHEMA_PATH = path.join(__dirname, '..', 'src', 'database', 'init.sql');

// Create test database
function createTestDatabase() {
    return new Promise((resolve, reject) => {
        // Remove existing test database if it exists
        if (fs.existsSync(TEST_DB_PATH)) {
            fs.unlinkSync(TEST_DB_PATH);
        }
        
        const db = new sqlite3.Database(TEST_DB_PATH, (err) => {
            if (err) {
                reject(err);
            } else {
                console.log('Test database created successfully');
                resolve(db);
            }
        });
    });
}

// Run schema creation
function runSchema(db) {
    return new Promise((resolve, reject) => {
        const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
        
        // Split schema into individual statements
        const statements = schema
            .split(';')
            .map(s => s.trim())
            .filter(s => s.length > 0);
        
        db.serialize(() => {
            // Execute each statement
            let completed = 0;
            statements.forEach((statement, index) => {
                db.run(statement + ';', (err) => {
                    if (err) {
                        console.error(`Error executing statement ${index + 1}:`, err);
                        reject(err);
                    } else {
                        completed++;
                        if (completed === statements.length) {
                            console.log('Schema created successfully');
                            resolve();
                        }
                    }
                });
            });
        });
    });
}

// Cleanup function
function cleanup() {
    return new Promise((resolve) => {
        if (fs.existsSync(TEST_DB_PATH)) {
            fs.unlinkSync(TEST_DB_PATH);
            console.log('Test database cleaned up');
        }
        resolve();
    });
}

// Setup test environment
async function setupTestEnvironment() {
    try {
        const db = await createTestDatabase();
        await runSchema(db);
        return db;
    } catch (error) {
        console.error('Failed to setup test environment:', error);
        throw error;
    }
}

// Get test database connection
function getTestDb() {
    return new sqlite3.Database(TEST_DB_PATH);
}

module.exports = {
    createTestDatabase,
    runSchema,
    cleanup,
    setupTestEnvironment,
    getTestDb,
    TEST_DB_PATH
};