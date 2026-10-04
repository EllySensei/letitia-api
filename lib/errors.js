// Thrown from route handlers for any expected failure; the error handler turns it into JSON.
class HttpError extends Error {
    constructor(status, message, details) {
        super(message);
        this.status = status;
        this.details = details;
    }
}

// MariaDB error codes that are caused by the request rather than by the server.
const DB_ERRORS = {
    ER_DUP_ENTRY: [409, 'A record with that value already exists'],
    ER_ROW_IS_REFERENCED: [409, 'This record is still referenced by other records'],
    ER_ROW_IS_REFERENCED_2: [409, 'This record is still referenced by other records'],
    ER_NO_REFERENCED_ROW: [400, 'A referenced record does not exist'],
    ER_NO_REFERENCED_ROW_2: [400, 'A referenced record does not exist'],
    ER_DATA_TOO_LONG: [400, 'A value is too long for its field'],
    ER_WARN_DATA_OUT_OF_RANGE: [400, 'A numeric value is out of range'],
    ER_LOCK_DEADLOCK: [503, 'The database was busy, please retry'],
    ER_LOCK_WAIT_TIMEOUT: [503, 'The database was busy, please retry'],
    ER_GET_CONNECTION_TIMEOUT: [503, 'Database is unavailable'],
    ECONNREFUSED: [503, 'Database is unavailable'],
};

function notFound(req, res) {
    res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
    if (res.headersSent) return next(err);

    if (err instanceof HttpError) {
        const body = { error: err.message };
        if (err.details) body.details = err.details;
        return res.status(err.status).json(body);
    }

    // Raised by express.json() before any route runs.
    if (err.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'Request body is not valid JSON' });
    }
    if (err.type === 'entity.too.large') {
        return res.status(413).json({ error: 'Request body is too large' });
    }

    const mapped = DB_ERRORS[err.code];
    if (mapped) {
        if (mapped[0] >= 500) console.error(`[db] ${err.code}: ${err.message}`);
        return res.status(mapped[0]).json({ error: mapped[1] });
    }

    // Unknown failure: log the details, never send them to the client.
    console.error(`[error] ${req.method} ${req.originalUrl}`, err);
    res.status(500).json({ error: 'Internal server error' });
}

module.exports = { HttpError, notFound, errorHandler };
