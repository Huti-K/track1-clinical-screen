import type { PatientRecord } from "@track1/patient-record";
import type { CheckGap, Contradiction, Fact, Passage, SafetyCheck } from "@track1/shared";
import { assess } from "./assess.js";
import { sourceOf } from "./measurements.js";

/** Words that put the task before or around an operation; intra- and postoperative work is not. */
const SURGERY =
  /surg(ery|eries|ical|eon)|\boperations?\b|\b(pre|peri)-?op(erative(ly)?)?\b|an(a)?esthe|\w+ectomy\b|\bresection|resektion|narkose|präoperativ/i;
/** Words that put CT, MRI, angiography or contrast media in the task. */
const IMAGING =
  /\b(CTA?|MRI|MRT|MRA)\b|comput\w*\s?tomogra|magnetic resonance|kernspin|angiogra|contrast|kontrastmittel|radiolog/i;
/** MR imaging, whose gadolinium contrast is not the iodinated contrast metformin matters for. */
const MR = /\b(MRI|MRT|MRA)\b|magnetic resonance|kernspin|gadolin/i;
/** CT and angiography, which use iodinated contrast. */
const IODINATED = /\bCTA?\b|comput\w*\s?tomogra|angiogra|iodinated|\bjod/i;

/** A contrast reaction as the letters record it, such as `KM-Allergie` or `Kontrastmittelallergie`. */
const CONTRAST_ALLERGY =
  /\bKM-?\s?(allergie|unverträglichkeit|reaktion)|kontrastmittel-?\s?(allergie|unverträglichkeit|reaktion)|jodallergie|contrast (media |medium )?(allergy|reaction)/i;
/** A named agent or agent type, which tells iodinated from gadolinium contrast. */
const AGENT =
  /jod|iod|gadolin|\bgd\b|ultravist|omnipaque|imeron|visipaque|iopromid|iohexol|iomeprol|iopamidol|iodixanol|dotarem|gadovist|prohance|multihance|clariscan|gadobutrol|gadoter/i;
/** Kidney function as the letters record it: creatinine, GFR or a kidney diagnosis. */
const RENAL =
  /kreatinin|creatinin|\b(e?GFR|CKD)\b|nieren(funktion|insuff|versagen|schwäche)|harnstoff|cystatin/i;

type DrugClass = {
  tag: string;
  /** What to do before the operation, in the words of the leaflet the class comes from. */
  advice: string;
  /** English generic name, and how German-language letters write it: generic or brand. */
  drugs: Record<string, RegExp>;
  /** Text after the name that takes the drug off the list, such as a patch for oral-only HRT. */
  except?: RegExp;
};

const PRE_OP = "Royal Berkshire pre-op leaflet";
const SICK_DAY = "NHS sick-day rules";
const ACE_SARTAN = `${PRE_OP}: under general anaesthesia stop on the morning of surgery; under local anaesthesia continue.`;
const DIABETES = `${PRE_OP}: may need reducing or pausing before surgery; needs a plan from pre-op assessment.`;
const NSAID = `${PRE_OP}: before spinal surgery stop 3 days before.`;
const SICK = `${SICK_DAY}: stop while dehydrated or not eating and drinking; restart after 24 to 48 hours of eating and drinking normally.`;

/**
 * The drugs to reduce or pause before an operation. Every drug the Royal Berkshire NHS leaflet
 * "Reducing / pausing medication immediately before surgery" (RBFT Pre-Op Assessment, Nov 2025,
 * `references/reducing_pausing-medication-immediately-before-surgery_nov25.pdf`) names is listed,
 * with its advice; its progesterone-only pill continues as normal and is left out. Austrian generics
 * and brands of the same classes are added, such as phenprocoumon as the vitamin K antagonist
 * letters here use. The sick-day drugs the leaflet does not name, SGLT2 inhibitors and diuretics,
 * stay on the list after the NHS renal leaflet "Medicines Sick Day Rules" (LN1142, revised 05/2024,
 * `references/medicines-sick-day-rules.pdf`).
 */
const SURGERY_DRUGS: DrugClass[] = [
  {
    tag: "Anticoagulant",
    advice: `${PRE_OP}: needs a dose plan from 5 days before to 3 days after the operation.`,
    drugs: {
      warfarin: /\b(warfarin|coumadin|lawarin)\b/i,
      phenprocoumon: /\b(phenprocoumon|marcoumar|marcumar)\b/i,
      apixaban: /\b(apixaban|eliquis)\b/i,
      rivaroxaban: /\b(rivaroxaban|xarelto)\b/i,
      edoxaban: /\b(edoxaban|lixiana)\b/i,
      dabigatran: /\b(dabigatran|pradaxa)\b/i,
      tinzaparin: /\b(tinzaparin|innohep)\b/i,
      enoxaparin: /\b(enoxaparin|lovenox|clexane)\b/i,
      dalteparin: /\b(dalteparin|fragmin)\b/i,
    },
  },
  {
    tag: "Antiplatelet",
    advice: `${PRE_OP}: needs a dose plan from 7 days before to 3 days after the operation.`,
    drugs: {
      aspirin: /\b(thrombo ?ass|aspirin|acetylsalicylsäure|ass)\b/i,
      dipyridamole: /\b(dipyridamole?|persantin|aggrenox)\b/i,
      clopidogrel: /\b(clopidogrel|plavix)\b/i,
      ticagrelor: /\b(ticagrelor|brilique)\b/i,
      prasugrel: /\b(prasugrel|efient)\b/i,
    },
  },
  {
    tag: "ACE inhibitor",
    advice: ACE_SARTAN,
    drugs: {
      ramipril: /\b(ramipril|delix|tritace|hypren)\b/i,
      enalapril: /\b(enalapril|xanef|renitec)\b/i,
      lisinopril: /\b(lisinopril|acemin|zestril)\b/i,
      perindopril: /\b(perindopril|coversum|coversyl)\b/i,
      captopril: /\b(captopril|lopirin|tensobon)\b/i,
      quinapril: /\b(quinapril|accupro)\b/i,
      benazepril: /\b(benazepril|cibacen)\b/i,
      fosinopril: /\bfosinopril\b/i,
      trandolapril: /\btrandolapril\b/i,
    },
  },
  {
    tag: "Sartan",
    advice: ACE_SARTAN,
    drugs: {
      candesartan: /\b(candesartan|blopress|atacand)\b/i,
      losartan: /\b(losartan|cozaar|lorzaar)\b/i,
      valsartan: /\b(valsartan|diovan)\b/i,
      irbesartan: /\b(irbesartan|aprovel|karvea)\b/i,
      telmisartan: /\b(telmisartan|micardis)\b/i,
      olmesartan: /\b(olmesartan|olmetec)\b/i,
      "sacubitril/valsartan": /\bentresto\b/i,
    },
  },
  {
    tag: "Insulin",
    advice: DIABETES,
    drugs: {
      insulin:
        /\b(insulin|lantus|levemir|tresiba|toujeo|abasaglar|semglee|novorapid|fiasp|humalog|lyumjev|apidra|actrapid|insulatard|mixtard|huminsulin|insuman)\b/i,
    },
  },
  {
    tag: "Metformin",
    advice: DIABETES,
    drugs: { metformin: /\b(metformin|glucophage|siofor|diabesin|mescorit|juformin)\b/i },
  },
  {
    tag: "Sulfonylurea",
    advice: DIABETES,
    drugs: {
      gliclazide: /\b(gliclazide?|diamicron)\b/i,
      glipizide: /\b(glipizide?|minidiab)\b/i,
      glimepiride: /\b(glimepiride?|amaryl)\b/i,
      glibenclamide: /\b(glibenclamide?|euglucon|daonil)\b/i,
      gliquidone: /\b(gliquidone?|glurenorm)\b/i,
    },
  },
  {
    tag: "Glitazone",
    advice: DIABETES,
    drugs: { pioglitazone: /\b(pioglitazone?|actos)\b/i },
  },
  {
    tag: "GLP-1 agonist",
    advice: DIABETES,
    drugs: {
      exenatide: /\b(exenatide?|byetta|bydureon)\b/i,
      liraglutide: /\b(liraglutide?|victoza|saxenda)\b/i,
      lixisenatide: /\b(lixisenatide?|lyxumia)\b/i,
      dulaglutide: /\b(dulaglutide?|trulicity)\b/i,
      semaglutide: /\b(semaglutide?|ozempic|rybelsus|wegovy)\b/i,
      tirzepatide: /\b(tirzepatide?|mounjaro)\b/i,
    },
  },
  {
    tag: "SGLT2 inhibitor",
    advice: SICK,
    drugs: {
      dapagliflozin: /\b(dapagliflozin|forxiga)\b/i,
      empagliflozin: /\b(empagliflozin|jardiance)\b/i,
      canagliflozin: /\b(canagliflozin|invokana)\b/i,
      ertugliflozin: /\b(ertugliflozin|steglatro)\b/i,
    },
  },
  {
    tag: "Diuretic",
    advice: SICK,
    drugs: {
      furosemide: /\b(furosemide?|lasix)\b/i,
      torasemide: /\b(torasemide?|torem|unat)\b/i,
      bumetanide: /\b(bumetanide?|burinex)\b/i,
      hydrochlorothiazide: /\b(hydrochlorothiazide?|esidrix)\b/i,
      bendroflumethiazide: /\b(bendroflumethiazide?|aprinox|neo-naclex)\b/i,
      chlortalidone: /\b(chlortalidone?|hygroton)\b/i,
      indapamide: /\b(indapamide?|natrilix)\b/i,
      metolazone: /\b(metolazone?|zaroxolyn|metenix)\b/i,
      xipamide: /\bxipamide?\b/i,
      spironolactone: /\b(spironolactone?|aldactone)\b/i,
      eplerenone: /\b(eplerenone?|inspra)\b/i,
    },
  },
  {
    tag: "Oestrogen",
    advice: `${PRE_OP}: before major or leg surgery, or when she will not walk afterwards, stop 4 weeks before; restart once walking.`,
    drugs: {
      "combined pill": /\b(ethinylestradiol|microgynon|marvelon|yasmin)\b/i,
      "oral HRT": /\b(estradiol|östradiol|oestradiol|estrofem|progynova|premarin)\b/i,
    },
    // The leaflet stops oral HRT only.
    except: /transdermal|pflaster|patch|\bgel\b|vaginal|spray/i,
  },
  {
    tag: "NSAID",
    advice: NSAID,
    drugs: {
      ketorolac: /\b(ketorolac|toradol)\b/i,
      ibuprofen: /\b(ibuprofen|nurofen|brufen)\b/i,
      diclofenac: /\b(diclofenac|voltaren)\b/i,
      naproxen: /\b(naproxen|aleve)\b/i,
      etoricoxib: /\b(etoricoxib|arcoxia)\b/i,
      celecoxib: /\b(celecoxib|celebrex)\b/i,
      meloxicam: /\bmeloxicam\b/i,
      indometacin: /\bindometacin\b/i,
    },
  },
  {
    tag: "Herbal or vitamin E",
    advice: `${PRE_OP}: stop 2 weeks before surgery.`,
    drugs: {
      "CBD oil": /\b(CBD|cannabidiol)\b/i,
      echinacea: /\b(echinacea|echinacin)\b/i,
      ephedra: /\bephedra\b/i,
      garlic: /\b(garlic|knoblauch)\b/i,
      ginkgo: /\b(ginkgo|tebonin|cerebokan)\b/i,
      ginseng: /\bginseng\b/i,
      kava: /\bkava\b/i,
      "St John's wort": /\b(johanniskraut|hypericum|jarsin|st\.? john'?s wort)\b/i,
      valerian: /\b(valerian|baldrian)\b/i,
      "vitamin E": /\b(vitamin E|tocopherol)\b/i,
    },
  },
];

/** The classes the NHS renal leaflet "Medicines Sick Day Rules" names. */
const SICK_DAY_CLASSES = new Set([
  "ACE inhibitor",
  "Sartan",
  "NSAID",
  "Diuretic",
  "Metformin",
  "SGLT2 inhibitor",
]);

const ORDER = SURGERY_DRUGS.flatMap((c) => Object.keys(c.drugs));

/** A dose such as `1000mg`, `5 mcg` or `49/51mg`: drug lines carry one, passing remarks rarely do. */
const DOSE = /(\d+(?:[.,]\d+)?(?:\/\d+(?:[.,]\d+)?)?)\s?(mg|mcg|µg|ug|g|ml|IE|I\.E\.)(?![a-zäöü])/i;
/** How far after the drug's name its dose may start, as in `Clexane Injektionslösung 40mg`. */
const DOSE_WITHIN = 24;

/**
 * The dose right after a drug's name, in the text that follows it. A dose further on, or after a
 * comma or a sentence end, belongs to something else, as in `Furosemid … 7 kg. Die … auf 5 mg`.
 */
function doseAfter(rest: string): RegExpExecArray | null {
  const dose = DOSE.exec(rest);
  if (!dose || dose.index > DOSE_WITHIN) return null;
  return /[,;]|\.\s+[A-ZÄÖÜ]/.test(rest.slice(0, dose.index)) ? null : dose;
}

/** A line that ends a drug rather than giving it. */
const STOPPED = /abgesetzt|pausiert|gestoppt|beendet|abgebrochen|nicht mehr/i;
/** The table's columns morning, midday, evening and night, such as `1 0 1/2 0`. */
const SLOTS = /(?:^|\s)([\d½¼/]+)\s+([\d½¼/]+)\s+([\d½¼/]+)\s+([\d½¼/]+)(?=\s|$)/;
const ROUTES: [RegExp, string][] = [
  [/\boral\b|\bp\.o\./i, "oral"],
  [/\bs\.c\.|subkutan/i, "s.c."],
  [/\bi\.v\.|intravenös/i, "i.v."],
  [/\btransdermal/i, "transdermal"],
];

/** One drug of the fixed classes named with a dose in one passage. */
type Mention = {
  tag: string;
  advice: string;
  generic: string;
  /** The name as the passage writes it, such as `Blopress`, and where. */
  written: string;
  at: number;
  passage: Passage;
  date: string;
};

/** A heading over the drugs a patient takes, such as `Entlassungsmedikation` or `Dauermedikation`. */
const MEDICATION = /medikation/i;

/** Rows of a medication table: each gives a drug, with or without a dose, as an insulin pump. */
function medicationRows(record: PatientRecord): Set<string> {
  return new Set(
    record.documents.flatMap((doc) =>
      (doc.layout ?? []).flatMap((block) =>
        block.kind === "table"
          ? block.rows
              .map((row) => row.passageId)
              .filter((id) => MEDICATION.test(record.passage(id)?.section ?? ""))
          : [],
      ),
    ),
  );
}

function mentions(record: PatientRecord): Mention[] {
  const rows = medicationRows(record);
  return record.documents.flatMap((doc) =>
    doc.passages.flatMap((passage) => {
      if (STOPPED.test(passage.text)) return [];
      return SURGERY_DRUGS.flatMap(({ tag, advice, drugs, except }) =>
        Object.entries(drugs).flatMap(([generic, pattern]) => {
          const match = pattern.exec(passage.text);
          const rest = match && passage.text.slice(match.index + match[0].length);
          return match &&
            rest !== null &&
            (rows.has(passage.id) || doseAfter(rest)) &&
            !except?.test(rest)
            ? [
                {
                  tag,
                  advice,
                  generic,
                  written: match[0],
                  at: match.index,
                  passage,
                  date: doc.date,
                },
              ]
            : [];
        }),
      );
    }),
  );
}

/** Each drug's newest mention, a table row before a remark of the same day, in class order. */
function newestPerDrug(found: readonly Mention[]): Mention[] {
  const newest = new Map<string, Mention>();
  const rank = (m: Mention) => `${m.date} ${SLOTS.test(m.passage.text) ? 1 : 0}`;
  for (const m of found) {
    const seen = newest.get(m.generic);
    if (!seen || rank(m) > rank(seen)) newest.set(m.generic, m);
  }
  return [...newest.values()].sort((a, b) => ORDER.indexOf(a.generic) - ORDER.indexOf(b.generic));
}

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** "Blopress 8mg oral 1 0 1/2 0 ST" reads "Blopress (candesartan) 8 mg oral 1-0-½". */
function drugValue({ generic, written, at, passage }: Mention): string {
  const rest = passage.text.slice(at + written.length);
  const dose = doseAfter(rest);
  const slots = SLOTS.exec(rest)
    ?.slice(1)
    .map((slot) => slot.replace("1/2", "½").replace("1/4", "¼"));
  // A generic in German spelling, such as `Exenatid`, reads as the English generic.
  const brand = written.toLowerCase().replace(/e$/, "") !== generic.replace(/e$/, "");
  return [
    brand ? `${written} (${generic})` : capitalized(generic),
    dose && `${dose[1]?.replace(",", ".")} ${dose[2]}`,
    ROUTES.find(([pattern]) => pattern.test(rest))?.[1],
    slots && (slots[3] === "0" ? slots.slice(0, 3) : slots).join("-"),
  ]
    .filter(Boolean)
    .join(" ");
}

type Item = Fact & { tag: string };

function drugItem(record: PatientRecord, m: Mention): Item {
  return {
    tag: m.tag,
    label: capitalized(m.generic),
    value: drugValue(m),
    sources: [sourceOf(record, m.passage, m.passage.text)],
  };
}

const newestSource = (fact: Fact) =>
  fact.sources
    .map((s) => s.documentDate)
    .sort()
    .at(-1) ?? "";

/**
 * The topic in English: the most specific checked fact that cites one of its passages, or else the
 * newest passage as the letter writes it.
 */
function topicItem(
  record: PatientRecord,
  tag: string,
  passages: readonly Passage[],
  topic: RegExp,
  known: readonly Fact[],
): Item {
  const ids = new Set(passages.map((p) => p.id));
  const said = known
    .filter(
      (f) => topic.test(`${f.label} ${f.value}`) && f.sources.some((s) => ids.has(s.passageId)),
    )
    .sort(
      (a, b) =>
        a.sources.length - b.sources.length || newestSource(b).localeCompare(newestSource(a)),
    )[0];
  if (said) return { tag, label: said.label, value: said.value, sources: said.sources };
  const newest = passages.at(-1) as Passage;
  return { tag, label: tag, value: newest.text, sources: [sourceOf(record, newest, newest.text)] };
}

type Check = Omit<SafetyCheck, "items"> & { items: Item[] };

function surgeryCheck(record: PatientRecord, drugs: readonly Mention[]): Check {
  return {
    kind: "surgery",
    title: "Review before surgery",
    rule: 'Fixed list after the Royal Berkshire pre-op leaflet "Reducing / pausing medication immediately before surgery" (Nov 2025): blood thinners, ACE inhibitors, sartans, diabetes drugs, oral oestrogens, NSAIDs, herbal medicines and vitamin E, plus SGLT2 inhibitors and diuretics after the NHS sick-day rules.',
    // Each drug says what its leaflet advises before the operation.
    items: newestPerDrug(drugs).map((m) => ({ ...drugItem(record, m), detail: m.advice })),
    gaps: [],
    passages: [...new Set(drugs.map((m) => m.passage.id))],
  };
}

/** The sick-day drugs apply whatever the task: they are what a patient stops when dehydrated. */
function sickDayCheck(record: PatientRecord, drugs: readonly Mention[]): Check {
  const listed = drugs.filter((m) => SICK_DAY_CLASSES.has(m.tag));
  return {
    kind: "sickDay",
    title: "Sick-day rules",
    rule: 'Fixed list after the NHS renal leaflet "Medicines Sick Day Rules" (LN1142, 05/2024): ACE inhibitors, sartans, NSAIDs, diuretics, metformin and SGLT2 inhibitors.',
    items: newestPerDrug(listed).map((m) => ({ ...drugItem(record, m), detail: SICK })),
    gaps: [],
    passages: [...new Set(listed.map((m) => m.passage.id))],
  };
}

function contrastCheck(
  record: PatientRecord,
  occasion: string,
  drugs: readonly Mention[],
  known: readonly Fact[],
): Check {
  const all = record.documents.flatMap((doc) => doc.passages);
  const allergies = all.filter((p) => CONTRAST_ALLERGY.test(p.text));
  const renal = all.filter((p) => RENAL.test(p.text));
  const mr = MR.test(occasion);
  const iodinated = IODINATED.test(occasion);
  // Gadolinium alone does not call for stopping metformin; CT or unnamed contrast may be iodinated.
  const metformin = iodinated || !mr ? drugs.filter((m) => m.generic === "metformin") : [];
  const items: Item[] = [];
  const gaps: CheckGap[] = [];
  if (allergies.length > 0)
    items.push(topicItem(record, "Allergy", allergies, /allerg|contrast|reaction/i, known));
  else
    gaps.push({
      title: "Contrast allergy",
      note: "No contrast reaction in the documents.",
      action: "Ask about earlier contrast reactions.",
    });
  items.push(...newestPerDrug(metformin).map((m) => drugItem(record, m)));
  if (renal.length > 0)
    items.push(topicItem(record, "Kidney", renal, /kidney|renal|creatinin|GFR/i, known));
  else
    gaps.push({
      title: "Kidney function",
      note: "No creatinine or eGFR in the documents.",
      action: "Check creatinine and eGFR before contrast.",
    });
  // Before an MRI, or contrast of no named kind, the agent decides whether the reaction applies.
  if (allergies.length > 0 && (mr || !iodinated) && !allergies.some((p) => AGENT.test(p.text)))
    gaps.push({
      title: "Agent of the earlier reaction",
      note: "The documents do not say whether it was iodinated or gadolinium contrast.",
      action: "Ask which contrast agent caused the reaction.",
    });
  return {
    kind: "contrast",
    title: "Before contrast imaging",
    rule: "Fixed checklist: contrast allergy, kidney function, and metformin before iodinated contrast.",
    items,
    gaps,
    passages: [
      ...new Set([...allergies, ...metformin.map((m) => m.passage), ...renal].map((p) => p.id)),
    ],
  };
}

/**
 * The fixed checks this task triggers, read from the situation, role and task: drugs to review
 * before an operation, and what matters before contrast imaging; the sick-day drugs on every task.
 * Every item is a documented fact;
 * `known` facts, already checked against their passages, give a topic its English wording.
 */
export function safetyChecks(
  record: PatientRecord,
  occasion: string,
  known: readonly Fact[],
  contradictions: readonly Contradiction[],
): SafetyCheck[] {
  const drugs = mentions(record);
  const checks = [
    ...(SURGERY.test(occasion) ? [surgeryCheck(record, drugs)] : []),
    ...(IMAGING.test(occasion) ? [contrastCheck(record, occasion, drugs, known)] : []),
    sickDayCheck(record, drugs),
  ];
  return checks
    .filter((check) => check.items.length > 0 || check.gaps.length > 0)
    .map((check) => {
      const [need] = assess(
        [{ title: check.title, status: "documented", facts: check.items }],
        contradictions,
        record.summary.asOf,
      );
      const facts = need?.facts ?? [];
      return {
        ...check,
        items: check.items.flatMap((item, i) => {
          const fact = facts[i];
          return fact ? [{ ...fact, tag: item.tag }] : [];
        }),
      };
    });
}
