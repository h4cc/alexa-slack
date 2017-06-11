const Alexa = require('alexa-sdk');
const request = require('request-promise-native');
const moment = require('moment');

exports.handler = function(event, context, callback) {
  const alexa = Alexa.handler(event, context);
  alexa.appId = process.env.ALEXA_APP_ID;
  alexa.registerHandlers(handlers);
  alexa.execute();
};

const handlers = {
  'LaunchRequest': launchRequestHandler,
  'AMAZON.StopIntent': stopIntentHandler,
  'AMAZON.CancelIntent': cancelIntentHandler,
  'AMAZON.HelpIntent': helpIntentHandler,
  'SlackClearStatusIntent': slackClearStatusIntentHandler,
  'SlackBusyIntent': slackBusyIntentHandler,
  'Unhandled': unhandledIntentHandler,
};

/**
 * Handles launch requests, i.e. "Alexa, open [app name]".
 */
function launchRequestHandler() {
  let access_token = this.event.session.user.accessToken;
  if (access_token) {
    this.emit(':ask', 'What would you like to do?', "I'm sorry, I didn't hear you. Could you say that again?");
  } else {
    this.emit(':tellWithLinkAccountCard', "Please connect your Slack account to Alexa using the Alexa app.");
  }
}


/**
 * Handles an `SlackClearStatusIntent`, sent when the user requests their status
 * be cleared.
 */
function slackClearStatusIntentHandler() {
  let access_token = this.event.session.user.accessToken;
  let status = {
    status_text: '',
    status_emoji: ''
  };

  if (!access_token) {
    this.emit(':tellWithLinkAccountCard', 'Please connect your Slack account to Alexa using the Alexa app on your phone.');
  }

  setSlackStatus(status, access_token).
    then(() => { this.emit(':tell', "Okay, I'll clear your status."); }).
    catch(error => { this.emit(':tell', error.message); });
}

/**
 * Handles an `SlackBusyIntent`, which should set a status and snooze notifications
 * until the specified time.
 */
function slackBusyIntentHandler() {
  let device_id = this.event.context.System.device.deviceId;
  let consent_token = this.event.context.System.user.permissions.consentToken;
  let access_token = this.event.session.user.accessToken;
  let status = this.event.request.intent.slots.status.value;
  let requested_time = this.event.request.intent.slots.time.value;

  if (!access_token) {
    this.emit(':tellWithLinkAccountCard', 'Please connect your Slack account to Alexa using the Alexa app on your phone.');
  }

  if (!status) {
    this.emit(':ask', "I didn't get your status, please try again.", "I'm sorry, I didn't hear you. Could you say that again?");
  }

  if (!requested_time) {
    this.emit(':ask', "I didn't get the time, please try again.", "I'm sorry, I didn't hear you. Could you say that again?");
  }

  getEchoUTCOffset(device_id, consent_token).
    then(offset => { return setSlackDNDUntil(requested_time, offset, access_token); }).
    then(() => { return setSlackStatus(emojifyStatus(status), access_token); }).
    then(() => { this.emit(':tell', `Okay, I'll change your status and snooze your notifications until ${moment(requested_time, 'HH:mm').format('h:mm a')}.`); }).
    catch(error => { this.emit(':tell', error.message); });
}

function stopIntentHandler() {
  this.emit(':tell', "Okay");
}

function cancelIntentHandler() {
  this.emit(':tell', "Okay");
}

function helpIntentHandler() {
  let text = "<p>Here are a few things you can do:</p>";
  text += `<p>To set your status and snooze your notifications, say: I'm in status until time, for example: I'm in a call until 5:00 pm. This will set your status and mute your notifications until that time.</p>`;
  text += "<p>To clear your status, say: clear my status.</p>";
  this.emit(":ask", text, "I'm sorry, I didn't hear you. Could you say that again?");
}

function unhandledIntentHandler() {
  this.emit(':ask', "I didn't get that. What would you like to do?", "I'm sorry, I didn't hear you. Could you say that again?");
}

/**
 * Sets the Slack user's DND until a given time.
 * @param {String} time The time snooze should end, e.g. 13:00 or EV
 * @param {Number} offset An UTC offset in minutes.
 * @param {String} token Slack auth token.
 * @return {Promise} A promise that resolves if the request is successful;
 * or is rejected with an error if it fails.
 */
function setSlackDNDUntil(time, offset, token) {
  let requested_time = normalizeAmazonTime(time);
  let minutes = getMinutesUntil(requested_time, offset);
  return setSlackDND(minutes, token);
}

/**
 * Sets the Slack user's DND.
 * @param {Number} minutes The number of minutes to snooze notifications.
 * @param {String} token Slack auth token.
 * @return {Promise} A promise that resolves if the request is successful;
 * or is rejected with an error if it fails.
 */
function setSlackDND(minutes, token) {

  let opts = {
    method: 'POST',
    url: `https://slack.com/api/dnd.setSnooze`,
    form: {
      num_minutes: minutes,
      token: token
    },
    json: true,
    simple: false,
    resolveWithFullResponse: true
  };
  return request(opts).then(response => {
    if (response.statusCode !== 200 || !response.body.ok) {
      return Promise.reject(new Error(`I couldn't snooze notifications. The error from Slack was: ${response.body.error}`));
    }
  });
}

/**
 * Sets the Slack user's status.
 * @param {Object} status The user's requested status.
 * @param {String} token Slack auth token.
 * @return {Promise} A promise that resolves if the request is successful;
 * or is rejected with an error if it fails.
 */
function setSlackStatus(status, token) {
  let opts = {
    method: 'POST',
    url: `https://slack.com/api/users.profile.set`,
    form: {
      profile: JSON.stringify(status),
      token: token
    },
    json: true,
    simple: false,
    resolveWithFullResponse: true
  };
  return request(opts).then(response => {
    if (response.statusCode !== 200 || !response.body.ok) {
      return Promise.reject(new Error(`I couldn't set the status. The error from Slack was: ${response.body.error}`));
    }
  });
}

/**
 * Alexa can accept utterances like: "night", "morning", "afternoon", "evening".
 * This function normalizes them to reasonable hours.
 * @param {String} amazon_time The time from the AMAZON.TIME slot.
 * @return {String} A time, in HH:mm format.
 */
function normalizeAmazonTime(time) {
  switch(time) {
    case 'MO':
      time = '09:00';
      break;
    case 'AF':
      time = '13:00';
      break;
    case 'EV':
      time = '19:00';
      break;
    case 'NI':
      time = '21:00';
      break;
  }
  return time;
}

/**
 * Calculate the difference in minutes between the time sent by the Alexa skill and the current time.
 * @param {String} requested_time A time received from the Alexa skill (e.g. "13:00")
 * @param {Number} offset The user's timezone offset, in minutes.
 * @return {Number} The difference in minutes between the current time and requested_time.
 */
function getMinutesUntil(requested_time, offset) {
  // Convert the requested time and the current time to the user's timezone.
  requested_time = moment(`${requested_time}Z`, 'HH:mmZ').utcOffset(offset, true);
  now = moment(Date.now()).utcOffset(offset);

  // Requested time could be in the past, e.g. saying "9:00 am" at 10:00 am.
  // In that case assume the user meant the next day, so add a day.
  if (now > requested_time) {
    requested_time.add(1, 'day');
  }

  return requested_time.diff(now, 'minutes');
}

/**
 * Gets the UTC offset of the Echo, based on its address.
 * @param {String} device_id The Echo's device ID.
 * @param {String} consent_token The user's consent token.
 * @return {Promise.<String>} A promise that resolves to the offset of the Echo.
 */
function getEchoUTCOffset(device_id, consent_token) {
  return getEchoAddress(device_id, consent_token).
          then(geocodeLocation).
          then(getUTCOffset);
}

/**
 * Requests the Echo's country and postal code from the Alexa API.
 * @param {String} device_id The Echo's device ID.
 * @param {String} consent_token The user's consent token.
 * @return {Promise.<String>} A promise that resolves to the address of the Echo,
 or is rejected if the user hasn't granted permission.
 */
function getEchoAddress(device_id, consent_token) {
  let opts = {
    url: `https://api.amazonalexa.com/v1/devices/${device_id}/settings/address/countryAndPostalCode`,
    headers: {
      'Authorization': `Bearer ${consent_token}`
    },
    json: true,
    simple: false,
    resolveWithFullResponse: true
  };
  return request(opts).then(response => {
    if (response.statusCode === 200) {
      return `${response.body.postalCode} ${response.body.countryCode}`;
    } else {
      return Promise.reject(new Error("I'm sorry, I couldn't get your location. Make sure you've given this skill permission to use your address in the Alexa app."));
    }
  });
}

/**
 * Geocodes a location or address using the Google Maps API.
 * @param {String} location An address or location (e.g. "20003 USA").
 * @return {Promise.<Object>} A promise that resolves to the first result from the API, or
 * is rejected if the address is not valid.
 */
function geocodeLocation(location) {
  let opts = {
    url: `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(location)}&key=${process.env.MAPS_API_KEY}`,
    json: true,
    simple: false,
    resolveWithFullResponse: true
  };
  return request(opts).then(response => {
    if ((response.statusCode === 200) && (response.body.status === 'OK')) {
      return response.body.results[0];
    } else {
      return Promise.reject(new Error(`I'm sorry, I couldn't understand that address. The response from Google Maps was ${response.body.status}`));
    }
  });
}

/**
 * Gets the timezone for a given location
 * @param {Object} location A geocoded location returned from the Google Maps geocoding API.
 * @return {Promise.<Number>} A promise that resolves to the offset from UTC in minutes,
 * or is rejected if the request fails.
 */
function getUTCOffset(location) {
  let opts = {
    url: `https://maps.googleapis.com/maps/api/timezone/json?location=${location.geometry.location.lat},${location.geometry.location.lng}&timestamp=${Math.round(Date.now()/1000)}&key=${process.env.MAPS_API_KEY}`,
    json: true,
    simple: false,
    resolveWithFullResponse: true
  };
  return request(opts).then(response => {
    if ((response.statusCode === 200) && (response.body.status === 'OK'))  {
      return (response.body.rawOffset + response.body.dstOffset)/60;
    } else {
      return Promise.reject(new Error(`I'm sorry, I couldn't get the timezone for that location. The response from Google Maps was ${response.body.status}`));
    }
  });
}

/**
 * Returns the profile object the Slack API requires.
 * @param {String} status The user's requested status.
 * @return {Object} An object with the text and emoji for the given status.
 */
function emojifyStatus(status) {
  if (status.match(/lunch/)) {
    profile = {
      status_text: status,
      status_emoji: ':taco:'
    };
  } else if (status.match(/coffee/)) {
    profile = {
      status_text: status,
      status_emoji: ':coffee:'
    };
  } else if (status.match(/busy/)) {
    profile = {
      status_text: 'Do not disturb',
      status_emoji: ':no_entry_sign:'
    };
  } else if (status.match(/errand/)) {
    profile = {
      status_text: status,
      status_emoji: ':running:'
    };
  } else if (status.match(/doctor/)) {
    profile = {
      status_text: status,
      status_emoji: ':face_with_thermometer:'
    };
  } else if (status.match(/away/)) {
    profile = {
      status_text: status,
      status_emoji: ':no_entry_sign:'
    };
  } else if (status.match(/call/)) {
    profile = {
      status_text: status,
      status_emoji: ':slack_call:'
    };
  } else if (status.match(/meeting/)) {
    profile = {
      status_text: status,
      status_emoji: ':calendar:'
    };
  } else if (status.match(/sick/)) {
    profile = {
      status_text: status,
      status_emoji: ':face_with_thermometer:'
    };
  } else if (status.match(/commuting/)) {
    profile = {
      status_text: status,
      status_emoji: ':bus:'
    };
  } else {
    profile = {
      status_text: status,
      status_emoji: ':speech_balloon:'
    };
  }
  return profile;
}
