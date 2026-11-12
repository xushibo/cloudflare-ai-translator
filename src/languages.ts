// Codes from Immersive Translate's custom API specification. Availability of a
// code is protocol support, not a guarantee of model quality for that language.
export const LANGUAGES: Record<string, string> = {
  af: "Afrikaans", am: "Amharic", ar: "Arabic", az: "Azerbaijani", be: "Belarusian",
  bg: "Bulgarian", tn: "Tswana", bn: "Bengali", bs: "Bosnian", ca: "Catalan",
  ceb: "Cebuano", co: "Corsican", cs: "Czech", cy: "Welsh", da: "Danish",
  de: "German", el: "Greek", en: "English", eo: "Esperanto", es: "Spanish",
  et: "Estonian", eu: "Basque", fa: "Persian", fi: "Finnish", fil: "Filipino",
  fj: "Fijian", fr: "French", fy: "Frisian", ga: "Irish", gd: "Scottish Gaelic",
  gl: "Galician", gu: "Gujarati", ha: "Hausa", haw: "Hawaiian", he: "Hebrew",
  hi: "Hindi", hmn: "Hmong", hr: "Croatian", ht: "Haitian Creole", hu: "Hungarian",
  hy: "Armenian", id: "Indonesian", ig: "Igbo", is: "Icelandic", it: "Italian",
  ja: "Japanese", jw: "Javanese", ka: "Georgian", kk: "Kazakh", km: "Khmer",
  kn: "Kannada", ko: "Korean", ku: "Kurdish", ky: "Kyrgyz", la: "Latin",
  lb: "Luxembourgish", lo: "Lao", lt: "Lithuanian", lv: "Latvian", mg: "Malagasy",
  mi: "Maori", mk: "Macedonian", ml: "Malayalam", mn: "Mongolian", mr: "Marathi",
  ms: "Malay", mt: "Maltese", mww: "Hmong Daw", my: "Burmese", ne: "Nepali",
  nl: "Dutch", no: "Norwegian", ny: "Chichewa", otq: "Queretaro Otomi", pa: "Punjabi",
  pl: "Polish", ps: "Pashto", pt: "Portuguese", ro: "Romanian", ru: "Russian",
  sd: "Sindhi", si: "Sinhala", sk: "Slovak", sl: "Slovenian", sm: "Samoan",
  sn: "Shona", so: "Somali", sq: "Albanian", sr: "Serbian", "sr-Cyrl": "Serbian in Cyrillic script",
  "sr-Latn": "Serbian in Latin script", st: "Sesotho", su: "Sundanese", sv: "Swedish", sw: "Swahili",
  ta: "Tamil", te: "Telugu", tg: "Tajik", th: "Thai", tlh: "Klingon",
  "tlh-Qaak": "Klingon in pIqaD script", to: "Tongan", tr: "Turkish", ty: "Tahitian",
  ug: "Uyghur", uk: "Ukrainian", ur: "Urdu", uz: "Uzbek", vi: "Vietnamese",
  wyw: "Classical Chinese", xh: "Xhosa", yi: "Yiddish", yo: "Yoruba", yua: "Yucatec Maya",
  yue: "Cantonese in Traditional Chinese characters", "zh-CN": "Simplified Chinese",
  "zh-TW": "Traditional Chinese", zu: "Zulu",
  // Regional extensions retained for existing clients.
  "en-US": "American English", "en-GB": "British English",
  "pt-BR": "Brazilian Portuguese", "pt-PT": "European Portuguese",
};

const CANONICAL = new Map(Object.keys(LANGUAGES).map(code => [code.toLowerCase(), code]));
const ALIASES: Record<string, string> = {
  zh: "zh-CN", "zh-hans": "zh-CN", "zh-hant": "zh-TW", "zh-hk": "zh-TW",
  nb: "no", jv: "jw", tl: "fil",
};

export function normalizeLanguage(value: string): string | undefined {
  const code = value.trim().toLowerCase().replaceAll("_", "-");
  return CANONICAL.get(code) ?? (Object.hasOwn(ALIASES, code) ? ALIASES[code] : undefined);
}
