const Airtable = require('airtable');
const { escapeAirtableFormula, isValidEmail } = require('./validation');

console.log('Airtable API Key:', process.env.AIRTABLE_API_KEY ? 'Exists' : 'Not set');
console.log('Airtable Base ID:', process.env.AIRTABLE_BASE_ID ? 'Exists' : 'Not set');

Airtable.configure({
    endpointUrl: 'https://api.airtable.com',
    apiKey: process.env.AIRTABLE_API_KEY
});

const base = Airtable.base(process.env.AIRTABLE_BASE_ID);

const fetchAttendeeByEmail = async (email) => {
    const sanitizedEmail = escapeAirtableFormula(email);
    const records = await base('attendees').select({
        filterByFormula: `{email} = '${sanitizedEmail}'`,
        maxRecords: 1
    }).firstPage();

    return records.length > 0 ? records[0] : null;
};

const createAttendee = async (email, name, phone, businessName, okToEmail, debug) => {
    const record = await base('attendees').create({
        email,
        name,
        phone,
        businessName,
        okToEmail,
        debug
    });

    return record;
};

const createCheckinEntry = async (attendeeId, eventId, debug, token) => {
    const record = await base('checkins').create({
        Attendee: [attendeeId],
        checkinDate: new Date().toISOString(),
        eventId: eventId,
        debug,
        token
    });

    return record;
};

const findExistingCheckin = async (attendeeId, eventId, token) => {
    const sanitizedEventId = escapeAirtableFormula(eventId);
    const sanitizedToken = escapeAirtableFormula(token);

    // Get today's date in YYYY-MM-DD format for comparison
    const today = new Date().toISOString().split('T')[0];

    // Query for check-ins matching eventId, token, and date
    // Then filter by attendeeId in code since Airtable formulas with linked records are tricky
    const formula = `AND(
        {eventId} = '${sanitizedEventId}',
        {token} = '${sanitizedToken}',
        DATESTR({checkinDate}) = '${today}'
    )`;

    console.log('Finding existing check-in with formula:', formula);
    console.log('Looking for attendeeId:', attendeeId);

    const records = await base('checkins').select({
        filterByFormula: formula,
        sort: [{field: 'checkinDate', direction: 'desc'}]
    }).firstPage();

    console.log('Found', records.length, 'records matching event/token/date');

    // Filter by attendeeId in code
    const matchingRecord = records.find(record => {
        const attendeeField = record.get('Attendee');
        console.log('Checking record', record.id, 'attendee field:', attendeeField);
        // Attendee field is an array of record IDs
        return attendeeField && attendeeField.includes(attendeeId);
    });

    if (matchingRecord) {
        console.log('Existing check-in found:', matchingRecord.id);
    } else {
        console.log('No matching check-in found for this attendee');
    }

    return matchingRecord || null;
};

module.exports = {
    fetchAttendeeByEmail,
    createAttendee,
    createCheckinEntry,
    findExistingCheckin,
    escapeAirtableFormula,
    isValidEmail
};