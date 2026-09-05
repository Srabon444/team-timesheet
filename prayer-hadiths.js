"use strict";
// Short reminders shown with each prayer notification, rotating one per notification.
//
//! Attributions name the collection only, never a hadith number — numbering differs between
//! editions and a wrong number is worse than no number. Qur'an references are surah:ayah.
//! These are paraphrases in common English circulation, not certified translations; have someone
//! review them before this ships widely.
//
// Plain-script global to match popup.js/gdrive.js; also importScripts()'d by background.js.

const PRAYER_REMINDERS = [
  { text: "The first thing a servant will be asked about on the Day of Judgement is the prayer.", source: "Sunan al-Tirmidhi" },
  { text: "Establish prayer for My remembrance.", source: "Qur'an 20:14" },
  { text: "Indeed, prayer restrains from immorality and wrongdoing.", source: "Qur'an 29:45" },
  { text: "Seek help through patience and prayer.", source: "Qur'an 2:45" },
  { text: "The coolness of my eyes has been placed in prayer.", source: "Sunan al-Nasa'i" },
  { text: "The key to Paradise is prayer.", source: "Sunan al-Tirmidhi" },
  { text: "The closest a servant is to his Lord is while he is in prostration.", source: "Sahih Muslim" },
  { text: "The five daily prayers wash away sins as water washes away dirt.", source: "Sahih al-Bukhari" },
  { text: "When one of you prays, he is in conversation with his Lord.", source: "Sahih al-Bukhari" },
  { text: "The deed most beloved to Allah is prayer offered at its proper time.", source: "Sahih al-Bukhari" },
  { text: "Prayer is light.", source: "Sahih Muslim" },
  { text: "Whoever guards the prayer, it will be light and proof and salvation for him.", source: "Musnad Ahmad" },
  { text: "And be steadfast in prayer, and give charity.", source: "Qur'an 2:110" },
  { text: "Successful indeed are the believers, those who humble themselves in their prayer.", source: "Qur'an 23:1-2" },
  { text: "Guard strictly the prayers, especially the middle prayer.", source: "Qur'an 2:238" },
];

// Rotates rather than picking at random, so the same reminder can't land twice in a row.
function prayerReminderAt(index) {
  const list = PRAYER_REMINDERS;
  return list[((index % list.length) + list.length) % list.length];
}
