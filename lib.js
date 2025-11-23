
export async function asyncForEach(array, callback) {
    for (let index = 0; index < array.length; index++) {
        await callback(array[index], index, array);
    }
}

export function pad(num, size) {
  num = num.toString();
  while (num.length < size) num = "0" + num;
  return num;
}

export function convertIsoToMmDdYyyyHhMm(isoDateString) {
    const date = new Date(isoDateString);
    if (Number.isNaN(date.getTime())) {
        throw new Error(`Invalid date: ${isoDateString}`);
    }

    // Format in America/New_York, 24-hour, without timezone suffix
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });
    const parts = formatter.formatToParts(date);
    const lookup = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    const month = lookup.month || '01';
    const day = lookup.day || '01';
    const year = lookup.year || '1970';
    const hour = lookup.hour || '00';
    const minute = lookup.minute || '00';
    return `${month}/${day}/${year} ${hour}:${minute}`;
}
