const { getDb } = require('./connection');

function createClient(db) {
    return {
        run(sql, params = []) {
            return new Promise((resolve, reject) => {
                db.run(sql, params, function handleRun(err) {
                    if (err) {
                        reject(err);
                        return;
                    }
                    resolve({ lastID: this.lastID, changes: this.changes });
                });
            });
        },
        get(sql, params = []) {
            return new Promise((resolve, reject) => {
                db.get(sql, params, (err, row) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    resolve(row);
                });
            });
        },
        all(sql, params = []) {
            return new Promise((resolve, reject) => {
                db.all(sql, params, (err, rows) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    resolve(rows);
                });
            });
        },
        exec(sql) {
            return new Promise((resolve, reject) => {
                db.exec(sql, (err) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    resolve();
                });
            });
        }
    };
}

function getClient() {
    return createClient(getDb());
}

async function run(sql, params = []) {
    const client = getClient();
    return client.run(sql, params);
}

async function get(sql, params = []) {
    const client = getClient();
    return client.get(sql, params);
}

async function all(sql, params = []) {
    const client = getClient();
    return client.all(sql, params);
}

async function withTransaction(work, options = {}) {
    const db = getDb();
    const client = createClient(db);
    const mode = options.mode ? options.mode.toUpperCase() : null;
    const beginStatement = mode ? `BEGIN ${mode} TRANSACTION` : 'BEGIN TRANSACTION';

    await client.exec(beginStatement);

    try {
        const result = await work(client);
        await client.exec('COMMIT');
        return result;
    } catch (error) {
        try {
            await client.exec('ROLLBACK');
        } catch (rollbackError) {
            console.error('❌ Transaction rollback failed:', rollbackError.message);
        }
        throw error;
    }
}

module.exports = {
    run,
    get,
    all,
    withTransaction,
    getClient: () => createClient(getDb())
};
