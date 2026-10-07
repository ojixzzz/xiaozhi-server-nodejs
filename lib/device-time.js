'use strict';

// Stock firmware consumes timezone_offset in minutes, timestamp in milliseconds.
// This Indonesian setup package defaults to WIB; this is not an inferred user setting.
function parseDeviceTimezoneOffset(value) {
  if(value===undefined || value==='') return 420;
  if(typeof value!=='string' || !/^-?\d+$/.test(value))throw new TypeError('DEVICE_TIMEZONE_OFFSET_MINUTES must be an integer number of minutes');
  const minutes=Number(value);
  if(!Number.isInteger(minutes) || minutes < -720 || minutes > 840)throw new RangeError('DEVICE_TIMEZONE_OFFSET_MINUTES must be between -720 and 840 minutes');
  return minutes;
}
function deviceServerTime(offsetMinutes, timestamp=Date.now()) {
  if(!Number.isInteger(offsetMinutes) || offsetMinutes < -720 || offsetMinutes > 840)throw new RangeError('Invalid device timezone offset in minutes');
  if(!Number.isSafeInteger(timestamp) || timestamp<0)throw new TypeError('Device timestamp must be UTC epoch milliseconds');
  return {timestamp,timezone_offset:offsetMinutes};
}
module.exports={parseDeviceTimezoneOffset,deviceServerTime};
