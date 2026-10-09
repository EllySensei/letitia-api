const { HttpError } = require('./errors');
const { parsePhone } = require('./phone');

// Thrown by a rule; validate() collects these so the client sees every bad field at once.
class FieldError extends Error {}

const isEmpty = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

// Wraps a parser with the shared "missing value" handling: a missing value is rejected when
// `required`, replaced by `default` when given, and otherwise passed through
// (undefined = not sent, null = explicitly cleared).
function rule(parse) {
    return (opts = {}) => (value) => {
        if (isEmpty(value)) {
            if (opts.required) throw new FieldError('is required');
            if (opts.default !== undefined) return opts.default;
            return value === undefined ? undefined : null;
        }
        return parse(value, opts);
    };
}

const str = rule((v, { max = 255 }) => {
    if (typeof v !== 'string') throw new FieldError('must be a string');
    const s = v.trim();
    if (s.length > max) throw new FieldError(`must be at most ${max} characters`);
    return s;
});

const email = rule((v) => {
    if (typeof v !== 'string') throw new FieldError('must be a string');
    const s = v.trim();
    if (s.length > 150 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new FieldError('must be a valid email address');
    return s.toLowerCase();
});

// Letters (any language, so ñ and accents pass) plus spaces, hyphens, apostrophes and periods.
const personName = rule((v, { max = 100 }) => {
    if (typeof v !== 'string') throw new FieldError('must be a string');
    const s = v.trim().replace(/\s+/g, ' ');
    if (s.length > max) throw new FieldError(`must be at most ${max} characters`);
    if (!/^\p{L}[\p{L}\p{M} .'-]*$/u.test(s)) throw new FieldError('may only contain letters, spaces, hyphens, apostrophes and periods');
    return s;
});

// A number with its country code, e.g. '+639171234567' (a local 0917... is taken as PH).
// Returns the two stored parts, { phone_country_code, phone_number }; spread them into the row.
const phone = rule((v) => {
    if (typeof v !== 'string') throw new FieldError('must be a string');
    const { code, number, error } = parsePhone(v.trim());
    if (error) throw new FieldError(error);
    return { phone_country_code: code, phone_number: number };
});

// Stock codes such as RNT-0001; stored upper-case.
const code = rule((v) => {
    if (typeof v !== 'string') throw new FieldError('must be a string');
    const s = v.trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9-]{0,29}$/.test(s)) throw new FieldError('may only contain letters, digits and hyphens (up to 30)');
    return s;
});

// Query-string values arrive as strings, so numeric strings are accepted too.
const int = rule((v, { min = -2147483648, max = 2147483647 }) => {
    const n = typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isInteger(n)) throw new FieldError('must be a whole number');
    if (n < min) throw new FieldError(`must be at least ${min}`);
    if (n > max) throw new FieldError(`must be at most ${max}`);
    return n;
});

// Matches DECIMAL(10,2).
const money = rule((v, { min = 0, max = 99999999.99 }) => {
    const n = typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isFinite(n)) throw new FieldError('must be a number');
    if (Math.abs(Math.round(n * 100) - n * 100) > 1e-6) throw new FieldError('must have at most 2 decimal places');
    if (n < min) throw new FieldError(`must be at least ${min}`);
    if (n > max) throw new FieldError(`must be at most ${max}`);
    return Math.round(n * 100) / 100;
});

const date = rule((v) => {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new FieldError('must be a date (YYYY-MM-DD)');
    const d = new Date(`${v}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw new FieldError('is not a real calendar date');
    return v;
});

const time = rule((v) => {
    const m = typeof v === 'string' && /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(v);
    if (!m) throw new FieldError('must be a time (HH:MM or HH:MM:SS)');
    return `${m[1]}:${m[2]}:${m[3] || '00'}`;
});

const bool = rule((v) => {
    if (v === true || v === 'true' || v === 1 || v === '1') return true;
    if (v === false || v === 'false' || v === 0 || v === '0') return false;
    throw new FieldError('must be true or false');
});

const oneOf = (values, opts) => rule((v) => {
    if (!values.includes(v)) throw new FieldError(`must be one of: ${values.join(', ')}`);
    return v;
})(opts);

// Pictures arrive as data URLs (the frontend shrinks them to ~700px JPEGs first).
const IMAGE_DATA_URL = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const image = rule((v) => {
    if (typeof v !== 'string' || v.length > 1500000) throw new FieldError('must be a picture under about 1 MB');
    if (!IMAGE_DATA_URL.test(v)) throw new FieldError('must be a JPEG, PNG or WebP data URL');
    return v;
});

// An array of objects, each checked against `schema`.
const list = (schema, { required = false, min = 0, max = 200 } = {}) => (value, field, errors) => {
    if (value === undefined || value === null) {
        if (required) throw new FieldError('is required');
        return value === null ? [] : undefined;
    }
    if (!Array.isArray(value)) throw new FieldError('must be an array');
    if (value.length < min) throw new FieldError(`must contain at least ${min} entr${min === 1 ? 'y' : 'ies'}`);
    if (value.length > max) throw new FieldError(`must contain at most ${max} entries`);
    return value.map((item, i) => collect(item, schema, false, `${field}[${i}]`, errors));
};

// A nested object checked against `schema`.
const object = (schema, { required = false } = {}) => (value, field, errors) => {
    if (value === undefined || value === null) {
        if (required) throw new FieldError('is required');
        return undefined;
    }
    return collect(value, schema, false, field, errors);
};

function collect(input, schema, partial, prefix, errors) {
    const out = {};
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        errors.push({ field: prefix || 'body', message: `${prefix || 'body'} must be an object` });
        return out;
    }
    for (const [key, check] of Object.entries(schema)) {
        const value = input[key];
        if (partial && value === undefined) continue;
        const field = prefix ? `${prefix}.${key}` : key;
        try {
            const clean = check(value, field, errors);
            if (clean !== undefined) out[key] = clean;
        } catch (err) {
            if (!(err instanceof FieldError)) throw err;
            errors.push({ field, message: `${field} ${err.message}` });
        }
    }
    return out;
}

// Returns only the schema's fields, cleaned. With `partial` (PATCH), fields that weren't
// sent are skipped instead of being checked for `required`.
function validate(input, schema, { partial = false } = {}) {
    const errors = [];
    const out = collect(input ?? {}, schema, partial, '', errors);
    if (errors.length) throw new HttpError(400, 'Validation failed', errors);
    return out;
}

function parseId(value, name = 'id') {
    if (typeof value !== 'string' || !/^\d{1,10}$/.test(value) || Number(value) < 1 || Number(value) > 2147483647) {
        throw new HttpError(400, `Invalid ${name}: expected a positive whole number`);
    }
    return Number(value);
}

const paging = {
    limit: int({ min: 1, max: 500, default: 100 }),
    offset: int({ min: 0, default: 0 }),
};

// A person's name, stored in parts.
const nameFields = ({ required = true } = {}) => ({
    first_name: personName({ required }),
    middle_name: personName(),
    last_name: personName({ required }),
});

// A Philippine address in parts (a place is in a city or a municipality, never both).
// `prefix` is 'venue_' for event venues.
const addressFields = (prefix = '', { required = true } = {}) => ({
    [`${prefix}street`]: str({ required, max: 255 }),
    [`${prefix}barangay`]: str({ required, max: 100 }),
    [`${prefix}city_municipality`]: str({ required, max: 100 }),
    [`${prefix}province`]: str({ required, max: 100 }),
});

// ?archived=true lists archived (soft-deleted) records instead of active ones.
const archivedQuery = { archived: bool({ default: false }) };

// Escapes LIKE wildcards so a search for "50%" matches literally.
const likePattern = (q) => `%${q.replace(/[\\%_]/g, '\\$&')}%`;

// A bulk destructive action must be confirmed with ?confirm=true or {"confirm": true}.
function requireConfirm(req) {
    const confirm = req.query.confirm ?? req.body?.confirm;
    if (confirm !== true && confirm !== 'true') {
        throw new HttpError(400, 'This action needs confirmation: resend with ?confirm=true');
    }
}

module.exports = {
    validate, parseId, paging, likePattern, requireConfirm, nameFields, addressFields, archivedQuery,
    str, email, personName, phone, code, int, money, date, time, bool, oneOf, list, object, image,
};
