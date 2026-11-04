/* plan-message.js: the "Ask for a bed" message in the owner's language.
 *
 * The same words as the phone app's lib/services/booking_message.dart (and its tests), so a message
 * written here and one written there read alike. Spanish for places in Spain, French for places in
 * France (planner.owner_language works out which and puts "lg":"fr" in /plan/stays.json), always with
 * one polite request to reply in English. build() also gives an English "meaning" so an English
 * speaker knows what they are sending. Nothing is sent from here: the page opens the visitor's own WhatsApp or
 * email program with the text filled in.
 *
 * It runs in the browser (window.CaminoMessage) and in Node tests.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CaminoMessage = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_NIGHTS = 14, MAX_PEOPLE = 10, MAX_NAME = 80;
  var ES_DAYS = ['lunes', 'martes', 'mi\u00e9rcoles', 'jueves', 'viernes', 's\u00e1bado', 'domingo'];
  var FR_DAYS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
  var EN_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  var ES_MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  var FR_MONTHS = ['janvier', 'f\u00e9vrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'ao\u00fbt', 'septembre', 'octobre', 'novembre', 'd\u00e9cembre'];
  var EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  // 'YYYY-MM-DD' as { year, month (1 to 12), day, weekday (0 is Monday) }, or null.
  function parseDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!m) return null;
    var year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
    var d = new Date(Date.UTC(year, month - 1, day));
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
    return { year: year, month: month, day: day, weekday: (d.getUTCDay() + 6) % 7 };
  }

  // The owner's language for a place's stay details: French when the guide says so, otherwise Spanish.
  function languageFor(details) { return details && details.lg === 'fr' ? 'fr' : 'es'; }

  // Whether there is a way to send a message at all (a WhatsApp number or an email address).
  function canAsk(details) { return !!(details && (details.wa || details.em)); }

  function cleanName(value) {
    return String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, MAX_NAME).trim();
  }

  // opts: { language 'es'|'fr', channel 'whatsapp'|'email', placeName, arrival 'YYYY-MM-DD', nights, people,
  //         room 'dormitory'|'room', yourName }
  // Returns { subject (email only, else null), body, meaning }. Throws for an impossible party or stay.
  function build(opts) {
    var people = opts.people, nights = opts.nights;
    if (!(people === Math.floor(people)) || !(nights === Math.floor(nights)) || people < 1 || people > MAX_PEOPLE || nights < 1 || nights > MAX_NIGHTS) {
      throw new RangeError('Invalid party size or stay length');
    }
    var when = parseDate(opts.arrival);
    if (!when) throw new RangeError('Invalid arrival date');
    var name = cleanName(opts.yourName);
    var fr = opts.language === 'fr', email = opts.channel === 'email', priv = opts.room === 'room';
    var placeName = String(opts.placeName === undefined || opts.placeName === null ? '' : opts.placeName).trim();

    var request = fr
      ? (priv
        ? (people === 1 ? 'une chambre individuelle' : people === 2 ? 'une chambre double' : 'une chambre pour ' + people + ' personnes')
        : (people === 1 ? 'un lit en dortoir' : people + ' lits en dortoir'))
      : (priv
        ? (people === 1 ? 'una habitaci\u00f3n individual' : people === 2 ? 'una habitaci\u00f3n doble' : 'una habitaci\u00f3n para ' + people + ' personas')
        : (people === 1 ? 'una cama en dormitorio' : people + ' camas en dormitorio'));
    var stay = fr
      ? (nights === 1 ? 'une nuit' : nights === 2 ? 'deux nuits' : nights + ' nuits')
      : (nights === 1 ? 'una noche' : nights === 2 ? 'dos noches' : nights + ' noches');
    var price = fr
      ? 'le tarif par nuit' + (priv ? ' (par chambre ou par personne)' : '')
      : 'el precio por noche' + (priv ? ' (por habitaci\u00f3n o por persona)' : '');
    var shortDate = fr
      ? FR_DAYS[when.weekday] + ' ' + when.day + ' ' + FR_MONTHS[when.month - 1]
      : ES_DAYS[when.weekday] + ' ' + when.day + ' de ' + ES_MONTHS[when.month - 1];
    var date = shortDate + (fr ? ' ' : ' de ') + when.year;
    var signature = name === '' ? '' : '\n' + name;

    var body = fr
      ? (email ? 'Madame, Monsieur,' : 'Bonjour,') + '\n\n' +
        (name === '' ? '' : "Je m'appelle " + name + '. ') + 'Je fais le Chemin de Saint-Jacques. Auriez-vous ' + request + ' pour ' + stay + ', en arrivant le ' + date + ' ?\n\n' +
        "S'il y a de la disponibilit\u00e9, pourriez-vous m'indiquer " + price + " et s'il est n\u00e9cessaire de r\u00e9server ou de confirmer mon arriv\u00e9e ?\n\n" +
        "Si cela vous est possible, pourriez-vous me r\u00e9pondre en anglais, s'il vous pla\u00eet ? Mon fran\u00e7ais est limit\u00e9 et je vous remercie d'avance de votre compr\u00e9hension. (If possible, could you please reply in English? Thank you very much.)\n\n" +
        'Je vous remercie de votre temps et de votre gentillesse. Bon Chemin !' + signature
      : (email ? 'Estimados se\u00f1ores de ' + placeName + ':' : 'Buenos d\u00edas:') + '\n\n' +
        (name === '' ? '' : 'Me llamo ' + name + '. ') + 'Estoy haciendo el Camino de Santiago. \u00bfTendr\u00edan ' + request + ' para ' + stay + ', llegando el ' + date + '?\n\n' +
        'Si hay disponibilidad, les agradecer\u00eda mucho que me indicaran ' + price + ' y si es necesario reservar o confirmar la llegada.\n\n' +
        'Si les resulta posible, \u00bfpodr\u00edan responderme en ingl\u00e9s, por favor? Mi espa\u00f1ol es limitado y se lo agradezco de antemano. (If possible, could you please reply in English? Thank you very much.)\n\n' +
        'Muchas gracias por su tiempo y su amabilidad. \u00a1Buen Camino!' + signature;

    var englishRequest = priv
      ? (people === 1 ? 'a single room' : people === 2 ? 'a double room' : 'a room for ' + people + ' people')
      : (people === 1 ? 'a bed in a dormitory' : people + ' beds in a dormitory');
    var meaning = "Hello. I'm walking the Camino de Santiago. Do you have " + englishRequest + ' for ' + (nights === 1 ? 'one night' : nights + ' nights') +
      ', arriving on ' + EN_DAYS[when.weekday] + ' ' + when.day + ' ' + EN_MONTHS[when.month - 1] + ' ' + when.year +
      '? If there is availability, I would be very grateful if you could tell me the price per night' + (priv ? ' (per room or per person)' : '') +
      ' and whether I need to book or confirm my arrival. If it is possible, could you please reply in English? Thank you very much for your time and kindness. Buen Camino!' +
      (name === '' ? '' : ' ' + name);

    return {
      subject: email ? (fr ? 'Demande de disponibilit\u00e9 pour le' : 'Consulta de disponibilidad para el') + ' ' + shortDate : null,
      body: body,
      meaning: meaning
    };
  }

  // https://wa.me/<number with its country code>?text=<message>. Spaces are %20 and new lines %0A.
  function whatsAppLink(digits, text) {
    var number = String(digits || '').replace(/\D/g, '');
    if (number.length < 8 || number.length > 15) throw new RangeError('Invalid WhatsApp number');
    return 'https://wa.me/' + number + '?text=' + encodeURIComponent(String(text));
  }

  // mailto: with the subject and body. Spaces are %20, not +, which some email programs show as it is.
  function emailLink(address, subject, body) {
    var to = String(address || '').trim();
    if (!/^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/.test(to)) throw new RangeError('Invalid email address');
    var query = [];
    if (subject !== undefined && subject !== null) query.push('subject=' + encodeURIComponent(String(subject)));
    if (body !== undefined && body !== null) query.push('body=' + encodeURIComponent(String(body)));
    return 'mailto:' + encodeURIComponent(to) + (query.length ? '?' + query.join('&') : '');
  }

  return {
    MAX_NIGHTS: MAX_NIGHTS, MAX_PEOPLE: MAX_PEOPLE, MAX_NAME: MAX_NAME,
    parseDate: parseDate, languageFor: languageFor, canAsk: canAsk, cleanName: cleanName,
    build: build, whatsAppLink: whatsAppLink, emailLink: emailLink
  };
});
