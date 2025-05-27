
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
    // Parse the ISO date string into a Date object
    const date = new Date(isoDateString);

    // Extract components
    const month = String(date.getUTCMonth() + 1).padStart(2, '0'); // Months are 0-based, so +1
    const day = String(date.getUTCDate()).padStart(2, '0');
    const year = date.getUTCFullYear();
    // const hours = String(date.getUTCHours()).padStart(2, '0');
    // const minutes = String(date.getUTCMinutes()).padStart(2, '0');

    // Format as MM/DD/YYYY HH:MM
    return `${month}/${day}/${year}`;
}