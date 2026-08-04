import { cli, Strategy } from '@agentrhq/webcmd/registry';
import {
  ArgumentError,
  CommandExecutionError,
} from '@agentrhq/webcmd/errors';

const BASE = 'https://www.grad.uc.edu';
const UNIVERSITY = 'University of Cincinnati';
const CHECKED_DATE = '2026-08-03';
const PROGRAM_FINDER = `${BASE}/`;
const PROGRAM_JSON = `${BASE}/content/grad/jcr:content/main/responsive_section_2/par/program-finder.ListAllPrograms.json`;
const REQUIREMENTS = 'https://www.admissions.uc.edu/apply/graduate/requirements.html';
const GRAD_ADMISSION = 'https://www.admissions.uc.edu/apply/graduate.html';
const DEGREE_LEVELS = new Set(['all', 'masters', 'certificate', 'diploma', 'professional', 'doctorate']);
const REQUEST_TIMEOUT_MS = 25000;

const COLUMNS = [
  'Course Name',
  'Course URL',
  'University \nname',
  'Intake Month',
  'Substream/\nSpecialisation',
  'App fees',
  'Degree Level',
  'Study Level',
  'Duration\n(in months)',
  'Study option',
  'Program Type',
  'Partner',
  'Tution fees \n(per year)',
  'Total Tution \nFees',
  'IELTS \n(Overall & Subscores)',
  'ielts_reading_score',
  'ielts_writing_score',
  'ielts_listening_score',
  'ielts_speaking_score',
  'TOEFL\n(Overall & Subscores)',
  'toefl_reading_score',
  'toefl_writing_score',
  'toefl_listening_score',
  'toefl_speaking_score',
  'PTE\n(Overall & Subscores)',
  'pte_reading_score',
  'pte_writing_score',
  'pte_listening_score',
  'pte_speaking_score',
  'Duolingo\n(Overall & Subscores)',
  'duolingo_comprehension_score',
  'duolingo_literacy_score',
  'duolingo_conversation_score',
  'duolingo_production_score',
  'Is Waiver \nProvided?',
  'Waiver Info',
  'Is MOI \naccepted?',
  'Share list, if any',
  'GRE Required',
  'GMAT Required',
  'GRE/GMAT Scores',
  '12th scores',
  'Min UG score',
  '15 years of\nEducation Allowed?',
  'Gap Years',
  'Backlogs',
  'Work \nExperience \nRequired?',
  'Main Entry \nRequirements',
  'Status',
  'Intake status(open/close)\n(eg: Fall (september)-Open\nSpring(January)- Closed)',
  'Remarks (if any)',
  'Reference Links (if any)',
];

const CSV_OUTPUT = process.argv.some((arg, index, argv) =>
  /^(?:-f|--format)=csv$/.test(arg) || ((arg === '-f' || arg === '--format') && argv[index + 1] === 'csv')
);
const OUTPUT_COLUMNS = CSV_OUTPUT
  ? COLUMNS.map((column) => /[,"\r\n]/.test(column) ? `"${column.replace(/"/g, '""')}"` : column)
  : COLUMNS;

function decodeHtml(value = '') {
  return String(value)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#0*39;|&rsquo;/gi, "'")
    .replace(/&lsquo;/gi, "'")
    .replace(/&ndash;|&mdash;/gi, '-')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function text(value = '') {
  return decodeHtml(String(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function parseOptions(args) {
  const degreeLevel = String(args['degree-level'] ?? 'all').toLowerCase();
  if (!DEGREE_LEVELS.has(degreeLevel)) {
    throw new ArgumentError(`--degree-level must be one of: ${[...DEGREE_LEVELS].join(', ')}`);
  }
  if (args.count === undefined || args.count === null || args.count === '') return { degreeLevel, count: null };
  const count = Number(args.count);
  if (!Number.isInteger(count) || count <= 0) throw new ArgumentError('--count must be a positive integer');
  return { degreeLevel, count };
}

function canonicalUrl(value) {
  const url = new URL(value, BASE);
  if (!/(^|\.)uc\.edu$/i.test(url.hostname)) return '';
  url.protocol = 'https:';
  url.hash = '';
  return url.href;
}

function durationMonths(duration, unit) {
  const n = Number(duration);
  if (!Number.isFinite(n) || n <= 0) return '';
  const u = String(unit || '').toLowerCase();
  if (u.startsWith('year')) return String(Math.round(n * 12));
  if (u.startsWith('month')) return String(Math.round(n));
  if (u.startsWith('semester')) return String(Math.round(n * 4));
  return '';
}

function degreeTags(program) {
  const degree = String(program.degree || '').toUpperCase();
  const bucket = String(program.degreeBucket || '').toLowerCase();
  const name = String(program.planDescription || '').toLowerCase();
  const tags = new Set();

  if (bucket.includes('master') || /^M/.test(degree) || ['EDS', 'LLM'].includes(degree)) tags.add('masters');
  if (bucket.includes('certificate') || ['GC', 'GCM', 'PB', 'MC'].includes(degree)) tags.add('certificate');
  if (bucket.includes('doctoral') || /doctor/.test(name) || ['PHD', 'EDD', 'DNP', 'DMA', 'DCLS', 'OTD', 'PHARMD', 'DPT', 'SLPD'].includes(degree)) tags.add('doctorate');
  if (degree === 'AD' || /diploma/.test(name)) tags.add('diploma');
  if (['AUD', 'DNP', 'DPT', 'JD', 'LLM', 'MBA', 'MHA', 'MPH', 'MSN', 'MSW', 'OTD', 'PHARMD', 'SLPD'].includes(degree)) tags.add('professional');

  return [...tags];
}

function applicationFee(program) {
  const org = String(program.organizationDescription || '');
  if (program.degreeBucket === 'Graduate Certificate') return 'USD 20 domestic / USD 25 international for Graduate Certificates';
  if (org.includes('Engineering')) return 'USD 75 domestic / USD 80 international for CEAS';
  if (/Physiology/i.test(program.planDescription || '') && program.degree === 'MS') return 'USD 140 for Physiology (MS)';
  return 'USD 65 domestic / USD 70 international for most graduate degree programs';
}

async function fetchPrograms() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(PROGRAM_JSON, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Webcmd Cincinnati public data export)' },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) throw new CommandExecutionError(`UC program finder request failed: HTTP ${response.status}`);
    const data = await response.json();
    const programs = data?.summaryArray;
    if (!Array.isArray(programs) || programs.length < 300) {
      throw new CommandExecutionError(`UC program finder JSON shape changed: rows=${programs?.length ?? 'missing'}`);
    }
    return programs
      .map((item) => ({ ...(item.baseInfo || {}), generalInterestAreas: item.generalInterestAreas || [] }))
      .filter((item) => ['Graduate', 'Law'].includes(item.career));
  } catch (error) {
    if (error instanceof CommandExecutionError) throw error;
    throw new CommandExecutionError(`UC program finder request failed: ${error.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeRecord(program) {
  const row = Object.fromEntries(COLUMNS.map((column) => [column, '']));
  const url = canonicalUrl(program.learnMorePath);
  const interestAreas = (program.generalInterestAreas || []).map((area) => area.name).filter(Boolean);
  const degree = [program.degreeBucket, program.degree ? `(${program.degree})` : ''].filter(Boolean).join(' ');
  const references = [
    `Course: ${url}`,
    `Graduate Program Finder: ${PROGRAM_FINDER}`,
    `Program JSON: ${PROGRAM_JSON}`,
    `Graduate Admission: ${GRAD_ADMISSION}`,
    `Graduate Requirements: ${REQUIREMENTS}`,
  ];

  row['Course Name'] = text(program.planDescription);
  row['Course URL'] = url;
  row['University \nname'] = UNIVERSITY;
  row['Substream/\nSpecialisation'] = interestAreas.join(' | ');
  row['App fees'] = applicationFee(program);
  row['Degree Level'] = degree;
  row['Study Level'] = 'PG';
  row['Duration\n(in months)'] = durationMonths(program.duration, program.durationUnit);
  row['Study option'] = text(program.location);
  row['Program Type'] = text(program.organizationDescription);
  row['Tution fees \n(per year)'] = 'Not available as a single value in official UC program data';
  row['Total Tution \nFees'] = 'Not available as an official total in UC program data';
  row['IELTS \n(Overall & Subscores)'] = '6.5 overall band';
  row['TOEFL\n(Overall & Subscores)'] = '80 iBT or 4.5 on TOEFL 1-6 scale';
  row['PTE\n(Overall & Subscores)'] = '54';
  row['Duolingo\n(Overall & Subscores)'] = '110';
  row['Is Waiver \nProvided?'] = 'Yes';
  row['Waiver Info'] = 'Automatic English-proficiency waiver for listed English-speaking countries; additional waiver options include qualifying English-instructing institution documentation.';
  row['Is MOI \naccepted?'] = 'Yes, with documentation that the institution is entirely English-instructing';
  row['Share list, if any'] = 'Bermuda | Botswana | Cameroon | Canada (except Quebec) | Cayman Islands | Denmark | Dominica | Fiji | Finland | Gambia | Ghana | Gibraltar | Grenada | Guyana | Ireland | Jamaica | Kenya | Lesotho | Liberia | Malawi | Malta | Mauritius | Montserrat | Namibia | Netherlands | New Zealand | Nigeria | Norway | Papua New Guinea | Rwanda | Scotland | Seychelles | Sierra Leone | Singapore | Solomon Islands | South Africa | St. Kitts and Nevis | St. Lucia | St. Vincent and the Grenadines | Swaziland | Sweden | Tanzania | Tonga | Trinidad and Tobago | Turks and Caicos Islands | Uganda | United States | United Kingdom | Vanuatu | Virgin Islands | Wales | Zambia | Zimbabwe';
  row['GRE Required'] = 'Not available as a single value on official program page';
  row['GMAT Required'] = 'Not available as a single value on official program page';
  row['GRE/GMAT Scores'] = 'Not available as a single value on official program page';
  row['12th scores'] = 'Not applicable (graduate admission)';
  row['Min UG score'] = "Bachelor's degree or higher; at least a B average is recommended";
  row['15 years of\nEducation Allowed?'] = 'Reduced-credit bachelor’s degrees may be accepted; determination is at the program level';
  row['Work \nExperience \nRequired?'] = 'Not available as a single value on official program page';
  row['Main Entry \nRequirements'] = "Bachelor's degree or higher from an accredited institution or international equivalent | Application and fee | Transcripts | Program-specific requirements and deadlines";
  row['Status'] = 'Active';
  row['Intake status(open/close)\n(eg: Fall (september)-Open\nSpring(January)- Closed)'] = 'Not available as a single value on official program page';
  const notPublished = 'Not available on official UC program page';
  for (const column of [
    'Substream/\nSpecialisation',
    'Intake Month',
    'Partner',
    'ielts_reading_score',
    'ielts_writing_score',
    'ielts_listening_score',
    'ielts_speaking_score',
    'toefl_reading_score',
    'toefl_writing_score',
    'toefl_listening_score',
    'toefl_speaking_score',
    'pte_reading_score',
    'pte_writing_score',
    'pte_listening_score',
    'pte_speaking_score',
    'duolingo_comprehension_score',
    'duolingo_literacy_score',
    'duolingo_conversation_score',
    'duolingo_production_score',
    'Gap Years',
    'Backlogs',
  ]) {
    if (!row[column]) row[column] = column === 'Partner' ? 'Not applicable unless listed by official program source' : notPublished;
  }
  row['Remarks (if any)'] = `Checked ${CHECKED_DATE}; official UC program-finder JSON plus UC graduate admissions requirements. Exact test subscores, intake months, gap years, and backlogs are not available university-wide.`;
  row['Reference Links (if any)'] = references.join(' | ');
  return row;
}

function validateRecord(row) {
  for (const column of ['Course Name', 'Course URL', 'University \nname', 'Degree Level', 'Study Level', 'Reference Links (if any)']) {
    if (!row[column]?.trim()) throw new CommandExecutionError(`UC row is missing required field: ${column}`);
  }
  if (row['Study Level'] !== 'PG') throw new CommandExecutionError('UC row Study Level must be PG');
  if (!/^https:\/\/(?:www\.)?.*uc\.edu\//i.test(row['Course URL'])) {
    throw new CommandExecutionError(`UC row has invalid Course URL: ${row['Course URL']}`);
  }
  return row;
}

cli({
  site: 'cincinnati',
  name: 'export-postgraduate-courses',
  description: 'Export University of Cincinnati graduate and professional programs from official public sources.',
  access: 'read',
  example: 'webcmd cincinnati export-postgraduate-courses --degree-level masters --count 10 -f csv',
  domain: 'www.grad.uc.edu',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'degree-level', type: 'string', default: 'all', help: 'all, masters, certificate, diploma, professional, or doctorate' },
    { name: 'count', type: 'int', required: false, help: 'Positive maximum number of programs after filtering and deduplication' },
  ],
  columns: OUTPUT_COLUMNS,
  func: async (args) => {
    const { degreeLevel, count } = parseOptions(args);
    const selected = [];
    const seen = new Set();
    for (const program of await fetchPrograms()) {
      const tags = degreeTags(program);
      if (!tags.length || (degreeLevel !== 'all' && !tags.includes(degreeLevel))) continue;
      const row = validateRecord(normalizeRecord(program));
      if (seen.has(row['Course URL'])) continue;
      seen.add(row['Course URL']);
      selected.push(CSV_OUTPUT
        ? Object.fromEntries(COLUMNS.map((column, index) => [OUTPUT_COLUMNS[index], row[column]]))
        : row);
      if (count !== null && selected.length >= count) break;
    }
    return selected;
  },
});
