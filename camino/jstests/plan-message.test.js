// camino/jstests/plan-message.test.js
// Tests for the "Ask for a bed" message (camino/static/camino/js/plan-message.js). No browser or Django needed.
// The expected wording is the phone app's own: test/booking_message_templates_test.dart and
// test/booking_message_test.dart in the app project.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const M = require('../static/camino/js/plan-message.js');

const SPANISH = `Buenos días:

Estoy haciendo el Camino de Santiago. ¿Tendrían una cama en dormitorio para una noche, llegando el viernes 14 de mayo de 2027?

Si hay disponibilidad, les agradecería mucho que me indicaran el precio por noche y si es necesario reservar o confirmar la llegada.

Si les resulta posible, ¿podrían responderme en inglés, por favor? Mi español es limitado y se lo agradezco de antemano. (If possible, could you please reply in English? Thank you very much.)

Muchas gracias por su tiempo y su amabilidad. ¡Buen Camino!`;
const FRENCH = `Bonjour,

Je fais le Chemin de Saint-Jacques. Auriez-vous un lit en dortoir pour une nuit, en arrivant le vendredi 14 mai 2027 ?

S'il y a de la disponibilité, pourriez-vous m'indiquer le tarif par nuit et s'il est nécessaire de réserver ou de confirmer mon arrivée ?

Si cela vous est possible, pourriez-vous me répondre en anglais, s'il vous plaît ? Mon français est limité et je vous remercie d'avance de votre compréhension. (If possible, could you please reply in English? Thank you very much.)

Je vous remercie de votre temps et de votre gentillesse. Bon Chemin !`;

const base = { placeName: 'Casa Test', arrival: '2027-05-14', nights: 1, people: 1, room: 'dormitory' };

for (const language of ['es', 'fr']) {
  for (const channel of ['whatsapp', 'email']) {
    for (const name of ['', 'Eva']) {
      test(`the approved ${language} ${channel} message, name=${JSON.stringify(name)}`, () => {
        const fr = language === 'fr';
        let expected = fr ? FRENCH : SPANISH;
        if (name) {
          expected = expected.replace(fr ? 'Je fais' : 'Estoy', fr ? "Je m'appelle Eva. Je fais" : 'Me llamo Eva. Estoy');
          expected += '\nEva';
        }
        if (channel === 'email') {
          expected = expected.replace(fr ? 'Bonjour,' : 'Buenos días:', fr ? 'Madame, Monsieur,' : 'Estimados señores de Casa Test:');
        }
        const m = M.build({ ...base, language, channel, yourName: name });
        assert.strictEqual(m.body, expected);
        assert.strictEqual(m.subject, channel === 'whatsapp' ? null
          : fr ? 'Demande de disponibilité pour le vendredi 14 mai' : 'Consulta de disponibilidad para el viernes 14 de mayo');
      });
    }
  }
}

for (const language of ['es', 'fr']) {
  for (const channel of ['whatsapp', 'email']) {
    for (const name of ['', "Éva O'Brien & José"]) {
      test(`${language} ${channel} message with name=${JSON.stringify(name)}: one English request, short, dated and signed`, () => {
        const m = M.build({ ...base, language, channel, yourName: name });
        assert.ok(m.body.length < 900);
        assert.strictEqual(m.body.split('could you please reply in English?').length - 1, 1);
        assert.ok(m.body.includes(language === 'fr' ? 'vendredi 14 mai 2027' : 'viernes 14 de mayo de 2027'));
        assert.ok(m.body.startsWith(language === 'fr' ? (channel === 'email' ? 'Madame, Monsieur,' : 'Bonjour,')
          : (channel === 'email' ? 'Estimados señores de Casa Test:' : 'Buenos días:')));
        assert.strictEqual(m.subject !== null, channel === 'email');
        if (name) assert.ok(m.body.endsWith(name)); else assert.ok(!/Me llamo|m'appelle/.test(m.body));
        assert.ok(!/undefined|null|NaN|\{|\}/.test(m.body + m.meaning), 'no placeholders');
      });
    }
  }
}

test('the request, the stay and the price follow the form', () => {
  for (const language of ['es', 'fr']) {
    for (const people of [1, 2, 3]) {
      for (const nights of [1, 2, 5]) {
        for (const room of ['dormitory', 'room']) {
          const m = M.build({ ...base, language, channel: 'whatsapp', people, nights, room });
          assert.ok(m.body.length < 900);
          assert.ok(m.meaning.includes(nights === 1 ? 'one night' : `${nights} nights`));
          assert.strictEqual(m.meaning.includes('per room or per person'), room === 'room');
          assert.strictEqual(m.body.includes(language === 'es' ? 'por habitación o por persona' : 'par chambre ou par personne'), room === 'room');
          assert.ok(m.meaning.includes(room === 'dormitory'
            ? (people === 1 ? 'a bed in a dormitory' : `${people} beds in a dormitory`)
            : people === 1 ? 'a single room' : people === 2 ? 'a double room' : 'a room for 3 people'));
          const word = { es: ['una noche', 'dos noches', '5 noches'], fr: ['une nuit', 'deux nuits', '5 nuits'] }[language][[1, 2, 5].indexOf(nights)];
          assert.ok(m.body.includes(` para ${word}`) || m.body.includes(` pour ${word}`), word);
          const kind = {
            es: { dormitory: people === 1 ? 'una cama en dormitorio' : `${people} camas en dormitorio`,
                  room: people === 1 ? 'una habitación individual' : people === 2 ? 'una habitación doble' : 'una habitación para 3 personas' },
            fr: { dormitory: people === 1 ? 'un lit en dortoir' : `${people} lits en dortoir`,
                  room: people === 1 ? 'une chambre individuelle' : people === 2 ? 'une chambre double' : 'une chambre pour 3 personnes' }
          }[language][room];
          assert.ok(m.body.includes(kind), kind);
        }
      }
    }
  }
});

test('the English meaning, with and without a name', () => {
  assert.strictEqual(M.build({ ...base, language: 'es', channel: 'whatsapp' }).meaning,
    "Hello. I'm walking the Camino de Santiago. Do you have a bed in a dormitory for one night, arriving on Friday 14 May 2027? If there is availability, I would be very grateful if you could tell me the price per night and whether I need to book or confirm my arrival. If it is possible, could you please reply in English? Thank you very much for your time and kindness. Buen Camino!");
  assert.ok(M.build({ ...base, language: 'fr', channel: 'email', yourName: 'Eva', room: 'room', people: 2 }).meaning
    .endsWith('Buen Camino! Eva'));
});

test('the weekday and month names are right on every day of 2027 and 2028', () => {
  const es = new Intl.DateTimeFormat('es', { weekday: 'long', timeZone: 'UTC' });
  const fr = new Intl.DateTimeFormat('fr', { weekday: 'long', timeZone: 'UTC' });
  const en = new Intl.DateTimeFormat('en', { weekday: 'long', timeZone: 'UTC' });
  const esMonth = new Intl.DateTimeFormat('es', { month: 'long', timeZone: 'UTC' });
  const frMonth = new Intl.DateTimeFormat('fr', { month: 'long', timeZone: 'UTC' });
  const enMonth = new Intl.DateTimeFormat('en', { month: 'long', timeZone: 'UTC' });
  let count = 0;
  for (let t = Date.UTC(2027, 0, 1); t < Date.UTC(2029, 0, 1); t += 86400000) {
    const d = new Date(t), iso = d.toISOString().slice(0, 10);
    const a = M.build({ ...base, arrival: iso, language: 'es', channel: 'email' });
    const b = M.build({ ...base, arrival: iso, language: 'fr', channel: 'email' });
    assert.ok(a.subject.endsWith(`${es.format(d)} ${d.getUTCDate()} de ${esMonth.format(d)}`), a.subject);
    assert.ok(b.subject.endsWith(`${fr.format(d)} ${d.getUTCDate()} ${frMonth.format(d)}`), b.subject);
    assert.ok(a.meaning.includes(`${en.format(d)} ${d.getUTCDate()} ${enMonth.format(d)} ${d.getUTCFullYear()}`), iso);
    count += 1;
  }
  assert.strictEqual(count, 731);
});

test('an impossible party, stay or date is refused', () => {
  const bad = (change) => assert.throws(() => M.build({ ...base, language: 'es', channel: 'whatsapp', ...change }), RangeError);
  bad({ people: 0 }); bad({ people: 11 }); bad({ people: 1.5 }); bad({ people: NaN }); bad({ people: undefined });
  bad({ nights: 0 }); bad({ nights: 15 }); bad({ nights: '2' });
  bad({ arrival: '' }); bad({ arrival: '2027-02-30' }); bad({ arrival: '14/05/2027' }); bad({ arrival: undefined });
  assert.doesNotThrow(() => M.build({ ...base, language: 'es', channel: 'whatsapp', people: 10, nights: 14 }));
});

test('the name is tidied: one line, at most 80 characters', () => {
  assert.strictEqual(M.cleanName('  Eva \n\t  Smith  '), 'Eva Smith');
  assert.strictEqual(M.cleanName('x'.repeat(200)).length, M.MAX_NAME);
  assert.strictEqual(M.cleanName(null), '');
  const m = M.build({ ...base, language: 'es', channel: 'whatsapp', yourName: 'Eva\nSmith' });
  assert.ok(m.body.endsWith('\nEva Smith'));
});

test('the owner language comes from the stay details, Spanish unless they say French', () => {
  assert.strictEqual(M.languageFor({ lg: 'fr' }), 'fr');
  assert.strictEqual(M.languageFor({}), 'es');
  assert.strictEqual(M.languageFor(null), 'es');
  assert.strictEqual(M.languageFor({ lg: 'de' }), 'es');
});

test('a place can be asked when it has a WhatsApp number or an email address', () => {
  assert.strictEqual(M.canAsk({ wa: '34612345678' }), true);
  assert.strictEqual(M.canAsk({ em: 'a@example.com' }), true);
  assert.strictEqual(M.canAsk({ t: '+34612345678', web: 'https://x.es' }), false);
  assert.strictEqual(M.canAsk({}), false);
  assert.strictEqual(M.canAsk(null), false);
});

test('the WhatsApp and email links keep accents, ampersands, apostrophes and new lines', () => {
  const body = "Éva O'Brien & José\nHello world + one";
  const wa = new URL(M.whatsAppLink('34612345678', body));
  assert.strictEqual(wa.origin + wa.pathname, 'https://wa.me/34612345678');
  assert.strictEqual(wa.searchParams.get('text'), body);
  assert.ok(!wa.search.includes('+') && !wa.search.includes(' '));
  assert.ok(wa.search.includes('%0A'));
  const email = M.emailLink('a@example.com', 'One night', body);
  assert.strictEqual(email.startsWith('mailto:a%40example.com?subject=One%20night&body='), true);
  assert.ok(email.includes('%20') && !email.includes('+'));
  const parsed = new URL(email);
  assert.strictEqual(parsed.searchParams.get('subject'), 'One night');
  assert.strictEqual(parsed.searchParams.get('body'), body);
  assert.strictEqual(M.emailLink('a@example.com'), 'mailto:a%40example.com');
  assert.strictEqual(M.emailLink('a@example.com', null, 'Hi'), 'mailto:a%40example.com?body=Hi');
});

test('links for a bad number or address are refused', () => {
  assert.throws(() => M.whatsAppLink('123', 'x'), RangeError);
  assert.throws(() => M.whatsAppLink('', 'x'), RangeError);
  assert.throws(() => M.whatsAppLink('+34 612 345 678 000 000 000', 'x'), RangeError);
  assert.strictEqual(M.whatsAppLink('+34 612 345 678', 'x'), 'https://wa.me/34612345678?text=x');
  for (const bad of ['bad email', 'a@b', 'a@b.es, c@d.es', '', undefined]) assert.throws(() => M.emailLink(bad, 's', 'b'), RangeError, String(bad));
});

test('a full message with every part, link length stays reasonable', () => {
  const m = M.build({ ...base, language: 'fr', channel: 'whatsapp', people: 3, nights: 5, room: 'room', yourName: 'Éva O\'Brien' });
  const link = M.whatsAppLink('33612345678', m.body);
  assert.ok(link.length < 2200, `${link.length} characters`);
});
