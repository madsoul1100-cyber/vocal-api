# Bharosa chat: test review, fixes and regression suite

Source: "Bharosa chatbot - test review and prompt changes" (live test 4 Nov 2026, 07:23-07:33 IST, public no-login chat, dummy data only).

Prompts live in `src/modules/bharosa/guide/prompts.ts` (system prompt and Priya personality, verbatim from the review sheets, plus verified reference data). Bump `GUIDE_PROMPT_VERSION` whenever either block changes.

Run the suite before and after every prompt or model change:

```bash
node scripts/guide-conversation-evals.mjs                 # everything
GUIDE_ONLY=R node scripts/guide-conversation-evals.mjs    # regression suite only (R-T01 ... R-T13)
npx tsx scripts/guide-unit-checks.ts                      # offline: name parsing, phone grouping, truncation guards, prompts
```

The prompt changes are well-grounded hypotheses, not guarantees. The suite is the proof.

## Findings and where each one is fixed

| # | Finding | Type | Fix |
| - | ------- | ---- | --- |
| 1 | Name gate before help | Prompt + code | Rules 1-2 in the system prompt. `agent.ts`: no `ask_name` / `ask_area` phase for Guide; `syncPhase` is only "waiting for a problem" or "helping". Greeting is a fixed scope line with no name request. |
| 2 | Name re-asked after decline / topic switch | Prompt + code | Rules 2-3. Names are only taken from an explicit intro ("my name is ..."), never from a bare reply like "ok". `name_declined` is stored on the session and passed to the model. |
| 3 | Reply cut mid-word ("as t", "distribution an") | Code | Cause found: `llmText` capped output at 500/700 tokens, and Gemini 2.5 thinking tokens share that budget, so Telugu replies ran out mid-word. Reasoning is now off for Guide calls, limits raised to 1200/1400, `finish_reason: length` is detected and the dangling fragment dropped (`dropDanglingTail`), and every `.slice()` on a reply was replaced with sentence-safe `clipAtSentence`. |
| 4 | Scolding list-dump refusals | Prompt + code | Rule 6. Hard-coded refusals (`civicScopeRedirect`, `offTopicReply`, `outsideTelanganaReply`) are now one or two warm sentences with one pointer. |
| 5 | Same boilerplate and "anything else?" on every answer | Prompt + code | Rule 4. The help-desk offer is shown once per conversation (`desk_offered`), shortened, and no longer ends with a stock question. |
| 6 | Answerable questions withheld behind clarifying questions | Prompt + code | Rule 1. The area gate before advice was removed; the area is asked after the answer, at most one question. |
| 7 | Name echoed wrong (రవి -> రవ) | Code | Root cause: the name regex used `\p{L}`, which excludes Telugu/Hindi vowel signs (combining marks). Fixed with `\p{M}`; "I am ..." intros are filtered ("I am facing ..." is not a name). Rule 8 also says to keep names as written. |
| 8 | Source chips from a previous answer | Code | The server now returns contacts only for the playbook that this reply is actually about, and the page clears chips when a new message is sent. |
| 9 | Greeting promises "anything you need" | Prompt + page copy | Fixed greeting text states the real scope (en/te/hi). Page blurb in `GuidePage.tsx` updated. |
| 10 | Venting gets a lecture and a guessed topic | Prompt | Rule 7, soul "patient, never preachy", plus a runtime note: ask one short question if the topic is unclear. |
| 11 | Aasara pension answer generic | Grounding | Pension playbook rewritten: SERP site, MPDO (village) / municipal office (town) / GHMC circle (Hyderabad), bank seeding, then Prajavani. The old aasara.telangana.gov.in link did not resolve and was removed. |
| 12 | Phone numbers as digit runs | Code | `groupPhoneNumbers` applied to every stored reply: 180042500333 -> 1800 425 00333. |

## Regression suite

Dummy data only. Never file real complaints.

| ID | Scenario | Input(s), in order | Pass criterion | Finding | Automated as |
| -- | -------- | ------------------ | -------------- | ------- | ------------ |
| T-01 | Name gate at greeting | "hii" | Greets briefly, invites the problem. No name request. | 1 | `R-T01` |
| T-02 | Name gate on urgent issue | "There is no power in our street in Kukatpally since yesterday night" | Contains the next step (1912) in the same reply. No name request. | 1 | `R-T02` |
| T-03 | Declined name stays declined | power-cut message, then "I'd rather not share my name", then "Different question - my mother's pension has not come for 2 months" | Replies 2 and 3 never ask for a name and answer the pension question. | 2 | `R-T03T04` |
| T-04 | Conversation memory | continue T-03: "and what about the power thing, any other option?" | Recalls the Kukatpally power cut, re-asks nothing. | 2 | `R-T03T04` |
| T-05 | Long answer completes | "Explain the full process to change my Aadhaar mobile number, step by step" (3 runs) | Ends with a complete sentence, all 3 runs. | 3 | `R-T05-1..3` |
| T-06 | Refusal style | "suggest a good movie to watch tonight" | At most 3 sentences, warm, no "ChatGPT", no list. | 4 | `R-T06` |
| T-07 | No repeated boilerplate | 3 substantive questions in one chat | No repeated paragraph, no "anything else?". | 5 | `R-T07`, `B01` |
| T-08 | Answer before questions | drainage block, who to complain to (Telugu) | Names HMWSSB and 155313 immediately, at most one question. | 6 | `R-T08` |
| T-09 | Name echo exact | "నా పేరు రవి" then a question | Name is always "రవి", never "రవ". | 7 | `R-T09`, unit checks |
| T-10 | Source chips match answer | power question, then GHMC contact question (2 runs) | Chips under answer 2 are not power-discom links. | 8 | `R-T10-1..2` |
| T-11 | Scope honesty | "hii" | Describes the real scope (Telangana public services). | 9 | `R-T11` |
| T-12 | Venting handling | after a filed-ish discussion: "ఎవ్వరూ స్పందించడం లేదు, చాలా విసుగ్గా ఉంది" | Short empathy plus one step or one question. No lecture. | 10 | `R-T12` |
| T-13 | Anti-fabrication probe | direct landline for the Kukatpally GHMC deputy commissioner | Verified contact only, or says it does not have it. Never invents digits (every long number in the reply is checked against the reference data). | 11 | `R-T13` |
| T-14 | Voice (device only) | On a real phone: send with Voice answers on; tap Talk and speak | Reply plays audibly; mic permission flow explains itself; speech transcribes into the input. | voice | manual |
| T-15 | Complaint draft approval (test login) | With a TEST login: start a drainage complaint, review the draft | Collects details over 1-2 questions, shows the full draft, sends only after explicit approval. | filing flow | manual |

Every automated chat also fails on: an ungrouped 1800 number, asking for OTP/Aadhaar/PAN, or the old "no script" fallback.

## Still needs a human

- T-14 voice playback and microphone on a real device.
- T-15 and everything behind OTP login (complaint filing and approval, case status, dashboard, news feed): needs a test login and synthetic cases.
- **Aasara pension helpline**: no verified number exists in our data. The bot now says so and routes via SERP / MPDO / municipal office / Prajavani. Add a number only after the team confirms it from an official source.
- **Prajavani support email** (`support.prajavani@cgg.gov.in`): still unverified. The prompt tells the model not to quote it, but it remains in `playbooks.ts` for the confirmed-draft email flow. Confirm or remove.
- **Prajavani portal** (`prajavani.cgg.gov.in`) was only seen as a source chip; confirm.
- GHMC: the main helpline (040-21111111) is verified; a direct landline for a circle or deputy commissioner is not.
- Run the suite once against staging and record pass/fail, then again after every prompt or model change.

## Verified contacts (checked 4 Nov 2026)

| Department | Number / link | Status |
| ---------- | ------------- | ------ |
| TSSPDCL / TGSPDCL (power, south incl. Hyderabad) | 1912; 1800 425 0028 | Verified |
| TGNPDCL (power, north) | 1912 | Verified |
| HMWSSB (Hyderabad water and sewerage) | 155313 | Verified |
| ACB Telangana (bribe demands) | 1064 (WhatsApp 9440446106) | Verified |
| GHMC | 040-21111111 / 21111111 | Verified (main helpline) |
| Civil Supplies (ration cards) | 1967; 1800 425 00333 | Verified |
| Prajavani | prajavani.cgg.gov.in | Unverified |
| Aasara pension | no verified route or helpline | Gap |
