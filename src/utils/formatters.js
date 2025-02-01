import { format } from 'date-fns';

// Number formatters
export const formatNumber = (number, options = {}) => {
  const {
    decimals = 2,
    prefix = '',
    suffix = '',
    compact = false,
  } = options;

  if (number === null || number === undefined) {
    return '-';
  }

  try {
    const formatter = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      notation: compact ? 'compact' : 'standard',
      compactDisplay: 'short',
    });

    return `${prefix}${formatter.format(number)}${suffix}`;
  } catch (error) {
    console.error('Error formatting number:', error);
    return '-';
  }
};

// Currency formatters
export const formatCurrency = (amount, options = {}) => {
  const {
    currency = 'USD',
    decimals = 2,
    compact = false,
  } = options;

  if (amount === null || amount === undefined) {
    return '-';
  }

  try {
    const formatter = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      notation: compact ? 'compact' : 'standard',
      compactDisplay: 'short',
    });

    return formatter.format(amount);
  } catch (error) {
    console.error('Error formatting currency:', error);
    return '-';
  }
};

// Percentage formatters
export const formatPercentage = (value, options = {}) => {
  const {
    decimals = 2,
    alwaysShowSign = false,
    colorCode = false,
  } = options;

  if (value === null || value === undefined) {
    return '-';
  }

  try {
    const formatter = new Intl.NumberFormat('en-US', {
      style: 'percent',
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });

    const formattedValue = formatter.format(value / 100);
    
    if (colorCode) {
      return {
        value: formattedValue,
        color: value > 0 ? 'success.main' : value < 0 ? 'error.main' : 'text.primary',
      };
    }

    return alwaysShowSign && value > 0 ? `+${formattedValue}` : formattedValue;
  } catch (error) {
    console.error('Error formatting percentage:', error);
    return '-';
  }
};

// Date formatters
export const formatDate = (date, format = 'MMM dd, yyyy') => {
  if (!date) return '-';

  try {
    return format(new Date(date), format);
  } catch (error) {
    console.error('Error formatting date:', error);
    return '-';
  }
};

// Time formatters
export const formatTime = (date, options = {}) => {
  const {
    includeSeconds = false,
    format24Hour = false,
  } = options;

  if (!date) return '-';

  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: 'numeric',
      second: includeSeconds ? 'numeric' : undefined,
      hour12: !format24Hour,
    });

    return formatter.format(new Date(date));
  } catch (error) {
    console.error('Error formatting time:', error);
    return '-';
  }
};

// Volume formatters
export const formatVolume = (volume, options = {}) => {
  const {
    decimals = 0,
    threshold = 1000000,
  } = options;

  if (volume === null || volume === undefined) {
    return '-';
  }

  try {
    if (volume >= threshold) {
      return formatNumber(volume, { decimals, compact: true });
    }
    return formatNumber(volume, { decimals });
  } catch (error) {
    console.error('Error formatting volume:', error);
    return '-';
  }
};

// Price change formatters
export const formatPriceChange = (change, options = {}) => {
  const {
    decimals = 2,
    includePlusSign = true,
    includeParentheses = false,
    colorCode = false,
  } = options;

  if (change === null || change === undefined) {
    return '-';
  }

  try {
    const formatted = formatNumber(Math.abs(change), { decimals });
    let result = change < 0 ? `-${formatted}` : includePlusSign ? `+${formatted}` : formatted;
    
    if (includeParentheses && change < 0) {
      result = `(${formatted})`;
    }

    if (colorCode) {
      return {
        value: result,
        color: change > 0 ? 'success.main' : change < 0 ? 'error.main' : 'text.primary',
      };
    }

    return result;
  } catch (error) {
    console.error('Error formatting price change:', error);
    return '-';
  }
}; 