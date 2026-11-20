'use strict';

const VALID_DOCUMENT_TYPES = Object.freeze([
    'national_id',
    'passport',
    'drivers_license',
]);

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const isValidDateOnly = (value) => {
    if (typeof value !== 'string' || !ISO_DATE_REGEX.test(value)) return false;

    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));

    return (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
    );
};

const isAdult = (dateOfBirth) => {
    if (!isValidDateOnly(dateOfBirth)) return false;

    const [year, month, day] = dateOfBirth.split('-').map(Number);
    const today = new Date();

    let age = today.getFullYear() - year;
    const monthDifference = (today.getMonth() + 1) - month;

    if (monthDifference < 0 || (monthDifference === 0 && today.getDate() < day)) {
        age -= 1;
    }

    return age >= 18 && age <= 120;
};

const validateKycFields = (body = {}) => {
    const errors = [];

    const fullName = typeof body.fullName === 'string' ? body.fullName.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const idNumber = typeof body.idNumber === 'string' ? body.idNumber.trim() : '';
    const dateOfBirth = typeof body.dateOfBirth === 'string' ? body.dateOfBirth.trim() : '';
    const address = typeof body.address === 'string' ? body.address.trim() : '';
    const country = typeof body.country === 'string' ? body.country.trim() : '';
    const documentType = typeof body.documentType === 'string' ? body.documentType.trim() : '';

    if (fullName.length < 3 || fullName.length > 100) {
        errors.push('Full name must be between 3 and 100 characters.');
    }

    if (!email || email.length > 254 || !EMAIL_REGEX.test(email)) {
        errors.push('Please enter a valid email address.');
    }

    if (idNumber.length < 4 || idNumber.length > 50) {
        errors.push('ID number must be between 4 and 50 characters.');
    }

    if (!isAdult(dateOfBirth)) {
        errors.push('You must be between 18 and 120 years old with a valid date of birth.');
    }

    if (address.length < 5 || address.length > 300) {
        errors.push('Address must be between 5 and 300 characters.');
    }

    if (country.length < 2 || country.length > 100) {
        errors.push('Please enter a valid country name.');
    }

    if (!VALID_DOCUMENT_TYPES.includes(documentType)) {
        errors.push('Please select a valid document type.');
    }

    return {
        isValid: errors.length === 0,
        errors,
        data: {
            fullName,
            email,
            idNumber,
            dateOfBirth,
            address,
            country,
            documentType,
        },
    };
};

module.exports = {
    validateKycFields,
    isAdult,
    isValidDateOnly,
    VALID_DOCUMENT_TYPES,
};