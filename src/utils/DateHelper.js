const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const relativeTime = require('dayjs/plugin/relativeTime');
const duration = require('dayjs/plugin/duration');
const customParseFormat = require('dayjs/plugin/customParseFormat');
const ct = require('countries-and-timezones'); // Needed for Country -> Timezone lookup

// Register Plugins
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(relativeTime);
dayjs.extend(duration);
dayjs.extend(customParseFormat);

class DateHelper {

    constructor(tz = process.env.TIMEZONE || 'UTC') {
        this.timezone = tz;
        dayjs.tz.setDefault(this.timezone);
    }

    setTimezone(tz) {
        this.timezone = tz;
        dayjs.tz.setDefault(tz);
    }

    /**
     * Get current time
     */
    now(format = 'YYYY-MM-DD HH:mm:ss', timestamp = false) {
        const date = dayjs().tz(this.timezone);
        if (timestamp === false) {
            return date.format(format);
        }
        return date.unix();
    }

    addMinute(value) {
        return dayjs().tz(this.timezone).add(value, 'minute').unix();
    }

    addDays(value) {
        return dayjs().tz(this.timezone).add(value, 'day').format('YYYY-MM-DD HH:mm:ss');
    }

    addYears(value, format = 'YYYY-MM-DD HH:mm:ss') {
        return dayjs().tz(this.timezone).add(value, 'year').format(format);
    }

    addDaysTimestamp(value) {
        return dayjs().tz(this.timezone).add(value, 'day').unix();
    }

    timestampTimeNow() {
        return dayjs().unix();
    }

    today() {
        return dayjs().tz(this.timezone).format('YYYY-MM-DD');
    }

    daysAgo(days) {
        return dayjs().tz(this.timezone).subtract(days, 'day').format('YYYY-MM-DD');
    }

    minuteAgo(min) {
        return dayjs().tz(this.timezone).subtract(min, 'minute').format('YYYY-MM-DD HH:mm:ss');
    }

    yesterday() {
        return dayjs().tz(this.timezone).subtract(1, 'day').format('YYYY-MM-DD');
    }

    format(value) {
        return dayjs(value).format('YYYY-MM-DD HH:mm:ss');
    }

    formatDate(date, format = 'DD-MM-YYYY h:mma') {
        if (!date) return '--';
        
        // Handle slashes logic from PHP
        if (typeof date === 'string' && date.includes('/')) {
            return dayjs(date, 'DD/MM/YYYY').format(format);
        }
        return dayjs(date).format(format);
    }

    formatDateFromTimestamp(timestamp, format = 'h:mma') {
        if (!timestamp) return '--';
        return dayjs.unix(timestamp).tz(this.timezone).format(format);
    }

    formatToTimestamp(date = null) {
        if (date) {
            return dayjs(date).unix();
        }
        return '--';
    }

    timesAgo(dateInput) {
        // Handle timestamp (number) or string
        const d = typeof dateInput === 'number' ? dayjs.unix(dateInput) : dayjs(dateInput);
        return d.fromNow();
    }

    /**
     * Get All Timezones formatted like PHP
     */
    getAllTimezone() {
        // Intl is built-in to Node.js
        const zones = Intl.supportedValuesOf('timeZone');
        const locations = {};
        
        const validContinents = [
            'Africa', 'America', 'Antarctica', 'Arctic', 
            'Asia', 'Atlantic', 'Australia', 'Europe', 
            'Indian', 'Pacific'
        ];

        zones.forEach(zone => {
            const parts = zone.split('/');
            const continent = parts[0];
            
            if (validContinents.includes(continent) && parts[1]) {
                let area = parts[1].replace(/_/g, ' ');
                if (parts[2]) {
                    area += ` (${parts[2].replace(/_/g, ' ')})`;
                }

                if (!locations[continent]) locations[continent] = {};
                locations[continent][zone] = area;
            }
        });

        return locations;
    }

    diffInMonths(from, to) {
        return dayjs(from).diff(dayjs(to), 'month');
    }

    diffInDays(from, to) {
        return dayjs(from).diff(dayjs(to), 'day');
    }

    diffInSeconds(from, to) {
        return dayjs(from).diff(dayjs(to), 'second');
    }

    hoursLeftUntilMidnight() {
        const now = dayjs().tz(this.timezone);
        const tomorrow = now.add(1, 'day').startOf('day');
        return tomorrow.diff(now, 'hour');
    }

    addHours(hours, format = 'DD-MM-YYYY') {
        return dayjs().tz(this.timezone).add(hours, 'hour').format(format);
    }

    nextMonth(current_date) {
        return dayjs(current_date).add(1, 'month').format('YYYY-MM-DD HH:mm:ss');
    }

    lastWeekTimestamp() {
        return dayjs().tz(this.timezone).subtract(1, 'week').unix();
    }

    /**
     * Get DateTime by Country Code (e.g., 'NG', 'US')
     */
    getCurrentDateTimeByCountry(countryName) {
        const country = ct.getCountry(countryName.toUpperCase());
        
        if (!country || !country.timezones || country.timezones.length === 0) {
            return false;
        }

        const timezone = country.timezones[0];
        const date = dayjs().tz(timezone).format('YYYY-MM-DD HH:mm:ss');

        return { timezone, date };
    }

    canStart(nigeriaDateTime, targetCountry) {
        const ngCountry = ct.getCountry('NG');
        const ngZone = ngCountry ? ngCountry.timezones[0] : 'Africa/Lagos';
        
        const ngDate = dayjs.tz(nigeriaDateTime, ngZone);
        const targetData = ct.getCountry(targetCountry.toUpperCase());
        if (!targetData || !targetData.timezones.length) return false;
        
        const targetZone = targetData.timezones[0];
        const targetNow = dayjs().tz(targetZone);

        return targetNow.valueOf() >= ngDate.valueOf();
    }

    is_date(date) {
        return dayjs(date).isValid();
    }

    formatTimeAgo(dateInput) {
        const d = (typeof dateInput === 'number' || !isNaN(dateInput)) 
            ? dayjs.unix(dateInput) 
            : dayjs(dateInput);
            
        return d.fromNow();
    }

    addDurationToTimestamp(value, unit) {
        // Normalize unit (remove 's' at end if present)
        let normalizedUnit = unit.toLowerCase();
        if (normalizedUnit.endsWith('s')) {
            normalizedUnit = normalizedUnit.slice(0, -1);
        }

        return dayjs().tz(this.timezone).add(value, normalizedUnit).unix();
    }

    calculateAge(dateOfBirth) {
        return dayjs().diff(dayjs(dateOfBirth), 'year');
    }

    toTimestamp(datetime) {
        if (!datetime) return false;
        if (!isNaN(datetime)) return parseInt(datetime);

        const d = dayjs(datetime);
        return d.isValid() ? d.unix() : false;
    }

    /**
     * Start of Day (Timestamp)
     * Returns Unix Timestamp (e.g., 1709856000)
     */
    startOfDayTimestamp() {
        return dayjs().tz(this.timezone).startOf('day').unix();
    }

    /**
     * Start of Month (Timestamp)
     * Returns Unix Timestamp
     */
    startOfMonthTimestamp() {
        return dayjs().tz(this.timezone).startOf('month').unix();
    }
}

module.exports = DateHelper;