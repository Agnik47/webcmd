import { cli, Strategy } from '@agentrhq/webcmd/registry';
import {
  ArgumentError,
  CommandExecutionError,
} from '@agentrhq/webcmd/errors';
import { resolve4 } from 'node:dns/promises';
import { Agent } from 'undici';

const BASE = 'https://www.uni-goettingen.de';
const CATALOGUE_URL = `${BASE}/en/3811.html`;
const COURSES_API = `${BASE}/api/v1/get/courses/language/en`;
const UNIVERSITY = 'University of Göttingen';
const CHECKED_DATE = '2026-08-03';
const DEGREE_LEVELS = new Set(['all', 'masters', 'certificate', 'diploma', 'professional', 'doctorate']);
const DNS_DISPATCHER = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      resolve4(hostname).then(
        (addresses) => options?.all
          ? callback(null, addresses.map((address) => ({ address, family: 4 })))
          : callback(null, addresses[0], 4),
        callback,
      );
    },
  },
});

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

async function fetchCourses() {
  const response = await fetch(COURSES_API, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Webcmd Goettingen public data export)' },
    dispatcher: DNS_DISPATCHER,
  });
  if (!response.ok) throw new CommandExecutionError(`Göttingen course API failed: HTTP ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data.courses)) throw new CommandExecutionError('Göttingen course API changed: missing courses array');
  return data.courses;
}

function urlFor(course) {
  return `${BASE}/en/${course.page_id}.html`;
}

function degreeNames(course) {
  return (course.diploma?.degree || []).map((degree) => degree.name);
}

function tagsFor(course) {
  const ids = new Set((course.diploma?.degree || []).map((degree) => String(degree.id)));
  const label = `${course.name} ${course.diploma?.name || ''} ${course.diploma?.title || ''}`.toLowerCase();
  const tags = new Set();
  if (ids.has('5') || ids.has('6') || /master/.test(label)) tags.add('masters');
  if (ids.has('7') || /phd|ph\\.d|promotion|doctor/.test(label)) tags.add('doctorate');
  if (/zertifikat|certificate/.test(label)) tags.add('certificate');
  if (/diploma|diplom/.test(label)) tags.add('diploma');
  if (/approbation|psychotherapy/.test(label)) tags.add('professional');
  return [...tags];
}

function durationMonths(course) {
  const duration = (course.course_keywords || [])
    .find((keyword) => /Regelstudienzeit|Standard period/i.test(keyword.keyword_group || ''))?.keyword;
  return /^\d+(\.\d+)?$/.test(String(duration || '')) ? String(Number(duration) * 6) : '';
}

function intake(course) {
  const terms = [];
  if (course.start_winter === '1') terms.push('Winter semester');
  if (course.start_summer === '1') terms.push('Summer semester');
  return terms.join(' | ');
}

function languages(course) {
  return (course.course_languages || []).map((language) => language.name || language.iso_639_1).filter(Boolean);
}

function admission(course) {
  const current = [...(course.course_application_processes || [])]
    .sort((a, b) => Number(b.semester_id) - Number(a.semester_id))[0];
  return current?.application_process_name || '';
}

function normalize(course) {
  const row = Object.fromEntries(COLUMNS.map((column) => [column, '']));
  const degree = [course.diploma?.name, course.diploma?.title].filter(Boolean).join(' ');
  const refs = [`Course: ${urlFor(course)}`, `Catalogue: ${CATALOGUE_URL}`, `API: ${COURSES_API}`];
  row['Course Name'] = course.name;
  row['Course URL'] = urlFor(course);
  row['University \nname'] = UNIVERSITY;
  row['Intake Month'] = intake(course);
  row['Substream/\nSpecialisation'] = [course.discipline?.name, course.faculty?.name].filter(Boolean).join(' | ');
  row['Degree Level'] = degree;
  row['Study Level'] = 'PG';
  row['Duration\n(in months)'] = durationMonths(course);
  row['Study option'] = languages(course).length ? `Teaching language: ${languages(course).join(' | ')}` : '';
  row['Program Type'] = degreeNames(course).join(' | ') || course.diploma?.name || '';
  row['Main Entry \nRequirements'] = admission(course);
  row['Status'] = course.valid_until ? 'Ending/limited in official API' : 'Official listing active';
  row['Remarks (if any)'] = `Checked ${CHECKED_DATE}; official Göttingen A-Z degree-programme API. Teaching language and admission route are populated from the API. Fees/application charges, language-test scores, GRE/GMAT, school/UG-score conventions, gaps, backlogs, work experience, waivers, and MOI acceptance are not available as programme-safe values in this official API.`;
  row['Reference Links (if any)'] = refs.join(' | ');
  const unavailable = 'Not available as a programme-safe value in official Göttingen API';
  for (const column of [
    'Intake Month',
    'App fees',
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
    'Duration\n(in months)',
    'Intake status(open/close)\n(eg: Fall (september)-Open\nSpring(January)- Closed)',
  ]) if (!row[column]) row[column] = column === 'Partner' ? 'Not applicable unless listed by official programme source' : unavailable;
  return row;
}

function validate(row) {
  for (const column of ['Course Name', 'Course URL', 'University \nname', 'Degree Level', 'Study Level', 'Reference Links (if any)']) {
    if (!row[column]?.trim()) throw new CommandExecutionError(`Göttingen row is missing required field: ${column}`);
  }
  if (!/^https:\/\/www\.uni-goettingen\.de\/en\/\d+\.html$/.test(row['Course URL'])) {
    throw new CommandExecutionError(`Göttingen row has invalid course URL: ${row['Course URL']}`);
  }
  if (row['Study Level'] !== 'PG') throw new CommandExecutionError('Göttingen row Study Level must be PG');
  return row;
}

cli({
  site: 'goettingen',
  name: 'export-postgraduate-courses',
  description: 'Export University of Göttingen postgraduate programmes from the official A-Z API.',
  access: 'read',
  example: 'webcmd goettingen export-postgraduate-courses --degree-level masters --count 10 -f csv',
  domain: 'www.uni-goettingen.de',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'degree-level', type: 'string', default: 'all', help: 'all, masters, certificate, diploma, professional, or doctorate' },
    { name: 'count', type: 'int', required: false, help: 'Positive maximum number of programmes after filtering and deduplication' },
  ],
  columns: OUTPUT_COLUMNS,
  func: async (args) => {
    const { degreeLevel, count } = parseOptions(args);
    const seen = new Set();
    const rows = [];
    for (const course of await fetchCourses()) {
      const tags = tagsFor(course);
      if (!tags.length || (degreeLevel !== 'all' && !tags.includes(degreeLevel))) continue;
      const url = urlFor(course);
      if (seen.has(url)) continue;
      seen.add(url);
      const row = validate(normalize(course));
      rows.push(CSV_OUTPUT
        ? Object.fromEntries(COLUMNS.map((column, index) => [OUTPUT_COLUMNS[index], row[column]]))
        : row);
      if (count !== null && rows.length >= count) break;
    }
    return rows;
  },
});
