"use strict";
// Bengali text for the prayer notifications: the heading per prayer, and the short reminders that
// rotate one per notification. The app's own UI stays English — this is the only Bengali surface.
//
//! Attributions name the collection only, never a hadith number — numbering differs between
//! editions and a wrong number is worse than no number. Qur'an references are surah:ayah.
//! These are plain Bengali renderings, not certified translations; have someone review them.
//
// Plain-script global to match popup.js/gdrive.js; also importScripts()'d by background.js.

//! Bengali takes a different genitive per name (ফজরের but এশার), so the whole heading is stored
//! rather than built from a name plus a suffix.
const PRAYER_HEADINGS = {
  Fajr: "ফজরের ওয়াক্ত হয়েছে",
  Dhuhr: "জোহরের ওয়াক্ত হয়েছে",
  Asr: "আসরের ওয়াক্ত হয়েছে",
  Maghrib: "মাগরিবের ওয়াক্ত হয়েছে",
  Isha: "এশার ওয়াক্ত হয়েছে",
};

const PRAYER_REMINDERS = [
  { text: "কিয়ামতের দিন বান্দার কাছে সর্বপ্রথম নামাজের হিসাব নেওয়া হবে।", source: "সুনানে তিরমিযী" },
  { text: "আমার স্মরণে নামাজ কায়েম করো।", source: "কুরআন ২০:১৪" },
  { text: "নিশ্চয়ই নামাজ অশ্লীল ও মন্দ কাজ থেকে বিরত রাখে।", source: "কুরআন ২৯:৪৫" },
  { text: "ধৈর্য ও নামাজের মাধ্যমে সাহায্য চাও।", source: "কুরআন ২:৪৫" },
  { text: "আমার চোখের শীতলতা রাখা হয়েছে নামাজের মধ্যে।", source: "সুনানে নাসাঈ" },
  { text: "জান্নাতের চাবি হলো নামাজ।", source: "সুনানে তিরমিযী" },
  { text: "বান্দা তার রবের সবচেয়ে নিকটে থাকে সিজদার অবস্থায়।", source: "সহীহ মুসলিম" },
  { text: "পাঁচ ওয়াক্ত নামাজ গুনাহ ধুয়ে দেয়, যেমন পানি ময়লা ধুয়ে দেয়।", source: "সহীহ বুখারী" },
  { text: "তোমাদের কেউ যখন নামাজে দাঁড়ায়, সে তার রবের সাথে কথা বলে।", source: "সহীহ বুখারী" },
  { text: "আল্লাহর কাছে সবচেয়ে প্রিয় আমল হলো সময়মতো আদায় করা নামাজ।", source: "সহীহ বুখারী" },
  { text: "নামাজ হলো নূর।", source: "সহীহ মুসলিম" },
  { text: "যে নামাজের হেফাজত করবে, কিয়ামতের দিন তা তার জন্য নূর ও মুক্তি হবে।", source: "মুসনাদে আহমাদ" },
  { text: "তোমরা নামাজ কায়েম করো এবং যাকাত দাও।", source: "কুরআন ২:১১০" },
  { text: "নিশ্চয়ই সফল হয়েছে সেই মুমিনরা, যারা নিজেদের নামাজে বিনয়াবনত।", source: "কুরআন ২৩:১-২" },
  { text: "তোমরা নামাজের হেফাজত করো, বিশেষ করে মধ্যবর্তী নামাজের।", source: "কুরআন ২:২৩৮" },
];

// Rotates rather than picking at random, so the same reminder can't land twice in a row.
function prayerReminderAt(index) {
  const list = PRAYER_REMINDERS;
  return list[((index % list.length) + list.length) % list.length];
}
