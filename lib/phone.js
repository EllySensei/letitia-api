// Phone numbers are stored in two parts: the country calling code ('+63') and the national
// number without its trunk 0 ('9171234567'). Which codes exist and how many digits follow
// each comes from libphonenumber-js (Google's phone metadata). The frontend gets the same
// list from GET /api/public/phone-countries for its dropdown.
const {
    Metadata, getCountries, getCountryCallingCode, getExampleNumber, parsePhoneNumberFromString,
} = require('libphonenumber-js/core');
const metadata = require('libphonenumber-js/metadata.max.json');
const examples = require('libphonenumber-js/mobile/examples');

const DEFAULT_ISO = 'PH';
const regionName = new Intl.DisplayNames(['en'], { type: 'region' });

// Digit counts a landline or mobile number can have after the code (toll-free and premium
// numbers aside). Falls back to every number type when the metadata doesn't split them.
function dialLengths(iso) {
    const plan = new Metadata(metadata).selectNumberingPlan(iso).numberingPlan;
    const types = ['FIXED_LINE', 'MOBILE'].map((t) => plan.type(t)).filter(Boolean);
    return types.length ? types.flatMap((t) => t.possibleLengths()) : plan.possibleLengths();
}

// One entry per country, default first and the rest by name, e.g.
// { iso: 'PH', name: 'Philippines', code: '+63', main: true, min: 6, max: 10, example: '9051234567' }.
// Several countries can share a code (+1: US, Canada, Jamaica, ...); `main` marks the one a
// bare code stands for.
const COUNTRIES = getCountries(metadata)
    .map((iso) => {
        const lengths = dialLengths(iso);
        const code = getCountryCallingCode(iso, metadata);
        return {
            iso,
            name: regionName.of(iso),
            code: `+${code}`,
            main: metadata.country_calling_codes[code][0] === iso,
            min: Math.min(...lengths),
            max: Math.max(...lengths),
            example: getExampleNumber(iso, examples, metadata)?.nationalNumber ?? null,
        };
    })
    .sort((a, b) => (b.iso === DEFAULT_ISO) - (a.iso === DEFAULT_ISO) || a.name.localeCompare(b.name));

const DEFAULT_COUNTRY = COUNTRIES[0];
const byIso = new Map(COUNTRIES.map((c) => [c.iso, c]));
const byCode = new Map(COUNTRIES.filter((c) => c.main).map((c) => [c.code, c]));

const digitsLabel = ({ min, max }) => (min === max ? `${min}` : `${min} to ${max}`);

// Splits a number typed in any common way into { code, number }, or returns an error
// message. '+639171234567' and '00639171234567' carry their code; a local '09171234567'
// or a bare '9171234567' is taken as the default country's.
function parsePhone(value) {
    const s = value.replace(/[\s().-]/g, '').replace(/^00/, '+');
    if (!/^\+?\d+$/.test(s)) return { error: 'may only contain digits after the country code' };
    const parsed = parsePhoneNumberFromString(s, DEFAULT_ISO, metadata);
    if (!parsed) return { error: 'has a country code we don\'t recognise' };
    const code = `+${parsed.countryCallingCode}`;
    const country = byIso.get(parsed.country) ?? byCode.get(code);
    const { nationalNumber: number } = parsed;
    if (!country || number.length < country.min || number.length > country.max) {
        return { error: `must have ${digitsLabel(country ?? DEFAULT_COUNTRY)} digits after ${code}` };
    }
    return { code, number };
}

module.exports = { COUNTRIES, DEFAULT_COUNTRY, parsePhone };
