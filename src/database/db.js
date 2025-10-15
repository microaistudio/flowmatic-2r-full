const { getDb } = require('./connection');

let settingsCache = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 30 * 1000;

async function fetchSettingsFromDb() {
    const db = getDb();

    return new Promise((resolve, reject) => {
        db.all('SELECT key, value FROM settings', (err, rows) => {
            if (err) {
                reject(err);
                return;
            }

            const map = rows.reduce((acc, row) => {
                acc[row.key] = row.value;
                return acc;
            }, {});

            resolve(map);
        });
    });
}

async function getSettings({ forceRefresh = false } = {}) {
    const now = Date.now();
    if (!forceRefresh && settingsCache && now - cacheTimestamp < CACHE_TTL_MS) {
        return settingsCache;
    }

    const settings = await fetchSettingsFromDb();
    settingsCache = settings;
    cacheTimestamp = now;
    return settings;
}

function invalidateSettingsCache() {
    settingsCache = null;
    cacheTimestamp = 0;
}

async function refreshSettingsCache() {
    const settings = await fetchSettingsFromDb();
    settingsCache = settings;
    cacheTimestamp = Date.now();
    return settings;
}

module.exports = {
    getSettings,
    invalidateSettingsCache,
    refreshSettingsCache
};
