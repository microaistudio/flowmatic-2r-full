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
        
        db = new sqlite3.Database(dbPath, async (err) => {
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
            
            try {
                if (isNewDatabase) {
                    console.log('Initializing new database...');
                    const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');

                    await execAsync(db, schema);
                    console.log('Database initialized successfully');
                }

                await runSchemaMigrations(db);
                resolve(db);
            } catch (migrationError) {
                console.error('Database migration failed:', migrationError);
                reject(migrationError);
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

function execAsync(database, sql) {
    return new Promise((resolve, reject) => {
        database.exec(sql, (err) => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
}

function ensureColumn(database, table, column, definition) {
    return new Promise((resolve, reject) => {
        database.all(`PRAGMA table_info(${table})`, (err, rows) => {
            if (err) {
                reject(err);
                return;
            }

            const exists = rows.some((row) => row.name === column);
            if (exists) {
                resolve();
                return;
            }

            database.run(
                `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`,
                (alterErr) => {
                    if (alterErr) {
                        reject(alterErr);
                        return;
                    }
                    resolve();
                }
            );
        });
    });
}

async function runSchemaMigrations(database) {
    try {
        await ensureColumn(database, 'tickets', 'original_service_id', 'INTEGER');
    } catch (err) {
        if (!/duplicate column name/i.test(err.message)) {
            throw err;
        }
    }

    try {
        await ensureColumn(database, 'tickets', 'transferred_at', 'DATETIME');
    } catch (err) {
        if (!/duplicate column name/i.test(err.message)) {
            throw err;
        }
    }
}
