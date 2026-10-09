// Who and what a database write belongs to, so the change log can say "admin, PATCH /events/12"
// without every route passing it down. Set per request in index.js; requireAuth adds the user.
const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

function requestContext(req, res, next) {
    storage.run({ source: `${req.method} ${req.originalUrl.split('?')[0]}`.slice(0, 160) }, next);
}

function setUser(user) {
    const store = storage.getStore();
    if (store) store.user = user;
}

// Writes outside any request (startup, the admin seed) have no context.
const current = () => storage.getStore() ?? {};

module.exports = { requestContext, setUser, current };
