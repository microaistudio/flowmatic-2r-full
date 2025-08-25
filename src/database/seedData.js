const { getDb } = require('./connection');

const defaultServices = [
    { name: 'General Service', prefix: 'A', description: 'General inquiries and services', range_start: 1, range_end: 199 },
    { name: 'Account Services', prefix: 'B', description: 'Account opening, modifications', range_start: 200, range_end: 399 },
    { name: 'VIP Services', prefix: 'C', description: 'Premium customer services', range_start: 1, range_end: 99 },
    { name: 'Technical Support', prefix: 'D', description: 'Technical assistance and support', range_start: 1, range_end: 199 }
];

const defaultCounters = [
    { name: 'Counter 1', number: 1, location: 'Main Hall' },
    { name: 'Counter 2', number: 2, location: 'Main Hall' },
    { name: 'VIP Counter', number: 3, location: 'VIP Area' },
    { name: 'Technical Counter', number: 4, location: 'Technical Area' }
];

const defaultSettings = [
    { key: 'feature.park_unpark', value: 'false', description: 'Enable park/unpark functionality', category: 'features' },
    { key: 'feature.cherry_pick', value: 'false', description: 'Enable cherry pick (call any ticket)', category: 'features' },
    { key: 'feature.recycle', value: 'false', description: 'Enable ticket recycling', category: 'features' },
    { key: 'feature.multi_service', value: 'false', description: 'Enable multi-service priorities', category: 'features' },
    { key: 'feature.voice_announcements', value: 'true', description: 'Enable voice announcements', category: 'features' },
    { key: 'config.recycle_position', value: '3', description: 'Position to insert recycled tickets', category: 'config' },
    { key: 'config.max_recall_count', value: '3', description: 'Maximum recall attempts', category: 'config' },
    { key: 'config.auto_complete_timeout', value: '1800', description: 'Auto-complete serving tickets (seconds)', category: 'config' },
    { key: 'system.name', value: 'FlowMatic-SOLO', description: 'System name', category: 'branding' },
    { key: 'system.version', value: '2.0.0', description: 'System version', category: 'system' }
];

async function seedDatabase() {
    const db = getDb();
    
    return new Promise((resolve, reject) => {
        db.get('SELECT COUNT(*) as count FROM services', (err, row) => {
            if (err) {
                reject(err);
                return;
            }
            
            if (row.count > 0) {
                console.log('Database already contains data, skipping seed');
                resolve();
                return;
            }
            
            console.log('Seeding database with default data...');
            
            db.serialize(() => {
                db.run('BEGIN TRANSACTION');
                
                const serviceStmt = db.prepare('INSERT INTO services (name, prefix, description, range_start, range_end) VALUES (?, ?, ?, ?, ?)');
                defaultServices.forEach(service => {
                    serviceStmt.run(service.name, service.prefix, service.description, service.range_start, service.range_end);
                });
                serviceStmt.finalize();
                
                const counterStmt = db.prepare('INSERT INTO counters (name, number, location) VALUES (?, ?, ?)');
                defaultCounters.forEach(counter => {
                    counterStmt.run(counter.name, counter.number, counter.location);
                });
                counterStmt.finalize();
                
                const settingStmt = db.prepare('INSERT INTO settings (key, value, description, category) VALUES (?, ?, ?, ?)');
                defaultSettings.forEach(setting => {
                    settingStmt.run(setting.key, setting.value, setting.description, setting.category);
                });
                settingStmt.finalize();
                
                db.run('COMMIT', (err) => {
                    if (err) {
                        db.run('ROLLBACK');
                        reject(err);
                    } else {
                        console.log('Database seeded successfully');
                        resolve();
                    }
                });
            });
        });
    });
}

module.exports = {
    seedDatabase,
    defaultServices,
    defaultCounters,
    defaultSettings
};