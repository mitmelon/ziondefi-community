/**
 * Format an integer amount (in smallest units, e.g. cents) to a money string
 * with thousands separators and fixed decimal places.
 *
 * Examples:
 *  formatMoneyInt(123) -> "1.23" (with decimals=2)
 *  formatMoneyInt(1234567) -> "12,345.67"
 *  formatMoneyInt(-1200) -> "-12.00"
 *
 * @param {number|string|BigInt} value Integer amount in smallest unit (or numeric string)
 * @param {number} decimals Number of decimal places (default 2)
 * @returns {string}
 */
/**
 * Format an integer amount (in smallest units, e.g. cents) to a money string
 * with thousands separators and fixed decimal places.
 */
function formatMoneyInt(value, decimals = 2) {
    if (value === null || value === undefined || value === '') {
        return (decimals > 0) ? `0.${'0'.repeat(decimals)}` : '0';
    }

    let totalUnits;
    if (typeof value === 'bigint') {
        totalUnits = value;
    } else {
        let s = String(value).trim();
        if (s === '') return (decimals > 0) ? `0.${'0'.repeat(decimals)}` : '0';
        
        if (s.includes('.')) {
            const parts = s.split('.');
            let integerPart = parts[0];
            let fractionalPart = parts[1].substring(0, decimals).padEnd(decimals, '0');
            
            if (integerPart === '' || integerPart === '-') {
                integerPart += '0';
            }
            
            totalUnits = BigInt(integerPart + fractionalPart);
        } else {
            totalUnits = BigInt(s);
        }
    }

    const isNegative = totalUnits < 0n;
    const absValue = isNegative ? -totalUnits : totalUnits;
    
    const divisor = 10n ** BigInt(decimals);
    const intPart = absValue / divisor;
    const fracPart = absValue % divisor;

    const intStr = intPart.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');

    if (decimals <= 0) {
        return (isNegative ? '-' : '') + intStr;
    }
    
    const fracStr = fracPart.toString().padStart(decimals, '0');
    return `${isNegative ? '-' : ''}${intStr}.${fracStr}`;
}

module.exports = { formatMoneyInt };

