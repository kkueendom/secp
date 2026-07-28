import assert from 'node:assert/strict';
import {
  balanceNewsBySource,
  deduplicateAllNews,
  normalizeDate,
  refreshExistingNews,
  scoreRegulatoryRelevance,
  shouldAcceptAnalyzedNews
} from './scrape-secp.js';

const relevant = {
  title: 'Finance Minister launches Access to Finance framework with SECP and SBP',
  excerpt: 'The plan expands SME credit, digital finance and credit bureau integration.',
  source: 'Government of Pakistan (PID)'
};

const irrelevant = {
  title: 'K-Electric announces 10-hour power outage in Karachi',
  excerpt: 'Customers should check the affected areas.',
  source: 'TechJuice'
};

const mobileTax = {
  title: 'Mobile users lose a third of every recharge to taxes',
  excerpt: 'Pakistan telecom customers face higher package prices.',
  source: 'TechJuice'
};

const directRegulatorySignal = {
  title: 'PVARA provides modern regulations for digital assets',
  excerpt: 'The Finance Minister announced a new regulatory framework in Pakistan.',
  source: 'Business Recorder'
};

assert.ok(scoreRegulatoryRelevance(relevant) >= 0.6, 'direct finance policy should be retained');
assert.ok(scoreRegulatoryRelevance(irrelevant) < 0.38, 'power outage should be rejected');
assert.ok(scoreRegulatoryRelevance(mobileTax) < 0.38, 'mobile recharge tax should be rejected');
assert.equal(shouldAcceptAnalyzedNews({ ...irrelevant, relevanceScore: 0.95 }), false, 'AI must not override a failed rule gate');
assert.equal(shouldAcceptAnalyzedNews({ ...relevant, relevanceScore: 0.52 }), true, 'qualified policy news should survive a conservative AI score');
assert.equal(shouldAcceptAnalyzedNews({ ...directRegulatorySignal, relevanceScore: 0.42 }), true, 'strong deterministic regulatory signals should not be vetoed by AI');
assert.equal(normalizeDate('Mon, 27 Jul 2026 10:35:43 GMT'), '2026/7/27');

const refreshed = refreshExistingNews(
  [{ title: 'Truncated title', link: 'https://pid.gov.pk/site/press_detail/1', summary: 'Keep analysis', relevanceScore: 0.3 }],
  [{ title: 'Complete official policy title', link: 'https://pid.gov.pk/site/press_detail/1', source: 'Government of Pakistan (PID)', ruleScore: 0.67 }]
);
assert.equal(refreshed[0].title, 'Complete official policy title');
assert.equal(refreshed[0].summary, 'Keep analysis');
assert.equal(refreshed[0].relevanceScore, 0.67);

const duplicateItems = deduplicateAllNews([
  { title: 'SECP issues new lending rules - Dawn', link: 'https://example.com/a?utm_source=x' },
  { title: 'SECP issues new lending rules', link: 'https://example.com/a' }
]);
assert.equal(duplicateItems.length, 1, 'tracking URLs and title suffixes should deduplicate');

const balanced = balanceNewsBySource([
  ...Array.from({ length: 4 }, (_, index) => ({
    title: `Tech story ${index}`,
    link: `https://tech.example/${index}`,
    date: `2026/7/${27 - index}`,
    source: 'TechJuice',
    relevanceScore: 0.8
  })),
  {
    title: 'Official lending update',
    link: 'https://secp.gov.pk/update',
    date: '2026/7/26',
    source: 'SECP Official',
    relevanceScore: 0.9
  },
  {
    title: 'Finance policy update',
    link: 'https://pid.gov.pk/update',
    date: '2026/7/25',
    source: 'Government of Pakistan (PID)',
    relevanceScore: 0.85
  }
]);
assert.equal(balanced.filter(item => item.source === 'TechJuice').length, 2, 'non-official source cap should apply');
assert.ok(balanced.some(item => item.source === 'SECP Official'), 'official source should be preserved');

console.log('Scraper logic tests passed');
