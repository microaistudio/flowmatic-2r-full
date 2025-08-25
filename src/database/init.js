const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '../../data/flowmatic.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

async function initDatabase() {
    try {
        const dbDir = path.dirname(DB_PATH);
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
            console.log('Created data directory');
        }

        const dbExists = fs.existsSync(DB_PATH);
        
        if (dbExists) {
            console.log('Database already exists, skipping initialization');
            return;
        }

        console.log('Creating new database...');
        
        const db = new sqlite3.Database(DB_PATH, (err) => {
            if (err) {
                throw new Error(`Failed to create database: ${err.message}`);
            }
        });

        await new Promise((resolve, reject) => {
            db.run('PRAGMA foreign_keys = ON', (err) => {
                if (err) reject(err);
                else {
                    console.log('Foreign keys enabled');
                    resolve();
                }
            });
        });

        const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
        
        await new Promise((resolve, reject) => {
            db.serialize(() => {
                db.run('BEGIN TRANSACTION');
                
                db.exec(schema, (err) => {
                    if (err) {
                        db.run('ROLLBACK');
                        reject(new Error(`Failed to execute schema: ${err.message}`));
                        return;
                    }
                    
                    db.run('COMMIT', (commitErr) => {
                        if (commitErr) {
                            reject(new Error(`Failed to commit: ${commitErr.message}`));
                        } else {
                            console.log('Schema executed successfully');
                            resolve();
                        }
                    });
                });
            });
        });

        await new Promise((resolve, reject) => {
            db.close((err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        console.log('Database initialization completed successfully');

    } catch (error) {
        console.error('Database initialization failed:', error.message);
        process.exit(1);
    }
}

if (require.main === module) {
    initDatabase();
}

module.exports = { initDatabase };