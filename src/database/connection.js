const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DATABASE_PATH = process.env.DATABASE_PATH || './data/flowmatic.db';
const SCHEMA_PATH = path.join(__dirname, 'init.sql');

let db = null;

function initializeDatabase() {
    return new Promise((resolve, reject) => {
        const dbPath = path.resolve(DATABASE_PATH);
        const dbDir = path.dirname(dbPath);
        
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }
        
        const isNewDatabase = !fs.existsSync(dbPath);
        
        db = new sqlite3.Database(dbPath, (err) => {
            if (err) {
                reject(err);
                return;
            }
            
            console.log(`Connected to SQLite database at ${dbPath}`);
            
            db.run('PRAGMA foreign_keys = ON', (err) => {
                if (err) {
                    console.error('Failed to enable foreign keys:', err);
                }
            });
            
            if (isNewDatabase) {
                console.log('Initializing new database...');
                const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
                
                db.exec(schema, (err) => {
                    if (err) {
                        console.error('Failed to initialize database:', err);
                        reject(err);
                    } else {
                        console.log('Database initialized successfully');
                        resolve(db);
                    }
                });
            } else {
                resolve(db);
            }
        });
    });
}

function getDb() {
    if (!db) {
        throw new Error('Database not initialized. Call initializeDatabase() first.');
    }
    return db;
}

function closeDatabase() {
    return new Promise((resolve, reject) => {
        if (db) {
            db.close((err) => {
                if (err) {
                    reject(err);
                } else {
                    db = null;
                    resolve();
                }
            });
        } else {
            resolve();
        }
    });
}

module.exports = {
    initializeDatabase,
    getDb,
    closeDatabase
};