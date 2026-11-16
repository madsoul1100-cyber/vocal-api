import type { GuideLang } from '../guide/playbooks.js'

type L = GuideLang

export const ECOPY = {
  billStart: (lang: L) =>
    lang === 'te'
      ? 'కరెంట్ బిల్లు అర్థం చేసుకుందాం. బిల్లు ఫోటో పంపండి (స్పష్టంగా). లేదా యూనిట్లు, మొత్తం, నెల టైప్ చేయండి. అస్పష్ట సంఖ్యలు నేను ఊహించను.'
      : lang === 'hi'
        ? 'बिजली बिल समझते हैं। बिल की साफ़ फोटो भेजें। या यूनिट, कुल रकम और महीना टाइप करें। धुँधली संख्या मैं नहीं गढ़ूँगी।'
        : 'Let us understand your electricity bill. Send a clear photo of the bill, or type the units, total amount and billing month. I will not guess unclear numbers.',

  notABill: (lang: L) =>
    lang === 'te'
      ? 'ఇది కరెంట్ బిల్లు లాగా కనిపించడం లేదు. దయచేసి బిల్లు ఫోటో పంపండి.'
      : lang === 'hi'
        ? 'यह बिजली बिल नहीं लगता। कृपया बिल की फोटो भेजें।'
        : 'That does not look like an electricity bill. Please send a photo of your bill.',

  unclear: (lang: L, fields: string[]) =>
    lang === 'te'
      ? `కొన్ని అంకెలు స్పష్టంగా చదవలేకపోయాను (${fields.join(', ')}). ఫోటో మళ్లీ పంపండి లేదా సంఖ్య టైప్ చేయండి. నేను ఊహించను.`
      : lang === 'hi'
        ? `कुछ अंक साफ़ नहीं पढ़ सके (${fields.join(', ')})। फोटो फिर भेजें या संख्या टाइप करें। मैं अनुमान से नहीं लिखूँगी।`
        : `I could not read some numbers clearly (${fields.join(', ')}). Please send the photo again or type the number. I will not guess.`,

  confirmPrompt: (lang: L) =>
    lang === 'te'
      ? 'ఇది సరియైతే *Correct* అని చెప్పండి. ఏదైనా తప్పు ఉంటే *Fix units 182* లాగా సరిదిద్దండి.'
      : lang === 'hi'
        ? 'सही हो तो *Correct* लिखें। कुछ गलत हो तो *Fix units 182* जैसे सुधारें।'
        : 'If this is right, reply *Correct*. To change a value, say *Fix units 182* (or total / period).',

  confirmConnection: (lang: L) =>
    lang === 'te'
      ? 'ఇది సరియైతే *Correct* అని చెప్పండి. మార్చాలంటే లొకేషన్ / ఇల్లు-దుకాణం-వ్యవసాయం / kW మళ్లీ చెప్పండి.'
      : lang === 'hi'
        ? 'सही हो तो *Correct* लिखें। बदलना हो तो लोकेशन / घर-दुकान-खेत / kW फिर बताएँ।'
        : 'If this is right, reply *Correct*. To change something, send the location, home/shop/farm, or kW again.',

  unsupportedLang: (lang: L) =>
    lang === 'te'
      ? 'నేను తెలుగు, ఇంగ్లీష్, హిందీలో సహాయం చేస్తాను. ఏ భాషలో కొనసాగాలో చెప్పండి.'
      : lang === 'hi'
        ? 'मैं तेलुगू, अंग्रेज़ी और हिंदी में मदद करती हूँ। किस भाषा में आगे बढ़ें?'
        : 'I can help in Telugu, English or Hindi. Which language should we use?',

  connectionStart: (lang: L) =>
    lang === 'te'
      ? 'కొత్త కరెంట్ కనెక్షన్ అంచనా. మీ లొకేషన్ షేర్ చేయండి (WhatsApp లొకేషన్ లేదా చిరునామా). ఇది సమాచారం మాత్రమే — భరోసా ఆఫీసుకు దరఖాస్తు పంపదు.'
      : lang === 'hi'
        ? 'नए बिजली कनेक्शन का अनुमान। अपना लोकेशन साझा करें (WhatsApp लोकेशन या पता)। यह केवल जानकारी है — भरोसा दफ़्तर में आवेदन नहीं भेजता।'
        : 'New electricity connection estimate. Share your location (WhatsApp pin or address). Bharosa only informs — it submits nothing to any office.',

  askType: (lang: L) =>
    lang === 'te'
      ? 'ఇల్లు, దుకాణం లేదా వ్యవసాయం — ఏది?'
      : lang === 'hi'
        ? 'घर, दुकान या खेत — कौन सा?'
        : 'Is this for a home, shop, or farm?',

  askLoad: (lang: L) =>
    lang === 'te'
      ? 'ఎంత పవర్ కావాలి (kW)? తెలియకపోతే మీరు వాడే పరికరాలు చెప్పండి — నేను సూచన ఇస్తాను.'
      : lang === 'hi'
        ? 'कितनी पावर चाहिए (kW)? पता न हो तो अपने उपकरण बताएँ — मैं सुझाव दूँगी।'
        : 'How much power do you need (kW)? If you are not sure, tell me which appliances you use and I will suggest a load.',

  outsideArea: (lang: L) =>
    lang === 'te'
      ? 'ఈ లొకేషన్ నా కవరేజ్ బయట ఉన్నట్టు ఉంది. మీ విద్యుత్ కార్యాలయంతో చూడండి. అంచనా ఇవ్వను.'
      : lang === 'hi'
        ? 'यह लोकेशन मेरे इलाके से बाहर लगता है। अपने बिजली कार्यालय से जाँचें। मैं अनुमान नहीं दूँगी।'
        : 'This location looks outside the area I cover. Please check with your electricity office. I will not give an estimate.',

  noLocation: (lang: L) =>
    lang === 'te'
      ? 'లొకేషన్ ఇంకా రాలేదు. WhatsApp లొకేషన్ షేర్ చేయండి లేదా చిరునామా టైప్ చేయండి.'
      : lang === 'hi'
        ? 'लोकेशन अभी नहीं मिला। WhatsApp लोकेशन भेजें या पता लिखें।'
        : 'I still need a location. Share a WhatsApp location pin or type the address.',

  noPoleData: (lang: L) =>
    lang === 'te'
      ? 'ఈ చోటుకు పోల్ డేటా నాదగ్గర లేదు. అంచనా ఖర్చు / పోల్ ఊహించను. ప్రక్రియ మరియు ఎవరిని సంప్రదించాలో చెబుతాను.'
      : lang === 'hi'
        ? 'इस जगह का पोल डेटा मेरे पास नहीं। पोल या लागत नहीं गढ़ूँगी। प्रक्रिया और संपर्क बताऊँगी।'
        : 'I do not have pole data for this place yet. I will not invent a pole or a cost. Here is what the process involves and who to contact.',

  notFinalPrice: (lang: L) =>
    lang === 'te'
      ? 'లేదు — ఇది అంతిమ ధర కాదు. తనిఖీ తర్వాత విద్యుత్ కార్యాలయం అధికారిక మొత్తం చెబుతుంది.'
      : lang === 'hi'
        ? 'नहीं — यह अंतिम कीमत नहीं। जाँच के बाद बिजली कार्यालय आधिकारिक राशि बताएगा।'
        : 'No. The electricity office gives the official amount after inspection.',

  cancel: (lang: L) =>
    lang === 'te'
      ? 'సరే, ఈ విద్యుత్ ఫ్లో ఆపేశాను. ఇంకో సహాయం కావాలంటే చెప్పండి.'
      : lang === 'hi'
        ? 'ठीक है, यह बिजली फ़्लो रोक दिया। और मदद चाहिए तो बताइए।'
        : 'Okay, I have stopped this electricity flow. Tell me if you need something else.',
} as const

export const BILL_ACTIONS = (lang: L) => [
  { id: 'correct', label: lang === 'te' ? 'సరియైంది (Correct)' : lang === 'hi' ? 'सही है (Correct)' : 'Correct' },
  { id: 'fix', label: lang === 'te' ? 'సరిదిద్దు (Fix)' : lang === 'hi' ? 'सुधारें (Fix)' : 'Fix a value' },
]

export const CONNECTION_TYPE_ACTIONS = (lang: L) => [
  { id: 'home', label: lang === 'te' ? 'ఇల్లు' : lang === 'hi' ? 'घर' : 'Home' },
  { id: 'shop', label: lang === 'te' ? 'దుకాణం' : lang === 'hi' ? 'दुकान' : 'Shop' },
  { id: 'farm', label: lang === 'te' ? 'వ్యవసాయం' : lang === 'hi' ? 'खेत' : 'Farm' },
]
