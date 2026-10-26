/**
 * Telangana help playbooks. Facts below are the only official steps and
 * contacts the guide agent may state. Phone numbers and URLs were taken
 * from the department's own pages (or, where noted, from the page that
 * publishes them). If a fee or screen name can change, the step says so
 * and points at the official site instead of inventing a figure.
 */

export type GuideLang = 'te' | 'en' | 'hi'

export interface GuideContact {
  name: string
  phone?: string
  url?: string
  email?: string
  /** Who this contact is for. */
  covers: string
}

export interface Playbook {
  id: string
  mode: 'self_serve' | 'department'
  titles: Record<GuideLang, string>
  keywords: string[]
  steps: Record<GuideLang, string[]>
  contacts: GuideContact[]
  sources: string[]
}

const UIDAI: GuideContact = {
  name: 'UIDAI',
  phone: '1947',
  url: 'https://myaadhaar.uidai.gov.in',
  covers: 'Aadhaar updates across India, including Telangana',
}

const TGSPDCL: GuideContact = {
  name: 'TGSPDCL (southern power, including Hyderabad)',
  phone: '1912',
  url: 'https://tgsouthernpower.org',
  covers: 'Hyderabad, Rangareddy, Medchal-Malkajgiri, Vikarabad, Sangareddy, Medak, Siddipet, Yadadri Bhuvanagiri, Nalgonda, Suryapet, Mahabubnagar, Nagarkurnool, Wanaparthy, Narayanpet, Jogulamba Gadwal',
}

const TGNPDCL: GuideContact = {
  name: 'TGNPDCL (northern power)',
  phone: '1912',
  url: 'https://tgnpdcl.com',
  covers: 'Warangal, Hanamkonda, Jangaon, Mahabubabad, Jayashankar Bhupalpally, Mulugu, Bhadradri Kothagudem, Khammam, Nizamabad, Kamareddy, Karimnagar, Peddapalli, Rajanna Sircilla, Jagtial, Adilabad, Nirmal, Mancherial, Komaram Bheem Asifabad. Also 18004250028.',
}

const HMWSSB: GuideContact = {
  name: 'HMWSSB (Hyderabad water and sewerage)',
  phone: '155313',
  url: 'https://www.hyderabadwater.gov.in',
  covers: 'Hyderabad metropolitan water supply and sewerage. Also published: 040-23300114.',
}

const GHMC: GuideContact = {
  name: 'GHMC',
  phone: '21111111',
  url: 'https://www.ghmc.gov.in',
  covers: 'Greater Hyderabad: roads, garbage, street lights, open drains. Head office 040-23225397.',
}

const MEESEVA: GuideContact = {
  name: 'MeeSeva',
  url: 'https://meeseva.telangana.gov.in',
  covers: 'Certificates and many state services. Track with the application number on the home page.',
}

const PRAJAVANI: GuideContact = {
  name: 'Prajavani (Praja Bhavan)',
  url: 'https://prajavani.cgg.gov.in',
  email: 'support.prajavani@cgg.gov.in',
  covers: 'Any Telangana government grievance. Petitions are taken in person at Mahatma Jyothiba Phule Praja Bhavan on Tuesday and Friday. Track with the mobile number or reference number.',
}

const EPDS: GuideContact = {
  name: 'Telangana food security cards (ePDS)',
  phone: '1967',
  url: 'https://epds.telangana.gov.in/FoodSecurityAct/',
  covers: 'Ration / food security card. The same site also publishes 180042500333.',
}

export const PLAYBOOKS: Playbook[] = [
  {
    id: 'aadhaar_mobile',
    mode: 'self_serve',
    titles: {
      en: 'Change the mobile number on Aadhaar',
      te: 'ఆధార్‌లో మొబైల్ నంబర్ మార్చడం',
      hi: 'आधार पर मोबाइल नंबर बदलना',
    },
    keywords: [
      'aadhaar mobile', 'aadhar mobile', 'aadhaar phone', 'aadhar phone', 'change number aadhaar', 'update mobile aadhaar',
      'aadhaar number change', 'ఆధార్', 'ఆధార్ మొబైల్', 'ఆధార్ నంబర్', 'ఫోన్ నంబర్ ఆధార్',
      'आधार मोबाइल', 'आधार नंबर', 'आधार फोन',
    ],
    steps: {
      en: [
        'The person wants the mobile number changed on the website or in the Aadhaar app, without calling 1947. Mobile Number Update does not ask for a document or a parent’s Aadhaar. Sign in, open Services, then Mobile Number Update, enter the new number, confirm the OTP on that new number, complete face authentication, and pay the fee shown in the app.',
        'If the app is signed in with a different number from the one saved on Aadhaar, confirm the OTP on the old number and the new number, then do face authentication.',
        'If the person says they already see two options, any document, an electricity bill, or a family Aadhaar, answer that screen. Do not tell them to go back. Explain both paths in the same reply. Path one, a document in their own name: upload a JPG, PNG, or PDF. UIDAI accepts an electricity, water, gas, landline, or post-paid mobile bill not older than 3 months, and also a passport, voter ID, or ration card, when their name and the address are on it. They type that same address, check the English and local-language preview, complete face authentication, pay the ₹75 shown, and save the SRN. Path two, no document in their name: Family Member’s Aadhaar. They must live at the same address as their father or mother. Enter that parent’s Aadhaar number, choose the relation, complete face authentication, and pay ₹75. The parent opens their own Aadhaar app, Services, Family Member Request, enters the SRN, and approves. They do not visit a centre together unless the parent cannot approve in the app.',
        'On that address screen there are two ways, and both are done in the app. With your own document: upload a JPG, PNG, or PDF in your name. UIDAI accepts an electricity, water, gas, landline, or post-paid mobile bill not older than 3 months, and also a passport, voter ID, or ration card, when your name and the address are on it. Type that same address, check the English and local-language preview, complete face authentication, and pay the ₹75 shown in the app. Save the SRN on the acknowledgement.',
        'With no document in your name: choose Family Member’s Aadhaar. You must live at the same address as your father or mother. Enter that parent’s Aadhaar number, choose the relation, complete face authentication, and pay ₹75. Your parent then opens their own Aadhaar app, goes to Services, Family Member Request, enters the SRN, and approves. The online path does not need a centre visit together. If the parent cannot approve in the app, go together to an Aadhaar centre with the parent’s Aadhaar.',
        'If the old mobile number is lost and was never available for the OTP, UIDAI does not allow that mobile change only online. An Aadhaar Seva Kendra can update the mobile number, and UIDAI says no document is required for that mobile update. 1947 is only for when the app will not continue. Never share the OTP.',
      ],
      te: [
        'మొబైల్ నంబర్ మార్పు కాల్ లేకుండా యాప్‌లోనే అవుతుంది. Mobile Number Update కు పత్రం లేదా తల్లిదండ్రుల ఆధార్ అవసరం లేదు. సైన్ ఇన్ చేసి, Services → Mobile Number Update, కొత్త నంబర్, ఆ నంబర్‌కు వచ్చిన OTP, ఫేస్ ఆథెంటికేషన్, యాప్ చూపించే రుసుము.',
        'యాప్‌లోని నంబర్ ఆధార్‌లోని నంబర్ కాకపోతే పాత నంబర్ మరియు కొత్త నంబర్ రెండింటికీ OTP, తర్వాత ఫేస్ ఆథెంటికేషన్.',
        'వారు రెండు ఆప్షన్లు చూస్తున్నారని చెబితే, వెనక్కి వెళ్లమని చెప్పకండి. ఆ రెండు దారులూ ఇప్పుడే చెప్పండి. పత్రం దారి మరియు తల్లి లేదా తండ్రి ఆధార్ దారి రెండూ కింద ఉన్నాయి.',
        'చిరునామా స్క్రీన్‌లో రెండు దారులు. మీ పేరున పత్రం: JPG, PNG లేదా PDF అప్‌లోడ్ చేయండి. 3 నెలల్లోపు కరెంట్, నీళ్లు, గ్యాస్, ల్యాండ్‌లైన్ లేదా పోస్ట్‌పెయిడ్ మొబైల్ బిల్లు, లేదా పాస్‌పోర్ట్, ఓటరు ఐడీ, రేషన్ కార్డు, మీ పేరు మరియు చిరునామా ఉంటే సరిపోతాయి. అదే చిరునామా టైప్ చేసి, ఇంగ్లీషు మరియు స్థానిక భాష చూసి, ఫేస్ ఆథెంటికేషన్ చేసి, యాప్‌లో కనిపించే ₹75 చెల్లించి, SRN దాచుకోండి.',
        'మీ పేరున పత్రం లేకపోతే Family Member’s Aadhaar. తల్లి లేదా తండ్రి అదే చిరునామాలో ఉండాలి. వారి ఆధార్ నంబర్, బంధుత్వం, ఫేస్ ఆథెంటికేషన్, ₹75. తర్వాత వారు తమ ఆధార్ యాప్‌లో Services → Family Member Request → SRN → Approve చేయాలి. ఆన్‌లైన్‌కు కలిసి కేంద్రానికి వెళ్లాల్సిన అవసరం లేదు. యాప్‌లో ఆమోదం కుదరకపోతే తల్లి లేదా తండ్రి ఆధార్‌తో కలిసి కేంద్రానికి వెళ్లండి.',
        'పాత నంబర్ పూర్తిగా లేక OTP రాకపోతే ఆ మొబైల్ మార్పు కేవలం ఆన్‌లైన్‌లో కాదు. ఆధార్ సేవా కేంద్రంలో చేయవచ్చు. ఆ మొబైల్ మార్పుకు పత్రం అవసరం లేదని UIDAI చెప్పింది. యాప్ ఆగిపోతేనే 1947. OTP పంచుకోవద్దు.',
      ],
      hi: [
        'मोबाइल नंबर बिना कॉल के ऐप में बदलता है। Mobile Number Update में दस्तावेज़ या माता-पिता का आधार नहीं माँगा जाता। साइन इन करें, Services → Mobile Number Update, नया नंबर, उसी नंबर पर OTP, फेस ऑथेंटिकेशन, और ऐप में दिखी फीस।',
        'ऐप वाला नंबर आधार वाले नंबर से अलग हो तो पुराने और नए दोनों पर OTP, फिर फेस ऑथेंटिकेशन।',
        'अगर वे कहें कि दो विकल्प दिख रहे हैं, तो वापस जाने को न कहें। दोनों रास्ते अभी समझाएँ। दस्तावेज़ वाला रास्ता और माता या पिता के आधार वाला रास्ता नीचे दिए हैं।',
        'पते की स्क्रीन पर दो रास्ते हैं। अपने नाम का दस्तावेज़: JPG, PNG या PDF अपलोड करें। 3 महीने से नया बिजली, पानी, गैस, लैंडलाइन या पोस्टपेड मोबाइल बिल, या पासपोर्ट, वोटर आईडी, राशन कार्ड, जब उस पर आपका नाम और पता हो। वही पता लिखें, अंग्रेज़ी और स्थानीय भाषा जाँचें, फेस ऑथेंटिकेशन करें, ऐप में दिखे ₹75 भरें, SRN रखें।',
        'अपने नाम का दस्तावेज़ न हो तो Family Member’s Aadhaar। माता या पिता उसी पते पर रहते हों। उनका आधार नंबर, रिश्ता, फेस ऑथेंटिकेशन, ₹75। फिर वे अपने आधार ऐप में Services → Family Member Request → SRN → Approve करें। ऑनलाइन रास्ते में साथ में केंद्र जाने की ज़रूरत नहीं। ऐप पर मंज़ूरी न हो पाए तभी माता या पिता का आधार लेकर साथ में केंद्र जाएँ।',
        'पुराना नंबर बिल्कुल नहीं है और OTP नहीं आ रहा, तो वह मोबाइल बदलाव केवल ऑनलाइन नहीं होता। आधार सेवा केंद्र पर हो जाता है। UIDAI के अनुसार उस मोबाइल अपडेट के लिए दस्तावेज़ नहीं चाहिए। 1947 तभी जब ऐप आगे न बढ़े। OTP साझा न करें।',
      ],
    },
    contacts: [UIDAI],
    sources: [
      'https://uidai.gov.in/en/1474-english-uk/faqs/your-aadhaar/aadhaar-app/19854-how-to-update-a-mobile-number-through-the-aadhaar-app.html',
      'https://myaadhaar.uidai.gov.in',
    ],
  },
  {
    id: 'aadhaar_address',
    mode: 'self_serve',
    titles: {
      en: 'Change the address on Aadhaar',
      te: 'ఆధార్‌లో చిరునామా మార్చడం',
      hi: 'आधार पर पता बदलना',
    },
    keywords: [
      'aadhaar address', 'aadhar address', 'update address aadhaar', 'change address aadhaar',
      'ఆధార్ చిరునామా', 'ఆధార్ అడ్రస్', 'చిరునామా మార్చాలి',
      'आधार पता', 'आधार एड्रेस', 'पता बदलना आधार',
    ],
    steps: {
      en: [
        'Online update needs the mobile number already registered on Aadhaar.',
        'In the Aadhaar app go to Services, then Address Update. Upload a proof of address in your name (JPG, PNG, or PDF), type the new address, check the English and local-language preview, complete face authentication, and pay the fee shown there. UIDAI’s own app steps show ₹75 for this update.',
        'The same request can be filed at https://myaadhaar.uidai.gov.in. The address is typed in English and then shown in Telugu, Hindi, or the other listed language so you can correct the spelling.',
        'Download the acknowledgement and note the SRN (service request number). It also comes by SMS. Track it on myAadhaar under Check Aadhaar Update Status. Processing can take up to 30 days.',
        'The request is rejected if the document is not in the accepted list, is not in your name, or the address you typed does not match the document.',
        'If no mobile is registered, visit an Aadhaar enrolment centre. Centres are listed at https://bhuvan-app3.nrsc.gov.in/aadhaar/. Helpline 1947.',
      ],
      te: [
        'ఆన్‌లైన్ అప్‌డేట్‌కు ఆధార్‌కు లింక్ అయిన మొబైల్ నంబర్ ఉండాలి.',
        'ఆధార్ యాప్‌లో Services → Address Update. మీ పేరున ఉన్న చిరునామా రుజువు (JPG, PNG లేదా PDF) అప్‌లోడ్ చేసి, కొత్త చిరునామా టైప్ చేసి, ఇంగ్లీషు మరియు స్థానిక భాష ప్రివ్యూ చూసి, ఫేస్ ఆథెంటికేషన్ చేయండి. UIDAI యాప్ సూచనల్లో ఈ అప్‌డేట్ రుసుము ₹75.',
        'అదే పని https://myaadhaar.uidai.gov.in లో కూడా చేయవచ్చు. చిరునామా ఇంగ్లీషులో టైప్ చేస్తే తెలుగు లేదా హిందీలో కనిపిస్తుంది. అక్షరాలు సరిచూసుకోండి.',
        'SRN నంబర్‌ను దాచుకోండి. SMS కూడా వస్తుంది. myAadhaar లో Check Aadhaar Update Status లో చూడండి. 30 రోజుల వరకు పట్టవచ్చు.',
        'పత్రం చెల్లుబాటు కాకపోతే, మీ పేరున లేకపోతే, లేదా టైప్ చేసిన చిరునామా పత్రంతో కలవకపోతే అభ్యర్థన తిరస్కరించబడుతుంది.',
        'మొబైల్ లింక్ లేకపోతే ఆధార్ కేంద్రానికి వెళ్లండి. కేంద్రాలు: https://bhuvan-app3.nrsc.gov.in/aadhaar/ . హెల్ప్‌లైన్ 1947.',
      ],
      hi: [
        'ऑनलाइन अपडेट के लिए आधार पर मोबाइल नंबर पहले से दर्ज होना चाहिए।',
        'आधार ऐप में Services → Address Update। अपने नाम का पते का प्रमाण (JPG, PNG या PDF) अपलोड करें, नया पता लिखें, अंग्रेज़ी और स्थानीय भाषा की झलक जाँचें, फेस ऑथेंटिकेशन करें। UIDAI के ऐप निर्देशों में इस अपडेट की फीस ₹75 है।',
        'यही काम https://myaadhaar.uidai.gov.in पर भी होता है। पता अंग्रेज़ी में लिखने पर तेलुगु या हिन्दी में दिखता है। वर्तनी जाँच लें।',
        'SRN नंबर रखें। SMS भी आता है। स्थिति myAadhaar पर Check Aadhaar Update Status में देखें। 30 दिन तक लग सकते हैं।',
        'दस्तावेज़ मान्य नहीं है, आपके नाम पर नहीं है, या लिखा पता दस्तावेज़ से नहीं मिलता, तो आवेदन रद्द हो जाता है।',
        'मोबाइल दर्ज नहीं है तो आधार केंद्र जाएँ। केंद्र: https://bhuvan-app3.nrsc.gov.in/aadhaar/ । हेल्पलाइन 1947।',
      ],
    },
    contacts: [UIDAI],
    sources: [
      'https://uidai.gov.in/en/aadhaar-app-faq',
      'https://uidai.gov.in/en/updating-data-on-aadhaar',
      'https://myaadhaar.uidai.gov.in',
    ],
  },
  {
    id: 'aadhaar_name_dob',
    mode: 'self_serve',
    titles: {
      en: 'Correct name or date of birth on Aadhaar',
      te: 'ఆధార్‌లో పేరు లేదా పుట్టిన తేదీ సరిచేయడం',
      hi: 'आधार पर नाम या जन्मतिथि सुधारना',
    },
    keywords: [
      'aadhaar name', 'aadhar name', 'date of birth aadhaar', 'dob aadhaar', 'correct aadhaar',
      'ఆధార్ పేరు', 'పుట్టిన తేదీ', 'ఆధార్ పేరు తప్పు',
      'आधार नाम', 'जन्मतिथि आधार', 'आधार में नाम गलत',
    ],
    steps: {
      en: [
        'Name, date of birth, and gender are updated at an Aadhaar enrolment or update centre, with a proof of identity in your name.',
        'Carry the original document. The operator checks it at the centre and gives you an acknowledgement with a URN or enrolment id.',
        'Track that number on https://myaadhaar.uidai.gov.in. Pay only the fee collected at the authorised centre.',
        'If a centre refuses a document that is on UIDAI’s accepted list, call 1947 and note the centre name.',
      ],
      te: [
        'పేరు, పుట్టిన తేదీ, లింగం మార్పులు ఆధార్ ఎన్‌రోల్‌మెంట్ లేదా అప్‌డేట్ కేంద్రంలో, మీ పేరున ఉన్న గుర్తింపు పత్రంతో చేయాలి.',
        'అసలు పత్రం తీసుకెళ్లండి. ఆపరేటర్ అక్కడే చూసి, URN లేదా ఎన్‌రోల్‌మెంట్ ఐడీతో రసీదు ఇస్తారు.',
        'ఆ నంబర్‌ను https://myaadhaar.uidai.gov.in లో ట్రాక్ చేయండి. అధికార కేంద్రంలో చెప్పిన రుసుము మాత్రమే చెల్లించండి.',
        'UIDAI జాబితాలో ఉన్న పత్రాన్ని కేంద్రం తిరస్కరిస్తే 1947 కు కాల్ చేసి, కేంద్రం పేరు రాసుకోండి.',
      ],
      hi: [
        'नाम, जन्मतिथि और लिंग आधार नामांकन या अपडेट केंद्र पर, अपने नाम के पहचान प्रमाण के साथ बदलते हैं।',
        'मूल दस्तावेज़ ले जाएँ। ऑपरेटर वहीं जाँचकर URN या एनरोलमेंट आईडी वाली रसीद देता है।',
        'उस नंबर को https://myaadhaar.uidai.gov.in पर ट्रैक करें। केवल अधिकृत केंद्र की फीस दें।',
        'UIDAI की सूची वाला दस्तावेज़ केंद्र मानने से मना करे तो 1947 पर कॉल करें और केंद्र का नाम नोट करें।',
      ],
    },
    contacts: [UIDAI],
    sources: ['https://uidai.gov.in/en/updating-data-on-aadhaar'],
  },
  {
    id: 'pan_correction',
    mode: 'self_serve',
    titles: {
      en: 'PAN: apply, correct, or link with Aadhaar',
      te: 'పాన్: దరఖాస్తు, సవరణ, లేదా ఆధార్‌తో లింక్',
      hi: 'पैन: आवेदन, सुधार, या आधार से लिंक',
    },
    keywords: [
      'pan card', 'pan correction', 'link pan', 'pan aadhaar', 'income tax pan',
      'పాన్ కార్డ్', 'పాన్ ఆధార్', 'పాన్ లింక్',
      'पैन कार्ड', 'पैन आधार', 'पैन लिंक',
    ],
    steps: {
      en: [
        'A new PAN or a correction (name, date of birth, address, photo) is filed on Protean at https://www.onlineservices.nsdl.com or on UTIITSL at https://www.pan.utiitsl.com. Use only these sites.',
        'Keep the acknowledgement number. Status is checked on the same site.',
        'To link PAN with Aadhaar, sign in at https://www.incometax.gov.in and use the PAN-Aadhaar linking option. The mobile on Aadhaar must be working, because the OTP goes there.',
        'If the correction is rejected, read the reason on the acknowledgement and file again with a document that matches the PAN. The phone number to call is the one printed on https://www.incometax.gov.in under Contact Us. Do not use a number sent by SMS.',
      ],
      te: [
        'కొత్త పాన్ లేదా సవరణ (పేరు, పుట్టిన తేదీ, చిరునామా, ఫోటో) https://www.onlineservices.nsdl.com (Protean) లేదా https://www.pan.utiitsl.com (UTIITSL) లో మాత్రమే పెట్టండి.',
        'అక్నాలెడ్జ్‌మెంట్ నంబర్ దాచుకోండి. స్టేటస్ అదే సైట్‌లో చూడండి.',
        'పాన్‌ను ఆధార్‌తో లింక్ చేయాలంటే https://www.incometax.gov.in లో లాగిన్ అయి PAN-Aadhaar linking వాడండి. OTP ఆధార్‌కు ఉన్న మొబైల్‌కు వెళ్తుంది.',
        'తిరస్కరణ వస్తే కారణం చదివి, పాన్‌తో సరిపోయే పత్రంతో మళ్లీ పెట్టండి. ఫోన్ నంబర్ https://www.incometax.gov.in లో Contact Us లో ఉన్నదే వాడండి. SMS లో వచ్చిన నంబర్‌కు కాల్ చేయవద్దు.',
      ],
      hi: [
        'नया पैन या सुधार (नाम, जन्मतिथि, पता, फोटो) केवल https://www.onlineservices.nsdl.com (Protean) या https://www.pan.utiitsl.com (UTIITSL) पर करें।',
        'आवेदन संख्या रखें। स्थिति उसी साइट पर देखें।',
        'पैन को आधार से जोड़ने के लिए https://www.incometax.gov.in पर लॉग इन कर PAN-Aadhaar linking खोलें। OTP आधार वाले मोबाइल पर जाता है।',
        'अस्वीकृति का कारण पढ़कर मेल खाता दस्तावेज़ लगाकर दोबारा करें। फोन नंबर वही लें जो https://www.incometax.gov.in के Contact Us पर छपा है। SMS वाले नंबर पर कॉल न करें।',
      ],
    },
    contacts: [
      { name: 'Income Tax e-filing', url: 'https://www.incometax.gov.in', covers: 'PAN-Aadhaar link and e-filing contact numbers' },
      { name: 'Protean PAN', url: 'https://www.onlineservices.nsdl.com', covers: 'New PAN and corrections' },
      { name: 'UTIITSL PAN', url: 'https://www.pan.utiitsl.com', covers: 'New PAN and corrections' },
    ],
    sources: ['https://www.incometax.gov.in', 'https://www.onlineservices.nsdl.com', 'https://www.pan.utiitsl.com'],
  },
  {
    id: 'voter_update',
    mode: 'self_serve',
    titles: {
      en: 'Change address or mobile on the voter ID',
      te: 'ఓటరు ఐడీలో చిరునామా లేదా మొబైల్ మార్చడం',
      hi: 'वोटर आईडी पर पता या मोबाइल बदलना',
    },
    keywords: [
      'voter id', 'voter card', 'epic', 'form 8', 'change address voter',
      'ఓటరు', 'ఓటర్ ఐడీ', 'ఓటు హక్కు',
      'वोटर', 'वोटर आईडी', 'मतदाता',
    ],
    steps: {
      en: [
        'Corrections to a name, address, mobile number, or photo already on the roll are Form 8, filed at https://voters.eci.gov.in.',
        'Sign in with the mobile you can receive an OTP on. Keep the reference number from the acknowledgement.',
        'Telangana roll notices and the booth you belong to are on https://ceotelangana.nic.in.',
        'The national voter helpline is 1950. If the form is pending after the published period, file it again from the same site with the old reference number, or raise it on Prajavani with that number.',
      ],
      te: [
        'పేరు, చిరునామా, మొబైల్ లేదా ఫోటో సవరణ Form 8. దరఖాస్తు https://voters.eci.gov.in లో.',
        'OTP వచ్చే మొబైల్‌తో లాగిన్ అవ్వండి. రిఫరెన్స్ నంబర్ దాచుకోండి.',
        'తెలంగాణ ఓటరు జాబితా: https://ceotelangana.nic.in.',
        'జాతీయ ఓటరు హెల్ప్‌లైన్ 1950. గడువు దాటినా పెండింగ్ ఉంటే అదే సైట్‌లో పాత రిఫరెన్స్‌తో మళ్లీ పెట్టండి, లేదా ఆ నంబర్‌తో ప్రజావాణిలో ఫిర్యాదు చేయండి.',
      ],
      hi: [
        'नाम, पता, मोबाइल या फोटो का सुधार फॉर्म 8 है। आवेदन https://voters.eci.gov.in पर।',
        'जिस मोबाइल पर OTP आए उससे लॉग इन करें। संदर्भ संख्या रखें।',
        'तेलंगाना मतदाता सूची: https://ceotelangana.nic.in ।',
        'राष्ट्रीय वोटर हेल्पलाइन 1950। समय के बाद भी लंबित हो तो उसी साइट पर पुराने संदर्भ के साथ दोबारा करें, या वह नंबर लेकर प्रजावाणी में शिकायत करें।',
      ],
    },
    contacts: [
      { name: 'Voters’ Service Portal', phone: '1950', url: 'https://voters.eci.gov.in', covers: 'Form 8 corrections' },
      { name: 'Chief Electoral Officer, Telangana', url: 'https://ceotelangana.nic.in', covers: 'Telangana electoral roll' },
      PRAJAVANI,
    ],
    sources: ['https://voters.eci.gov.in', 'https://ceotelangana.nic.in'],
  },
  {
    id: 'ration_card',
    mode: 'self_serve',
    titles: {
      en: 'Ration card: new card, member, or address',
      te: 'రేషన్ కార్డు: కొత్త కార్డు, సభ్యుడు, లేదా చిరునామా',
      hi: 'राशन कार्ड: नया कार्ड, सदस्य, या पता',
    },
    keywords: [
      'ration', 'ration card', 'food security', 'fsc', 'add member ration',
      'రేషన్', 'రేషన్ కార్డు', 'ఫుడ్ సెక్యూరిటీ',
      'राशन', 'राशन कार्ड',
    ],
    steps: {
      en: [
        'Telangana food security card services (new card, add or remove a member, address change, search) are on https://epds.telangana.gov.in/FoodSecurityAct/ and at a MeeSeva centre.',
        'Search an existing application with the MeeSeva number, application number, or Aadhaar on the FSC application search of that site. You will see where it is pending and the reason if it was rejected.',
        'Consumer helplines printed on that site are 1967 and 180042500333.',
        'If the shop is not issuing the grain the card shows, note the shop number and the month, call 1967, and if it is not corrected, give those details on Prajavani.',
      ],
      te: [
        'కొత్త కార్డు, సభ్యుడిని చేర్చడం లేదా తీసివేయడం, చిరునామా మార్పు https://epds.telangana.gov.in/FoodSecurityAct/ లో లేదా మీసేవ కేంద్రంలో.',
        'మీసేవ నంబర్, అప్లికేషన్ నంబర్ లేదా ఆధార్‌తో FSC search చేయండి. ఎక్కడ పెండింగ్ ఉందో, తిరస్కరణ కారణం కనిపిస్తుంది.',
        'ఆ సైట్‌లో ఉన్న వినియోగదారు హెల్ప్‌లైన్లు 1967 మరియు 180042500333.',
        'కార్డులో ఉన్న ధాన్యం షాపు ఇవ్వకపోతే షాపు నంబర్, నెల రాసుకుని 1967 కు కాల్ చేయండి. సరిదిద్దకపోతే ప్రజావాణిలో ఇవ్వండి.',
      ],
      hi: [
        'नया कार्ड, सदस्य जोड़ना या हटाना, पता बदलना https://epds.telangana.gov.in/FoodSecurityAct/ पर या मीसेवा केंद्र पर।',
        'मीसेवा नंबर, आवेदन नंबर या आधार से FSC search करें। कहाँ लंबित है और अस्वीकृति का कारण दिखेगा।',
        'उसी साइट पर छपी उपभोक्ता हेल्पलाइन 1967 और 180042500333।',
        'कार्ड का अनाज दुकान न दे तो दुकान नंबर और महीना लिखकर 1967 पर कॉल करें। न सुधरे तो प्रजावाणी में दें।',
      ],
    },
    contacts: [EPDS, MEESEVA, PRAJAVANI],
    sources: ['https://epds.telangana.gov.in/FoodSecurityAct/', 'https://civilsupplies.telangana.gov.in'],
  },
  {
    id: 'transport_update',
    mode: 'self_serve',
    titles: {
      en: 'Update address or mobile on a driving licence or RC',
      te: 'డ్రైవింగ్ లైసెన్స్ లేదా RC లో చిరునామా లేదా మొబైల్',
      hi: 'ड्राइविंग लाइसेंस या RC पर पता या मोबाइल',
    },
    keywords: [
      'driving licence', 'driving license', 'vehicle rc', 'registration certificate', 'rta', 'change address rc',
      'లైసెన్స్', 'ఆర్‌సీ', 'వాహనం', 'ఆర్‌టీఏ',
      'लाइसेंस', 'आरसी', 'आरटीए', 'गाड़ी',
    ],
    steps: {
      en: [
        'Driving licence services are on Sarathi and vehicle registration on Vahan, both reached from https://parivahan.gov.in. The Telangana transport department site is https://transport.telangana.gov.in.',
        'Keep the licence number or the vehicle registration number, and the mobile that can receive the OTP.',
        'Address change asks for a proof of the new address. Submit it on the portal or at the RTA office named on the site for your district. MeeSeva also lists several transport services.',
        'Save the application number and track it on the same portal. If it stays pending, take that number to Prajavani.',
      ],
      te: [
        'డ్రైవింగ్ లైసెన్స్ Sarathi లో, వాహన RC Vahan లో. రెండూ https://parivahan.gov.in నుంచి. తెలంగాణ రవాణా శాఖ: https://transport.telangana.gov.in.',
        'లైసెన్స్ నంబర్ లేదా వాహన నంబర్, OTP వచ్చే మొబైల్ సిద్ధంగా ఉంచుకోండి.',
        'చిరునామా మార్పుకు కొత్త చిరునామా రుజువు కావాలి. పోర్టల్‌లో లేదా మీ జిల్లా RTA కార్యాలయంలో పెట్టండి. కొన్ని సేవలు మీసేవలో కూడా ఉన్నాయి.',
        'అప్లికేషన్ నంబర్ దాచి అదే పోర్టల్‌లో చూడండి. పెండింగ్ ఉంటే ఆ నంబర్‌తో ప్రజావాణికి వెళ్లండి.',
      ],
      hi: [
        'ड्राइविंग लाइसेंस Sarathi पर, वाहन RC Vahan पर। दोनों https://parivahan.gov.in से। तेलंगाना परिवहन विभाग: https://transport.telangana.gov.in ।',
        'लाइसेंस नंबर या गाड़ी नंबर, और OTP वाला मोबाइल रखें।',
        'पता बदलने के लिए नए पते का प्रमाण चाहिए। पोर्टल पर या अपनी जिले की RTA कार्यालय में दें। कई सेवाएँ मीसेवा पर भी हैं।',
        'आवेदन संख्या रखकर उसी पोर्टल पर देखें। लंबित रहे तो वह नंबर प्रजावाणी में दें।',
      ],
    },
    contacts: [
      { name: 'Parivahan', url: 'https://parivahan.gov.in', covers: 'Sarathi (licence) and Vahan (RC)' },
      { name: 'Telangana Transport', url: 'https://transport.telangana.gov.in', covers: 'State transport services and RTA' },
      MEESEVA,
      PRAJAVANI,
    ],
    sources: ['https://parivahan.gov.in', 'https://transport.telangana.gov.in'],
  },
  {
    id: 'lpg',
    mode: 'self_serve',
    titles: {
      en: 'Gas connection: transfer, name, or subsidy',
      te: 'గ్యాస్ కనెక్షన్: బదిలీ, పేరు, లేదా సబ్సిడీ',
      hi: 'गैस कनेक्शन: ट्रांसफर, नाम, या सब्सिडी',
    },
    keywords: [
      'gas', 'lpg', 'indane', 'bharat gas', 'hp gas', 'subsidy', 'cylinder',
      'గ్యాస్', 'సిలిండర్', 'సబ్సిడీ', 'ఇండేన్',
      'गैस', 'सिलेंडर', 'सब्सिडी', 'इंडेन',
    ],
    steps: {
      en: [
        'Ask which company: Indane (Indian Oil), Bharat Gas, or HP Gas. The consumer number is on the delivery receipt or the blue book.',
        'Indane requests are on https://cx.indianoil.in. Bharat Gas is on https://my.ebharatgas.com. HP Gas customers use the HP Gas app or the HPCL site linked from their distributor.',
        'A transfer to Telangana, a name change, or a subsidy that did not reach the bank is filed there, or with the distributor named on the book. The bank account must be the one seeded with Aadhaar.',
        'Keep the request number. If the distributor will not accept a transfer that the portal allows, note the distributor code and raise it on Prajavani.',
      ],
      te: [
        'కంపెనీ ఏది అడగండి: Indane (Indian Oil), Bharat Gas, లేదా HP Gas. కన్స్యూమర్ నంబర్ డెలివరీ రసీదు లేదా బుక్‌లో ఉంటుంది.',
        'Indane: https://cx.indianoil.in . Bharat Gas: https://my.ebharatgas.com . HP Gas కి HP Gas యాప్ లేదా డిస్ట్రిబ్యూటర్ చెప్పిన HPCL సైట్.',
        'తెలంగాణకు బదిలీ, పేరు మార్పు, లేదా బ్యాంకుకు రాని సబ్సిడీ అక్కడే లేదా బుక్‌లో ఉన్న డిస్ట్రిబ్యూటర్ దగ్గర పెట్టండి. బ్యాంకు ఖాతా ఆధార్‌తో లింక్ అయి ఉండాలి.',
        'రిక్వెస్ట్ నంబర్ దాచుకోండి. పోర్టల్ అనుమతించిన బదిలీని డిస్ట్రిబ్యూటర్ తీసుకోకపోతే కోడ్ రాసి ప్రజావాణిలో ఇవ్వండి.',
      ],
      hi: [
        'कंपनी पूछें: Indane (Indian Oil), Bharat Gas, या HP Gas। उपभोक्ता संख्या रसीद या बुक पर होती है।',
        'Indane: https://cx.indianoil.in । Bharat Gas: https://my.ebharatgas.com । HP Gas के लिए HP Gas ऐप या वितरक वाली HPCL साइट।',
        'तेलंगाना ट्रांसफर, नाम बदलाव, या बैंक में न पहुँची सब्सिडी वहीं या बुक वाले वितरक के पास करें। खाता आधार से जुड़ा होना चाहिए।',
        'अनुरोध संख्या रखें। पोर्टल जिस ट्रांसफर की इजाज़त दे उसे वितरक न ले तो कोड लिखकर प्रजावाणी में दें।',
      ],
    },
    contacts: [
      { name: 'Indane', url: 'https://cx.indianoil.in', covers: 'Indian Oil LPG' },
      { name: 'Bharat Gas', url: 'https://my.ebharatgas.com', covers: 'Bharat Petroleum LPG' },
      PRAJAVANI,
    ],
    sources: ['https://cx.indianoil.in', 'https://my.ebharatgas.com'],
  },
  {
    id: 'certificates',
    mode: 'self_serve',
    titles: {
      en: 'Birth, income, or residence certificate',
      te: 'పుట్టిన, ఆదాయ, లేదా నివాస ధృవపత్రం',
      hi: 'जन्म, आय, या निवास प्रमाण पत्र',
    },
    keywords: [
      'income certificate', 'residence certificate', 'birth certificate', 'caste certificate', 'meeseva',
      'ఇన్‌కం సర్టిఫికెట్', 'రెసిడెన్స్', 'పుట్టిన సర్టిఫికెట్', 'మీసేవ', 'ధృవీకరణ పత్రం',
      'आय प्रमाण', 'निवास प्रमाण', 'जन्म प्रमाण', 'मीसेवा',
    ],
    steps: {
      en: [
        'Apply at a MeeSeva centre or on https://meeseva.telangana.gov.in. Birth and death registration for the state is also on https://ubdmis.telangana.gov.in. GHMC birth and death status can be checked from the MeeSeva home page.',
        'Take the application number printed on the receipt. On the MeeSeva home page, type it in Know Your Application Status.',
        'The receipt names the office that has to issue it (often the tahsildar / MRO for income and residence). If the status does not move, file the same application number on Prajavani.',
      ],
      te: [
        'మీసేవ కేంద్రంలో లేదా https://meeseva.telangana.gov.in లో దరఖాస్తు చేయండి. పుట్టిన / మరణ రిజిస్ట్రేషన్ https://ubdmis.telangana.gov.in లో కూడా ఉంది. GHMC పుట్టిన / మరణ స్టేటస్ మీసేవ హోమ్‌పేజీలో చూడవచ్చు.',
        'రసీదులోని అప్లికేషన్ నంబర్ తీసుకోండి. మీసేవ హోమ్‌పేజీలో Know Your Application Status లో వేయండి.',
        'రసీదు ఏ కార్యాలయం జారీ చేయాలో చెబుతుంది (ఆదాయ, నివాసాలకు తరచు తహసీల్దార్ / MRO). స్టేటస్ కదరకపోతే అదే నంబర్‌తో ప్రజావాణిలో ఇవ్వండి.',
      ],
      hi: [
        'मीसेवा केंद्र या https://meeseva.telangana.gov.in पर आवेदन करें। जन्म / मृत्यु पंजीकरण https://ubdmis.telangana.gov.in पर भी है। GHMC जन्म / मृत्यु स्थिति मीसेवा होम पेज पर देख सकते हैं।',
        'रसीद की आवेदन संख्या लें। मीसेवा होम पेज पर Know Your Application Status में डालें।',
        'रसीद बताती है कौन सा दफ्तर जारी करेगा (आय और निवास के लिए अक्सर तहसीलदार / MRO)। स्थिति न हिले तो वही नंबर प्रजावाणी में दें।',
      ],
    },
    contacts: [MEESEVA, { name: 'Birth and death registration', url: 'https://ubdmis.telangana.gov.in', covers: 'Telangana civil registration' }, PRAJAVANI],
    sources: ['https://meeseva.telangana.gov.in', 'https://ubdmis.telangana.gov.in'],
  },
  {
    id: 'power_outage',
    mode: 'department',
    titles: {
      en: 'No electricity in my area',
      te: 'మా ప్రాంతంలో కరెంట్ లేదు',
      hi: 'मेरे इलाके में बिजली नहीं है',
    },
    keywords: [
      'no power', 'no electricity', 'power cut', 'current cut', 'outage', 'voltage',
      'electricity', 'electric', 'power problem', 'current problem', 'power issue', 'no current',
      'కరెంట్ లేదు', 'కరెంట్ కోత', 'విద్యుత్ లేదు', 'లైట్ లేదు', 'కరెంట్', 'విద్యుత్',
      'बिजली नहीं', 'करंट नहीं', 'बिजली कट', 'लाइट नहीं', 'बिजली', 'करंट',
    ],
    steps: {
      en: [
        'Call 1912. It is the 24-hour complaint number for both Telangana discoms. Give the area, the landmark, and how long the power has been out. If you have a bill, give the service number (UKSCNO).',
        'Hyderabad and the southern districts are TGSPDCL: https://tgsouthernpower.org. Northern districts are TGNPDCL: https://tgnpdcl.com, which also publishes 18004250028.',
        'Register the same complaint on that discom’s website or official app so you get a complaint number. Pay a bill only on that website or app. The discom has warned that it does not send payment links, and you should not share an OTP or bank details.',
        'If 1912 gives no complaint number, or the power is still out after the time they promised, tell me the place and your name and mobile. I will record it here. There is no published discom complaint email in our directory, so the call and the website complaint are the path that creates an official number.',
      ],
      te: [
        '1912 కు కాల్ చేయండి. తెలంగాణ రెండు డిస్కంల 24 గంటల నంబర్ ఇది. ప్రాంతం, ల్యాండ్‌మార్క్, ఎంతసేపటి నుంచి కరెంట్ లేదో చెప్పండి. బిల్లు ఉంటే సర్వీస్ నంబర్ (UKSCNO) ఇవ్వండి.',
        'హైదరాబాద్ మరియు దక్షిణ జిల్లాలు TGSPDCL: https://tgsouthernpower.org . ఉత్తర జిల్లాలు TGNPDCL: https://tgnpdcl.com . వారు 18004250028 కూడా ప్రచురించారు.',
        'అదే ఫిర్యాదు డిస్కం వెబ్‌సైట్ లేదా అధికారిక యాప్‌లో పెట్టండి. ఫిర్యాదు నంబర్ వస్తుంది. బిల్లు కేవలం ఆ సైట్ లేదా యాప్‌లోనే కట్టండి. పేమెంట్ లింక్ పంపమని, OTP లేదా బ్యాంక్ వివరాలు అడగమని డిస్కం హెచ్చరించింది.',
        '1912 ఫిర్యాదు నంబర్ ఇవ్వకపోతే, లేదా చెప్పిన సమయం దాటినా కరెంట్ రాకపోతే, చోటు, మీ పేరు, మొబైల్ చెప్పండి. ఇక్కడ నమోదు చేస్తాను. డిస్కం ఫిర్యాదు ఇమెయిల్ మా డైరెక్టరీలో లేదు. అధికార నంబర్ కాల్ మరియు వెబ్‌సైట్ ఫిర్యాదుతోనే వస్తుంది.',
      ],
      hi: [
        '1912 पर कॉल करें। यह दोनों तेलंगाना डिस्कॉम का 24 घंटे का नंबर है। इलाका, निशान, और कितनी देर से बिजली नहीं है बताएँ। बिल हो तो सर्विस नंबर (UKSCNO) दें।',
        'हैदराबाद और दक्षिणी जिले TGSPDCL: https://tgsouthernpower.org । उत्तरी जिले TGNPDCL: https://tgnpdcl.com । उन्होंने 18004250028 भी छापा है।',
        'वही शिकायत डिस्कॉम की वेबसाइट या आधिकारिक ऐप पर दर्ज करें ताकि शिकायत नंबर मिले। बिल केवल उसी साइट या ऐप पर भरें। डिस्कॉम ने कहा है कि वे भुगतान लिंक नहीं भेजते, और OTP या बैंक विवरण साझा न करें।',
        '1912 शिकायत नंबर न दे, या बताए समय के बाद भी बिजली न आए, तो जगह, नाम और मोबाइल बताएँ। मैं यहाँ दर्ज करूँगा। डिस्कॉम का शिकायत ईमेल हमारी डायरेक्टरी में नहीं है। आधिकारिक नंबर कॉल और वेबसाइट शिकायत से ही बनता है।',
      ],
    },
    contacts: [TGSPDCL, TGNPDCL],
    sources: ['https://tgsouthernpower.org', 'https://tgnpdcl.com'],
  },
  {
    id: 'power_bill',
    mode: 'department',
    titles: {
      en: 'Electricity bill or meter problem',
      te: 'కరెంట్ బిల్లు లేదా మీటర్ సమస్య',
      hi: 'बिजली बिल या मीटर की समस्या',
    },
    keywords: [
      'electricity bill', 'power bill', 'high bill', 'meter', 'tsspdcl', 'tgspdcl',
      'కరెంట్ బిల్', 'మీటర్', 'బిల్లు ఎక్కువ',
      'बिजली बिल', 'मीटर', 'बिल ज्यादा',
    ],
    steps: {
      en: [
        'Check the bill on the TGSPDCL or TGNPDCL site with the service number. Pay only there or in the official app.',
        'For a bill that looks wrong, or a meter that is not moving or is burnt, register a complaint on that site and call 1912. Ask for meter testing and keep the complaint number.',
        'A new connection is also on the discom site, and TGSPDCL says new connections can be filed through MeeSeva.',
        'If they close the complaint without testing the meter, bring the complaint number back here with your name, mobile, and area so it can be recorded for Prajavani.',
      ],
      te: [
        'సర్వీస్ నంబర్‌తో TGSPDCL లేదా TGNPDCL సైట్‌లో బిల్లు చూడండి. అక్కడే లేదా అధికారిక యాప్‌లోనే కట్టండి.',
        'బిల్లు తప్పుగా అనిపిస్తే, లేదా మీటర్ కదరకపోతే / కాలిపోతే, ఆ సైట్‌లో ఫిర్యాదు పెట్టి 1912 కు కాల్ చేయండి. మీటర్ టెస్టింగ్ అడిగి ఫిర్యాదు నంబర్ దాచుకోండి.',
        'కొత్త కనెక్షన్ డిస్కం సైట్‌లో ఉంది. TGSPDCL కొత్త కనెక్షన్లు మీసేవ ద్వారా కూడా అని చెప్పింది.',
        'మీటర్ పరీక్ష లేకుండా ఫిర్యాదు మూసేస్తే, ఫిర్యాదు నంబర్, పేరు, మొబైల్, ప్రాంతం ఇక్కడ చెప్పండి. ప్రజావాణి కోసం నమోదు చేస్తాం.',
      ],
      hi: [
        'सर्विस नंबर से TGSPDCL या TGNPDCL साइट पर बिल देखें। भुगतान केवल वहीं या आधिकारिक ऐप पर करें।',
        'बिल गलत लगे, या मीटर न चले या जल जाए, तो उसी साइट पर शिकायत करें और 1912 पर कॉल करें। मीटर जाँच माँगें और शिकायत नंबर रखें।',
        'नया कनेक्शन डिस्कॉम साइट पर है। TGSPDCL ने कहा है कि नया कनेक्शन मीसेवा से भी होता है।',
        'मीटर जाँच के बिना शिकायत बंद हो जाए तो शिकायत नंबर, नाम, मोबाइल और इलाका यहाँ बताएँ। प्रजावाणी के लिए दर्ज करेंगे।',
      ],
    },
    contacts: [TGSPDCL, TGNPDCL, MEESEVA, PRAJAVANI],
    sources: ['https://tgsouthernpower.org', 'https://tgnpdcl.com'],
  },
  {
    id: 'water_supply',
    mode: 'department',
    titles: {
      en: 'No water, low pressure, or dirty water',
      te: 'నీళ్లు రావడం లేదు, ప్రెషర్ లేదు, లేదా మురికి నీళ్లు',
      hi: 'पानी नहीं, कम दबाव, या गंदा पानी',
    },
    keywords: [
      'no water', 'water supply', 'low pressure', 'dirty water', 'drinking water', 'tanker',
      'నీళ్లు రావడం లేదు', 'తాగునీరు', 'వాటర్ లేదు', 'నీటి సరఫరా',
      'पानी नहीं आ रहा', 'पीने का पानी', 'टैंकर',
    ],
    steps: {
      en: [
        'In Hyderabad metropolitan limits this is HMWSSB. Call 155313 (24 hours). Also published: 040-23300114. Give the CAN (connection account number) from the water bill if you have it, the locality, and whether there is no water, low pressure, or dirty water.',
        'File the same complaint at https://www.hyderabadwater.gov.in or the HMWSSB Citizen Services app, and keep that number.',
        'Outside Hyderabad, household supply is Mission Bhagiratha or the municipality. Start at https://missionbhagiratha.telangana.gov.in or https://emunicipal.telangana.gov.in, then Prajavani if the local office does not respond.',
        'Tell me the area, how many days, your name and mobile if you want this recorded on our side. A department email is sent only when we have a published address and you confirm the draft.',
      ],
      te: [
        'హైదరాబాద్ మెట్రో పరిధిలో ఇది HMWSSB. 155313 కు కాల్ చేయండి (24 గంటలు). ప్రచురించిన మరో నంబర్ 040-23300114. బిల్లులోని CAN, ప్రాంతం, నీళ్లు లేవా / ప్రెషర్ లేదా / మురికిగా ఉన్నాయా చెప్పండి.',
        'అదే ఫిర్యాదు https://www.hyderabadwater.gov.in లో లేదా HMWSSB Citizen Services యాప్‌లో పెట్టి నంబర్ దాచుకోండి.',
        'హైదరాబాద్ బయట ఇంటి సరఫరా Mission Bhagiratha లేదా మున్సిపాలిటీ. https://missionbhagiratha.telangana.gov.in లేదా https://emunicipal.telangana.gov.in . స్పందన లేకపోతే ప్రజావాణి.',
        'మా వైపు నమోదు కావాలంటే ప్రాంతం, ఎన్ని రోజులు, పేరు, మొబైల్ చెప్పండి. డిపార్ట్‌మెంట్ ఇమెయిల్ ప్రచురించిన చిరునామా ఉండి, మీరు డ్రాఫ్ట్ ఒప్పుకుంటేనే పంపుతాం.',
      ],
      hi: [
        'हैदराबाद महानगर सीमा में यह HMWSSB है। 155313 पर कॉल करें (24 घंटे)। प्रकाशित दूसरा नंबर 040-23300114। बिल का CAN, इलाका, और पानी नहीं है / दबाव कम है / पानी गंदा है बताएँ।',
        'वही शिकायत https://www.hyderabadwater.gov.in या HMWSSB Citizen Services ऐप पर करें और नंबर रखें।',
        'हैदराबाद के बाहर घरेलू आपूर्ति Mission Bhagiratha या नगरपालिका की है। https://missionbhagiratha.telangana.gov.in या https://emunicipal.telangana.gov.in । जवाब न मिले तो प्रजावाणी।',
        'हमारी तरफ दर्ज कराना हो तो इलाका, कितने दिन, नाम और मोबाइल बताएँ। विभाग को ईमेल तभी जाएगा जब प्रकाशित पता हो और आप मसौदा मंजूर करें।',
      ],
    },
    contacts: [HMWSSB, { name: 'Mission Bhagiratha', url: 'https://missionbhagiratha.telangana.gov.in', covers: 'Rural and other household water supply outside the HMWSSB area' }, PRAJAVANI],
    sources: ['https://www.hyderabadwater.gov.in', 'https://www.ghmc.gov.in/KeyContacts.aspx'],
  },
  {
    id: 'roads',
    mode: 'department',
    titles: {
      en: 'Damaged road or potholes',
      te: 'రోడ్డు పాడైంది లేదా గుంతలు',
      hi: 'सड़क टूटी है या गड्ढे हैं',
    },
    keywords: [
      'pothole', 'road damage', 'bad road', 'road repair',
      'రోడ్డు', 'గుంతలు', 'రోడ్ పాడైంది',
      'सड़क', 'गड्ढे', 'रोड टूटी',
    ],
    steps: {
      en: [
        'Inside GHMC limits call 21111111 or 040-23225397 and file it on https://www.ghmc.gov.in. Give the colony, the nearest landmark, and say it is a damaged road or potholes.',
        'Outside GHMC, the municipality site is https://emunicipal.telangana.gov.in and the panchayat site is https://epanchayat.telangana.gov.in. A road between towns may be Roads and Buildings; if the local office will not take it, use Prajavani and name the road.',
        'A photo and the number of days it has been like this make the complaint specific. Ask for the complaint number before you hang up.',
        'If you want it recorded here, send the place, your name, and your mobile. I will not email GHMC unless a published complaint address is on the draft you confirm.',
      ],
      te: [
        'GHMC పరిధిలో 21111111 లేదా 040-23225397 కు కాల్ చేసి https://www.ghmc.gov.in లో ఫిర్యాదు పెట్టండి. కాలనీ, దగ్గరి ల్యాండ్‌మార్క్, గుంతలు లేదా పాడైన రోడ్డు అని చెప్పండి.',
        'GHMC బయట మున్సిపాలిటీ https://emunicipal.telangana.gov.in , పంచాయతీ https://epanchayat.telangana.gov.in . పట్టణాల మధ్య రోడ్డు R&B కావచ్చు. స్థానిక కార్యాలయం తీసుకోకపోతే రోడ్డు పేరుతో ప్రజావాణి.',
        'ఫోటో మరియు ఎన్ని రోజుల నుంచి ఉందో చెప్పడం ఫిర్యాదును స్పష్టం చేస్తుంది. కాల్ పెట్టే ముందు ఫిర్యాదు నంబర్ అడగండి.',
        'ఇక్కడ నమోదు కావాలంటే చోటు, పేరు, మొబైల్ పంపండి. మీరు ఒప్పుకున్న డ్రాఫ్ట్‌లో ప్రచురించిన ఇమెయిల్ ఉంటే తప్ప GHMC కు మెయిల్ పంపము.',
      ],
      hi: [
        'GHMC सीमा में 21111111 या 040-23225397 पर कॉल करें और https://www.ghmc.gov.in पर शिकायत करें। कॉलोनी, नज़दीकी निशान, और गड्ढे या टूटी सड़क बताएँ।',
        'GHMC के बाहर नगरपालिका https://emunicipal.telangana.gov.in , पंचायत https://epanchayat.telangana.gov.in । कस्बों के बीच की सड़क R&B की हो सकती है। स्थानीय दफ्तर न ले तो सड़क का नाम लिखकर प्रजावाणी।',
        'फोटो और कितने दिन से है यह शिकायत को साफ करता है। फोन रखने से पहले शिकायत नंबर माँगें।',
        'यहाँ दर्ज कराना हो तो जगह, नाम और मोबाइल भेजें। GHMC को ईमेल तभी जाएगा जब आपके मंजूर मसौदे में प्रकाशित पता हो।',
      ],
    },
    contacts: [GHMC, { name: 'Municipalities', url: 'https://emunicipal.telangana.gov.in', covers: 'Towns outside GHMC' }, { name: 'Panchayat Raj', url: 'https://epanchayat.telangana.gov.in', covers: 'Village roads' }, PRAJAVANI],
    sources: ['https://www.ghmc.gov.in/KeyContacts.aspx'],
  },
  {
    id: 'sewer',
    mode: 'department',
    titles: {
      en: 'Blocked sewer or overflowing drain',
      te: 'మురుగు కాలువ బ్లాక్ లేదా డ్రైనేజీ పొర్లడం',
      hi: 'नाली बंद या सीवर ओवरफ्लो',
    },
    keywords: [
      'sewer', 'drainage', 'drain block', 'sewage', 'manhole overflow',
      'మురుగు', 'డ్రైనేజీ', 'కాలువ బ్లాక్', 'మురికినీరు',
      'नाली', 'सीवर', 'ड्रेनेज', 'गंदा पानी',
    ],
    steps: {
      en: [
        'Sewage from the underground line in Hyderabad is HMWSSB: call 155313 and file it at https://www.hyderabadwater.gov.in. Say it is a sewer blockage, and give the door number or landmark.',
        'An open storm drain on a GHMC road is GHMC: 21111111 and https://www.ghmc.gov.in. If you are not sure which it is, call 155313 first and also 21111111, and keep both complaint numbers.',
        'Outside Hyderabad, call the municipality and then use Prajavani if the overflow continues.',
        'Tell people nearby to keep children away from an open overflow. Send me the place, your name, and mobile if you want a record here.',
      ],
      te: [
        'హైదరాబాద్‌లో భూగర్భ మురుగు లైన్ HMWSSB: 155313 కు కాల్ చేసి https://www.hyderabadwater.gov.in లో పెట్టండి. మురుగు బ్లాక్ అని, డోర్ నంబర్ లేదా ల్యాండ్‌మార్క్ చెప్పండి.',
        'GHMC రోడ్డుపై ఓపెన్ డ్రైన్ GHMC: 21111111 మరియు https://www.ghmc.gov.in . ఏదో తెలియకపోతే ముందు 155313, తర్వాత 21111111. రెండు ఫిర్యాదు నంబర్లు దాచుకోండి.',
        'హైదరాబాద్ బయట మున్సిపాలిటీకి కాల్ చేసి, పొర్లుతూనే ఉంటే ప్రజావాణి.',
        'తెరిచిన మురుగు దగ్గర పిల్లలను దూరంగా ఉంచమని చెప్పండి. రికార్డు కావాలంటే చోటు, పేరు, మొబైల్ పంపండి.',
      ],
      hi: [
        'हैदराबाद में ज़मीन के नीचे की सीवर लाइन HMWSSB की है: 155313 पर कॉल करें और https://www.hyderabadwater.gov.in पर दर्ज करें। सीवर बंद है कहें, और मकान नंबर या निशान दें।',
        'GHMC सड़क की खुली नाली GHMC की है: 21111111 और https://www.ghmc.gov.in । पक्का न हो तो पहले 155313, फिर 21111111। दोनों शिकायत नंबर रखें।',
        'हैदराबाद के बाहर नगरपालिका को कॉल करें। ओवरफ्लो जारी रहे तो प्रजावाणी।',
        'खुले गंदे पानी से बच्चों को दूर रखें। रिकॉर्ड चाहिए तो जगह, नाम और मोबाइल भेजें।',
      ],
    },
    contacts: [HMWSSB, GHMC, PRAJAVANI],
    sources: ['https://www.hyderabadwater.gov.in', 'https://www.ghmc.gov.in/KeyContacts.aspx'],
  },
  {
    id: 'garbage',
    mode: 'department',
    titles: {
      en: 'Garbage not collected',
      te: 'చెత్త ఎత్తడం లేదు',
      hi: 'कचरा नहीं उठाया जा रहा',
    },
    keywords: [
      'garbage', 'trash', 'waste', 'dumping', 'not collected',
      'చెత్త', 'చెత్త తీయడం లేదు', 'గార్బేజ్',
      'कचरा', 'कूड़ा', 'कचरा नहीं उठा',
    ],
    steps: {
      en: [
        'Inside GHMC call 21111111 and report it on https://www.ghmc.gov.in. Give the colony and how many days the garbage has been sitting.',
        'Outside GHMC use the municipality at https://emunicipal.telangana.gov.in.',
        'Ask for the complaint number. If the same spot is skipped again after that complaint, come back with the number and we will record it for Prajavani.',
      ],
      te: [
        'GHMC లోపల 21111111 కు కాల్ చేసి https://www.ghmc.gov.in లో చెప్పండి. కాలనీ, ఎన్ని రోజుల నుంచి చెత్త పడి ఉందో చెప్పండి.',
        'GHMC బయట https://emunicipal.telangana.gov.in మున్సిపాలిటీ.',
        'ఫిర్యాదు నంబర్ అడగండి. ఆ ఫిర్యాదు తర్వాత కూడా అదే చోటు వదిలేస్తే నంబర్‌తో తిరిగి రండి. ప్రజావాణి కోసం నమోదు చేస్తాం.',
      ],
      hi: [
        'GHMC के अंदर 21111111 पर कॉल करें और https://www.ghmc.gov.in पर बताएँ। कॉलोनी और कितने दिन से कचरा पड़ा है कहें।',
        'GHMC के बाहर https://emunicipal.telangana.gov.in नगरपालिका।',
        'शिकायत नंबर माँगें। उस शिकायत के बाद भी वही जगह छूटे तो नंबर लेकर वापस आएँ। प्रजावाणी के लिए दर्ज करेंगे।',
      ],
    },
    contacts: [GHMC, { name: 'Municipalities', url: 'https://emunicipal.telangana.gov.in', covers: 'Garbage outside GHMC' }, PRAJAVANI],
    sources: ['https://www.ghmc.gov.in/KeyContacts.aspx'],
  },
  {
    id: 'streetlight',
    mode: 'department',
    titles: {
      en: 'Street light not working',
      te: 'వీధి దీపం వెలగడం లేదు',
      hi: 'स्ट्रीट लाइट नहीं जल रही',
    },
    keywords: [
      'street light', 'streetlight', 'lamp post',
      'వీధి దీపం', 'స్ట్రీట్ లైట్',
      'स्ट्रीट लाइट', 'सड़क की बत्ती',
    ],
    steps: {
      en: [
        'Inside GHMC call 21111111 or file it at https://www.ghmc.gov.in. Give the street name and, if it is painted on the pole, the pole number.',
        'Outside GHMC, report it to the municipality or the gram panchayat, then Prajavani if the road stays dark.',
        'Say how many poles and how many nights. Ask for the complaint number.',
      ],
      te: [
        'GHMC లోపల 21111111 లేదా https://www.ghmc.gov.in . వీధి పేరు, స్తంభంపై నంబర్ ఉంటే అది చెప్పండి.',
        'GHMC బయట మున్సిపాలిటీ లేదా గ్రామ పంచాయతీ. రోడ్డు చీకటిగానే ఉంటే ప్రజావాణి.',
        'ఎన్ని స్తంభాలు, ఎన్ని రాత్రులు అని చెప్పి ఫిర్యాదు నంబర్ అడగండి.',
      ],
      hi: [
        'GHMC के अंदर 21111111 या https://www.ghmc.gov.in । गली का नाम और खंभे पर नंबर हो तो वह बताएँ।',
        'GHMC के बाहर नगरपालिका या ग्राम पंचायत। सड़क अँधेरी रहे तो प्रजावाणी।',
        'कितने खंभे और कितनी रातें बताकर शिकायत नंबर माँगें।',
      ],
    },
    contacts: [GHMC, PRAJAVANI],
    sources: ['https://www.ghmc.gov.in/KeyContacts.aspx'],
  },
  {
    id: 'water_leak',
    mode: 'department',
    titles: {
      en: 'Water pipe burst or leakage',
      te: 'నీటి పైపు పగిలింది లేదా లీకేజీ',
      hi: 'पानी का पाइप फटा या रिसाव',
    },
    keywords: [
      'pipe burst', 'leakage', 'water leak', 'pipeline',
      'పైపు పగిలింది', 'లీకేజీ', 'నీళ్లు కారుతున్నాయి',
      'पाइप फटा', 'लीकेज', 'पानी रिस',
    ],
    steps: {
      en: [
        'In Hyderabad call HMWSSB on 155313 and say a pipeline is leaking or has burst. Give the street and what is flowing.',
        'File it at https://www.hyderabadwater.gov.in so there is a complaint number as well as the phone call.',
        'Outside Hyderabad report it to the municipality or Mission Bhagiratha, then Prajavani.',
        'If water is entering houses, say that first on the call.',
      ],
      te: [
        'హైదరాబాద్‌లో HMWSSB 155313 కు కాల్ చేసి పైపు లీక్ అవుతోందని లేదా పగిలిందని చెప్పండి. వీధి, ఏమి కారుతోందో చెప్పండి.',
        'https://www.hyderabadwater.gov.in లో కూడా పెట్టండి. కాల్‌తో పాటు ఫిర్యాదు నంబర్ ఉంటుంది.',
        'హైదరాబాద్ బయట మున్సిపాలిటీ లేదా Mission Bhagiratha, తర్వాత ప్రజావాణి.',
        'ఇళ్లలోకి నీళ్లు వస్తుంటే కాల్‌లో అది ముందు చెప్పండి.',
      ],
      hi: [
        'हैदराबाद में HMWSSB 155313 पर कॉल करें और कहें पाइप लीक हो रहा है या फट गया है। गली और क्या बह रहा है बताएँ।',
        'https://www.hyderabadwater.gov.in पर भी दर्ज करें ताकि कॉल के साथ शिकायत नंबर हो।',
        'हैदराबाद के बाहर नगरपालिका या Mission Bhagiratha, फिर प्रजावाणी।',
        'घरों में पानी घुस रहा हो तो कॉल में वही पहले कहें।',
      ],
    },
    contacts: [HMWSSB, PRAJAVANI],
    sources: ['https://www.hyderabadwater.gov.in'],
  },
  {
    id: 'pension',
    mode: 'department',
    titles: {
      en: 'Pension or scheme payment stopped',
      te: 'పెన్షన్ లేదా పథకం డబ్బు ఆగిపోయింది',
      hi: 'पेंशन या योजना का पैसा रुक गया',
    },
    keywords: [
      'pension', 'aasara', 'asara', 'scheme payment', 'widow pension', 'old age',
      'పెన్షన్', 'ఆసరా', 'వృద్ధాప్య',
      'पेंशन', 'आसरा', 'वृद्धावस्था',
    ],
    steps: {
      en: [
        'Aasara pension status is on https://www.aasara.telangana.gov.in. Check that the application is still active and that the bank account shown is yours.',
        'A stopped payment is often an Aadhaar-bank seeding problem. Confirm the account at the bank, then check the status on the Aasara site.',
        'If the site shows no reason, file it on Prajavani with the pension id, the last month you were paid, and the bank account’s last four digits. Prajavani is in person at Praja Bhavan on Tuesday and Friday, and the status is tracked on https://prajavani.cgg.gov.in with your mobile or the reference number.',
        'If you want us to email that support address, share your name, mobile, email, and pension id. I will show you the mail before it is sent, and you will be copied.',
      ],
      te: [
        'ఆసరా పెన్షన్ స్టేటస్ https://www.aasara.telangana.gov.in లో. దరఖాస్తు యాక్టివ్‌గా ఉందా, కనిపించే బ్యాంకు ఖాతా మీదేనా చూడండి.',
        'డబ్బు ఆగడం తరచు ఆధార్-బ్యాంకు లింక్ సమస్య. బ్యాంకులో ఖాతా నిర్ధారించి, ఆసరా సైట్‌లో స్టేటస్ చూడండి.',
        'సైట్‌లో కారణం లేకపోతే పెన్షన్ ఐడీ, చివరిసారి వచ్చిన నెల, ఖాతా చివరి నాలుగు అంకెలతో ప్రజావాణిలో ఇవ్వండి. మంగళ, శుక్రవారాల్లో ప్రజా భవన్‌లో ప్రత్యక్షంగా. స్టేటస్ https://prajavani.cgg.gov.in లో మొబైల్ లేదా రిఫరెన్స్‌తో.',
        'ఆ సపోర్ట్ అడ్రస్‌కు మేము మెయిల్ చేయాలంటే పేరు, మొబైల్, ఇమెయిల్, పెన్షన్ ఐడీ ఇవ్వండి. పంపే ముందు మెయిల్ చూపిస్తాం. మీకు కాపీ వెళ్తుంది.',
      ],
      hi: [
        'आसरा पेंशन की स्थिति https://www.aasara.telangana.gov.in पर। आवेदन सक्रिय है या नहीं, और जो खाता दिखे वह आपका है या नहीं देखें।',
        'पैसा रुकना अक्सर आधार-बैंक लिंकिंग की समस्या है। बैंक में खाता जाँचें, फिर आसरा साइट पर स्थिति देखें।',
        'साइट पर कारण न हो तो पेंशन आईडी, आखिरी भुगतान का महीना, और खाते के आखिरी चार अंक लेकर प्रजावाणी में दें। मंगल और शुक्रवार को प्रजा भवन में सीधे। स्थिति https://prajavani.cgg.gov.in पर मोबाइल या संदर्भ से।',
        'उस सपोर्ट पते पर हम मेल करें तो नाम, मोबाइल, ईमेल और पेंशन आईडी दें। भेजने से पहले मेल दिखाएँगे। आपको प्रतिलिपि जाएगी।',
      ],
    },
    contacts: [
      { name: 'Aasara pensions', url: 'https://www.aasara.telangana.gov.in', covers: 'Telangana social pensions' },
      PRAJAVANI,
    ],
    sources: ['https://www.aasara.telangana.gov.in', 'https://prajavani.cgg.gov.in'],
  },
  {
    id: 'manhole',
    mode: 'department',
    titles: {
      en: 'Missing or broken manhole cover',
      te: 'మ్యాన్‌హోల్ మూత లేదు లేదా విరిగింది',
      hi: 'मैनहोल का ढक्कन गायब या टूटा',
    },
    keywords: [
      'manhole', 'missing cover', 'open manhole',
      'మ్యాన్‌హోల్', 'మూత లేదు',
      'मैनहोल', 'ढक्कन नहीं',
    ],
    steps: {
      en: [
        'Treat this as urgent. In Hyderabad call HMWSSB 155313 and GHMC 21111111. Say the cover is missing or broken and give a landmark someone can find at night.',
        'Also file it at https://www.hyderabadwater.gov.in and https://www.ghmc.gov.in.',
        'Until it is closed, warn neighbours. Do not stand over the opening.',
        'Send the exact place here if you want a written record as well.',
      ],
      te: [
        'ఇది అత్యవసరం. హైదరాబాద్‌లో HMWSSB 155313 మరియు GHMC 21111111 కు కాల్ చేయండి. మూత లేదని లేదా విరిగిందని, రాత్రి కనిపించే ల్యాండ్‌మార్క్ చెప్పండి.',
        'https://www.hyderabadwater.gov.in మరియు https://www.ghmc.gov.in లో కూడా పెట్టండి.',
        'మూసే వరకు పొరుగువారిని హెచ్చరించండి. తెరుచుకున్న దానిపై నిలబడవద్దు.',
        'వ్రాతపూర్వక రికార్డు కావాలంటే ఖచ్చితమైన చోటు ఇక్కడ పంపండి.',
      ],
      hi: [
        'इसे तुरंत मानें। हैदराबाद में HMWSSB 155313 और GHMC 21111111 पर कॉल करें। ढक्कन गायब या टूटा है कहें, और रात में मिल जाए ऐसा निशान दें।',
        'https://www.hyderabadwater.gov.in और https://www.ghmc.gov.in पर भी दर्ज करें।',
        'बंद होने तक पड़ोसियों को बताएँ। खुले गड्ढे पर खड़े न हों।',
        'लिखित रिकॉर्ड चाहिए तो सही जगह यहाँ भेजें।',
      ],
    },
    contacts: [HMWSSB, GHMC],
    sources: ['https://www.hyderabadwater.gov.in', 'https://www.ghmc.gov.in/KeyContacts.aspx'],
  },
  {
    id: 'encroachment',
    mode: 'department',
    titles: {
      en: 'Illegal parking or encroachment blocking the road',
      te: 'అక్రమ పార్కింగ్ లేదా రోడ్డు ఆక్రమణ',
      hi: 'अवैध पार्किंग या सड़क पर अतिक्रमण',
    },
    keywords: [
      'encroachment', 'illegal parking', 'footpath blocked', 'blocked road',
      'ఆక్రమణ', 'పార్కింగ్', 'కాలిబాట',
      'अतिक्रमण', 'पार्किंग', 'फुटपाथ',
    ],
    steps: {
      en: [
        'A blocked footpath or a structure on a GHMC road: call 21111111 and file it at https://www.ghmc.gov.in with the street and what is blocking it.',
        'Moving traffic offences in Hyderabad (wrong-side driving, a vehicle parked in a live lane) go to Hyderabad Police: https://hyderabadpolice.gov.in. Use the contact published on that site.',
        'If the same blockage remains after a GHMC complaint number, bring that number back and we can record it for Prajavani.',
      ],
      te: [
        'GHMC రోడ్డుపై కాలిబాట మూసుకుపోవడం లేదా కట్టడం: 21111111 కు కాల్ చేసి https://www.ghmc.gov.in లో వీధి, ఏమి అడ్డుగా ఉందో చెప్పండి.',
        'హైదరాబాద్‌లో కదిలే ట్రాఫిక్ తప్పులు (తప్పు వైపు, లైవ్ లేన్‌లో పార్కింగ్) హైదరాబాద్ పోలీస్: https://hyderabadpolice.gov.in . ఆ సైట్‌లో ఉన్న కాంటాక్ట్ వాడండి.',
        'GHMC ఫిర్యాదు నంబర్ తర్వాత కూడా అడ్డు ఉంటే ఆ నంబర్‌తో రండి. ప్రజావాణి కోసం నమోదు చేస్తాం.',
      ],
      hi: [
        'GHMC सड़क पर बंद फुटपाथ या निर्माण: 21111111 पर कॉल करें और https://www.ghmc.gov.in पर गली और क्या रोक रहा है लिखें।',
        'हैदराबाद में चलती ट्रैफिक की गलतियाँ (गलत साइड, चलती लेन में पार्किंग) हैदराबाद पुलिस: https://hyderabadpolice.gov.in । उसी साइट पर छपा संपर्क इस्तेमाल करें।',
        'GHMC शिकायत नंबर के बाद भी रुकावट रहे तो वह नंबर लाएँ। प्रजावाणी के लिए दर्ज करेंगे।',
      ],
    },
    contacts: [GHMC, { name: 'Hyderabad Police', url: 'https://hyderabadpolice.gov.in', covers: 'Traffic offences in Hyderabad' }, PRAJAVANI],
    sources: ['https://www.ghmc.gov.in/KeyContacts.aspx', 'https://hyderabadpolice.gov.in'],
  },
]

export const PRAJAVANI_CONTACT = PRAJAVANI

export function playbookById(id: string | null | undefined): Playbook | null {
  if (!id) return null
  return PLAYBOOKS.find((p) => p.id === id) ?? null
}

/** Checked before the longer keyword list. More specific problems come first. */
const HINTS: { id: string; re: RegExp }[] = [
  { id: 'power_bill', re: /(electricity|power|discom|tgspdcl|tgnpdcl|కరెంట్|విద్యుత్|बिजली).{0,40}(bill|meter|బిల్లు|మీటర్|बिल|मीटर)|(bill|meter|బిల్లు|बिल).{0,40}(electricity|power|high|wrong|excess|కరెంట్|बिजली)|\buksc\b/i },
  { id: 'streetlight', re: /street\s*light|lamp\s*post|వీధి దీపం|स्ट्रीट लाइट|सड़क की बत्ती/i },
  { id: 'manhole', re: /manhole|మ్యాన్‌హోల్|मैनहोल/i },
  { id: 'sewer', re: /sewer|drain|sewage|మురుగు|డ్రైనేజ|नाली|सीवर|ड्रेनेज/i },
  { id: 'water_leak', re: /pipe|leak|పైపు|లీకేజ|पाइप|लीकेज|रिसाव/i },
  { id: 'water_supply', re: /water|నీళ్లు|నీటి|पानी/i },
  { id: 'garbage', re: /garbage|trash|waste|చెత్త|कचरा|कूड़ा/i },
  { id: 'encroachment', re: /encroach|parking|ఆక్రమణ|పార్కింగ్|अतिक्रमण|पार्किंग/i },
  { id: 'roads', re: /pothole|road|రోడ్డు|గుంత|सड़क|गड्ढ/i },
  { id: 'power_outage', re: /electric|\bpower\b|outage|voltage|current\s+(cut|problem|issue|gone)|no\s+current|కరెంట్|విద్యుత్|बिजली|करंट/i },
  { id: 'aadhaar_mobile', re: /(aadhaar|aadhar|ఆధార్|आधार).{0,40}(mobile|phone|number|నంబర్|मोबाइल|फोन)|(mobile|phone|నంబర్|मोबाइल).{0,40}(aadhaar|aadhar|ఆధార్|आधार)/i },
  { id: 'aadhaar_address', re: /(aadhaar|aadhar|ఆధార్|आधार).{0,40}(address|చిరునామా|पता)|(address|చిరునామా|पता).{0,40}(aadhaar|aadhar|ఆధార్|आधार)/i },
  { id: 'aadhaar_name_dob', re: /(aadhaar|aadhar|ఆధార్|आधार).{0,30}(name|dob|birth|పేరు|తేదీ|नाम|जन्म)/i },
  { id: 'pan_correction', re: /\bpan\b|పాన్|पैन/i },
  { id: 'voter_update', re: /voter|epic|ఓటరు|वोटर|मतदाता/i },
  { id: 'ration_card', re: /ration|food security|రేషన్|राशन/i },
  { id: 'transport_update', re: /licence|license|వాహనం|లైసెన్స్|लाइसेंस|\brc\b|rta|ఆర్‌టీఏ|आरटीए/i },
  { id: 'lpg', re: /\bgas\b|lpg|cylinder|గ్యాస్|సిలిండర్|गैस|सिलेंडर/i },
  { id: 'pension', re: /pension|aasara|asara|పెన్షన్|ఆసరా|पेंशन|आसरा/i },
  { id: 'certificates', re: /certificate|meeseva|మీసేవ|ధృవపత్ర|प्रमाण पत्र|मीसेवा/i },
]

export function matchPlaybook(text: string): { playbook: Playbook; score: number } | null {
  const hay = text.toLowerCase()
  const documentExample = /aadhaar|aadhar|ఆధార్|आधार|document|proof|family|father|mother|option/.test(hay)
  for (const hint of HINTS) {
    if (documentExample && (hint.id === 'power_bill' || hint.id === 'power_outage')) continue
    if (!hint.re.test(text) && !hint.re.test(hay)) continue
    const playbook = playbookById(hint.id)
    if (playbook) return { playbook, score: 6 }
  }
  let best: Playbook | null = null
  let bestScore = 0
  for (const playbook of PLAYBOOKS) {
    let score = 0
    for (const keyword of playbook.keywords) {
      const k = keyword.toLowerCase()
      if (hay.includes(k)) {
        score += k.length > 8 ? 4 : 3
        continue
      }
      const parts = k.split(/\s+/).filter((part) => part.length > 2)
      if (parts.length > 1 && parts.every((part) => hay.includes(part))) score += 3
    }
    if (score > bestScore) {
      best = playbook
      bestScore = score
    }
  }
  if (!best || bestScore < 3) return null
  return { playbook: best, score: bestScore }
}
