const { HttpError } = require('./errors');

// Per-IP limit on a route, counted in memory (resets on restart like the login guard).
function rateLimit(max, windowMs, message) {
    const hits = new Map();
    return (req, res, next) => {
        const now = Date.now();
        for (const [ip, h] of hits) if (now - h.first > windowMs) hits.delete(ip);
        const h = hits.get(req.ip) || { count: 0, first: now };
        if (h.count >= max) throw new HttpError(429, message);
        h.count += 1;
        hits.set(req.ip, h);
        next();
    };
}

module.exports = { rateLimit };
