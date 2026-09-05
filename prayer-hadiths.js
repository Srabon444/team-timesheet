"use strict";
// Bengali text for the prayer notifications: the heading per prayer, and the reminders that
// rotate one per notification. The app's own UI stays English — this is the only Bengali surface.
//
//! Not translated by hand. Every line is copied verbatim from a published Bengali text:
//!   hadith — https://github.com/fawazahmed0/hadith-api (ben-* editions), isnad chain trimmed
//!   Qur'an — https://api.alquran.cloud/v1/ayah/<ref>/bn.bengali (Muhiuddin Khan)
//! The //* above each entry is its exact source and number, so any line can be checked.
//! Sources are named by collection only: this dataset's numbering does not always match a
//! printed edition, and a wrong number is worse than none.
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
  //* ben-nasai #3991
  { text: "বান্দার থেকে সর্বপ্রথম নামাযের হিসাব নেয়া হবে। আর সর্বাগ্রে মানুষের হত্যার বিচার হবে।", source: "সুনানে নাসাঈ" },
  //* ben-ibnmajah #1078
  { text: "বান্দা ও কুফরের মধ্যে পার্থক্য হলো সালাত (নামায/নামাজ) বর্জন।", source: "সুনানে ইবনে মাজাহ" },
  //* ben-muslim #551
  { text: "পাঁচ ওয়াক্ত সালাত এবং এক জুমুআহ থেকে আরেক জুমুআহ উভয়ের মধ্যবর্তী সময়ের জন্যে কাফফারাহ স্বরূপ।", source: "সহীহ মুসলিম" },
  //* ben-nasai #1137
  { text: "বান্দা আল্লাহ তা’আলার অধিক নিকটবর্তী হয়, যে অবস্থায় সে সিজদারত থাকে। অতএব, তখন তোমরা অধিক দোয়া করতে থাক।", source: "সুনানে নাসাঈ" },
  //* ben-ibnmajah #4210
  { text: "নামায মুমিনের নূর (আলো) এবং রোযা জাহান্নাম থেকে আত্মরক্ষার ঢাল।", source: "সুনানে ইবনে মাজাহ" },
  //* ben-ibnmajah #428
  { text: "কষ্টের সময় পূর্ণাঙ্গভাবে উযূ (ওজু/অজু/অযু) করা, মসজিদে যাতায়াত করা এবং এক ওয়াক্তের সালাত আদায়ের পর পরবর্তী ওয়াক্তের সালাতের জন্য অপেক্ষারত থাকা (এই তিনটি কাজ) গুনাহসমূহের কাফফারাস্বরূপ।", source: "সুনানে ইবনে মাজাহ" },
  //* ben-ibnmajah #798
  { text: "যে ব্যাক্তি মসজিদে এসে জামাআতের সাথে চল্লিশ রাত তাকবীরে ঊলাসহ এশার সালাত পড়বে, তার বিনিময়ে আল্লাহ জাহান্নাম থেকে তার মুক্তির সনদ লিখে দেন।", source: "সুনানে ইবনে মাজাহ" },
  //* ben-ibnmajah #275
  { text: "পবিত্রতা হল সালাতের চাবি, তার তাকবীর হল হারামকারী এবং তার সালাম হল হালালকারী।", source: "সুনানে ইবনে মাজাহ" },
  //* ben-ibnmajah #1141
  { text: "যে ব্যক্তি দিনে বারো রাকআত (সুন্নাত) সালাত (নামায/নামাজ) পড়লো, তার জন্য জান্নাতে একটি প্রাসা’দ নির্মাণ করা হয়।", source: "সুনানে ইবনে মাজাহ" },
  //* ben-muslim #1476
  { text: "ইমামের সাথে এক ওয়াক্ত সালাত আদায় করা একাকী পঁচিশ ওয়াক্ত সালাত আদায় করার চেয়েও উত্তম।", source: "সহীহ মুসলিম" },
  //* ben-nasai #463
  { text: "আমাদের এবং কাফিরদের মধ্যে পার্থক্যকারী আমল হল সালাত। যে সালাত ছেড়ে দিল সে কুফরী করল।", source: "সুনানে নাসাঈ" },
  //* alquran.cloud bn.bengali 20:14
  { text: "আমিই আল্লাহ আমি ব্যতীত কোন ইলাহ নেই। অতএব আমার এবাদত কর এবং আমার স্মরণার্থে নামায কায়েম কর।", source: "কুরআন ২০:১৪" },
  //* alquran.cloud bn.bengali 29:45
  { text: "আপনি আপনার প্রতি প্রত্যাদিষ্ট কিতাব পাঠ করুন এবং নামায কায়েম করুন। নিশ্চয় নামায অশ্লীল ও গর্হিত কার্য থেকে বিরত রাখে। আল্লাহর স্মরণ সর্বশ্রেষ্ঠ। আল্লাহ জানেন তোমরা যা কর।", source: "কুরআন ২৯:৪৫" },
  //* alquran.cloud bn.bengali 2:45
  { text: "ধৈর্য্যর সাথে সাহায্য প্রার্থনা কর নামাযের মাধ্যমে। অবশ্য তা যথেষ্ট কঠিন। কিন্তু সে সমস্ত বিনয়ী লোকদের পক্ষেই তা সম্ভব।", source: "কুরআন ২:৪৫" },
  //* alquran.cloud bn.bengali 2:238
  { text: "সমস্ত নামাযের প্রতি যত্নবান হও, বিশেষ করে মধ্যবর্তী নামাযের ব্যাপারে। আর আল্লাহর সামনে একান্ত আদবের সাথে দাঁড়াও।", source: "কুরআন ২:২৩৮" },
  //* alquran.cloud bn.bengali 2:110
  { text: "তোমরা নামায প্রতিষ্ঠা কর এবং যাকাত দাও। তোমরা নিজের জন্যে পূর্বে যে সৎকর্ম প্রেরণ করবে, তা আল্লাহর কাছে পাবে। তোমরা যা কিছু কর, নিশ্চয় আল্লাহ তা প্রত্যক্ষ করেন।", source: "কুরআন ২:১১০" },
];

// Rotates rather than picking at random, so the same reminder can't land twice in a row.
function prayerReminderAt(index) {
  const list = PRAYER_REMINDERS;
  return list[((index % list.length) + list.length) % list.length];
}
