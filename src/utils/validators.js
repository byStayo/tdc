// Number validators
export const isValidNumber = (value) => {
  if (value === null || value === undefined || value === '') {
    return false;
  }
  return !isNaN(Number(value)) && isFinite(value);
};

// Price validators
export const isValidPrice = (price) => {
  if (!isValidNumber(price)) {
    return false;
  }
  return Number(price) >= 0;
};

// Percentage validators
export const isValidPercentage = (value) => {
  if (!isValidNumber(value)) {
    return false;
  }
  const num = Number(value);
  return num >= -100 && num <= 100;
};

// Date validators
export const isValidDate = (date) => {
  if (!date) {
    return false;
  }
  const timestamp = Date.parse(date);
  return !isNaN(timestamp);
};

// Time validators
export const isValidTime = (time) => {
  if (!time) {
    return false;
  }
  // HH:mm or HH:mm:ss format
  const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$/;
  return timeRegex.test(time);
};

// Symbol validators
export const isValidSymbol = (symbol) => {
  if (!symbol || typeof symbol !== 'string') {
    return false;
  }
  // Basic stock symbol format (1-5 uppercase letters)
  const symbolRegex = /^[A-Z]{1,5}$/;
  return symbolRegex.test(symbol);
};

// Volume validators
export const isValidVolume = (volume) => {
  if (!isValidNumber(volume)) {
    return false;
  }
  return Number(volume) >= 0 && Number.isInteger(Number(volume));
};

// Email validators
export const isValidEmail = (email) => {
  if (!email || typeof email !== 'string') {
    return false;
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

// Password validators
export const isValidPassword = (password, options = {}) => {
  const {
    minLength = 8,
    requireUppercase = true,
    requireLowercase = true,
    requireNumbers = true,
    requireSpecialChars = true,
  } = options;

  if (!password || typeof password !== 'string') {
    return false;
  }

  if (password.length < minLength) {
    return false;
  }

  if (requireUppercase && !/[A-Z]/.test(password)) {
    return false;
  }

  if (requireLowercase && !/[a-z]/.test(password)) {
    return false;
  }

  if (requireNumbers && !/\d/.test(password)) {
    return false;
  }

  if (requireSpecialChars && !/[!@#$%^&*(),.?":{}|<>]/.test(password)) {
    return false;
  }

  return true;
};

// URL validators
export const isValidUrl = (url) => {
  if (!url || typeof url !== 'string') {
    return false;
  }
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
};

// Object validators
export const isValidObject = (obj, requiredFields = []) => {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return false;
  }

  return requiredFields.every(field => {
    const value = obj[field];
    return value !== undefined && value !== null;
  });
};

// Array validators
export const isValidArray = (arr, options = {}) => {
  const {
    minLength = 0,
    maxLength = Infinity,
    itemValidator = () => true,
  } = options;

  if (!Array.isArray(arr)) {
    return false;
  }

  if (arr.length < minLength || arr.length > maxLength) {
    return false;
  }

  return arr.every(itemValidator);
};

// Data state validators
export const isValidDataState = (state, requiredFields = []) => {
  if (!isValidObject(state)) {
    return false;
  }

  const hasRequiredFields = requiredFields.every(field => 
    state.hasOwnProperty(field) && state[field] !== undefined
  );

  if (!hasRequiredFields) {
    return false;
  }

  if (state.error && typeof state.error !== 'string' && !isValidObject(state.error)) {
    return false;
  }

  return true;
}; 