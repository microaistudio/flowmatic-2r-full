const sqlite3 = require('sqlite3').verbose();
const path = require('path');

console.log('Updating database...');

const db = new sqlite3.Database('data/flowmatic.db');

db.run(`INSERT OR IGNORE INTO settings (key, value, description, category) VALUES 
('feature.production_mode', 'false', 'Enable production mode', 'features')`, 
function(err) {
    if (err) {
        console.error('Error:', err);
    } else {
        console.log('Setting added successfully!');
    }
    db.close();
});