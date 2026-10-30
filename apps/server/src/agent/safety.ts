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
  /** English generic name, and how German-language letters write it: generic or brand. */
  drugs: Record<string, RegExp>;
};

/**
 * Classes commonly paused or adjusted before an operation: the sick-day drugs, which risk lactic
 * acidosis, ketoacidosis, hypoglycaemia, kidney injury or hypotension in a fasting patient, and
 * GLP-1 agonists, which slow gastric emptying.
 */
const SURGERY_DRUGS: DrugClass[] = [
  {
    tag: "Metformin",
    drugs: { metformin: /\b(metformin|glucophage|siofor|diabesin|mescorit|juformin)\b/i },
  },
  {
    tag: "SGLT2 inhibitor",
    drugs: {
      dapagliflozin: /\b(dapagliflozin|forxiga)\b/i,
      empagliflozin: /\b(empagliflozin|jardiance)\b/i,
      canagliflozin: /\b(canagliflozin|invokana)\b/i,
      ertugliflozin: /\b(ertugliflozin|steglatro)\b/i,
    },
  },
  {
    tag: "Sulfonylurea",
    drugs: {
      glimepiride: /\b(glimepiride?|amaryl)\b/i,
      gliclazide: /\b(gliclazide?|diamicron)\b/i,
      glibenclamide: /\b(glibenclamide?|euglucon|daonil)\b/i,
      gliquidone: /\b(gliquidone?|glurenorm)\b/i,
    },
  },
  {
    tag: "ACE inhibitor",
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
    tag: "Diuretic",
    drugs: {
      furosemide: /\b(furosemide?|lasix)\b/i,
      torasemide: /\b(torasemide?|torem|unat)\b/i,
      hydrochlorothiazide: /\b(hydrochlorothiazide?|esidrix)\b/i,
      chlortalidone: /\b(chlortalidone?|hygroton)\b/i,
      indapamide: /\b(indapamide?|natrilix)\b/i,
      xipamide: /\bxipamide?\b/i,
      spironolactone: /\b(spironolactone?|aldactone)\b/i,
      eplerenone: /\b(eplerenone?|inspra)\b/i,
    },
  },
  {
    tag: "NSAID",
    drugs: {
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
    tag: "GLP-1 agonist",
    drugs: {
      exenatide: /\b(exenatide?|byetta|bydureon)\b/i,
      liraglutide: /\b(liraglutide?|victoza|saxenda)\b/i,
      dulaglutide: /\b(dulaglutide?|trulicity)\b/i,
      semaglutide: /\b(semaglutide?|ozempic|rybelsus|wegovy)\b/i,
      lixisenatide: /\b(lixisenatide?|lyxumia)\b/i,
      tirzepatide: /\b(tirzepatide?|mounjaro)\b/i,
    },
  },
];

const ORDER = SURGERY_DRUGS.flatMap((c) => Object.keys(c.drugs));

/** A dose such as `1000mg` or `5 mcg`: drug lines carry one, passing remarks rarely do. */
const DOSE = /(\d+(?:[.,]\d+)?)\s?(mg|mcg|µg|ug|g|ml|IE|I\.E\.)(?![a-zäöü])/i;
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
  generic: string;
  /** The name as the passage writes it, such as `Blopress`, and where. */
  written: string;
  at: number;
  passage: Passage;
  date: string;
};

function mentions(record: PatientRecord): Mention[] {
  return record.documents.flatMap((doc) =>
    doc.passages.flatMap((passage) => {
      if (!DOSE.test(passage.text) || STOPPED.test(passage.text)) return [];
      return SURGERY_DRUGS.flatMap(({ tag, drugs }) =>
        Object.entries(drugs).flatMap(([generic, pattern]) => {
          const match = pattern.exec(passage.text);
          return match
            ? [{ tag, generic, written: match[0], at: match.index, passage, date: doc.date }]
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
  const dose = DOSE.exec(rest);
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
    rule: "Fixed list: sick-day drugs (metformin, SGLT2 inhibitors, sulfonylureas, ACE inhibitors, sartans, diuretics, NSAIDs) and GLP-1 agonists.",
    items: newestPerDrug(drugs).map((m) => drugItem(record, m)),
    gaps: [],
    passages: [...new Set(drugs.map((m) => m.passage.id))],
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
 * before an operation, and what matters before contrast imaging. Every item is a documented fact;
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
