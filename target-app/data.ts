/**
 * Seed data for the CU-Core Back Office stand-in.
 *
 * Everything here is obviously synthetic. No real names, no real SSNs, no real
 * account numbers. Member IDs are 6 digits; account numbers are NNNN-NNNNNN.
 */

export type Account = {
  number: string;
  type: 'Share Savings' | 'Share Draft' | 'Money Market' | 'Certificate';
  balance: number;
  opened: string;
};

export type Member = {
  id: string;
  name: string;
  since: string;
  branch: string;
  status: 'Active' | 'Dormant' | 'Restricted';
  accounts: Account[];
};

const MEMBERS: Member[] = [
  {
    id: '100482', name: 'Testerson, Ada Q.', since: '2014-03-11', branch: 'Riverbend',
    status: 'Active',
    accounts: [
      { number: '0001-100482', type: 'Share Savings', balance: 4820.55, opened: '2014-03-11' },
      { number: '0002-100482', type: 'Share Draft', balance: 1230.10, opened: '2016-07-02' },
    ],
  },
  {
    id: '100483', name: 'Sample, Brody N.', since: '2019-11-01', branch: 'Northgate',
    status: 'Active',
    accounts: [{ number: '0001-100483', type: 'Share Savings', balance: 210.00, opened: '2019-11-01' }],
  },
  {
    id: '100484', name: 'Fixture, Corinne', since: '2008-01-22', branch: 'Riverbend',
    status: 'Restricted',
    accounts: [{ number: '0001-100484', type: 'Share Savings', balance: 91234.87, opened: '2008-01-22' }],
  },
  {
    id: '100485', name: 'Placeholder, Dev', since: '2022-05-30', branch: 'Westfield',
    status: 'Dormant',
    accounts: [{ number: '0001-100485', type: 'Share Savings', balance: 5.00, opened: '2022-05-30' }],
  },
];

export const MINIMUM_OPENING_DEPOSIT = 25;

export const SUB_ACCOUNT_TYPES = [
  'Share Savings',
  'Money Market',
  'Certificate',
  'Holiday Club',
] as const;

export function findMember(id: string): Member | undefined {
  return MEMBERS.find((m) => m.id === id.trim());
}

/** Sub-accounts opened during this process run. Reset when the server restarts. */
const opened = new Map<string, { number: string; confirmation: string; effective: string }>();

export function openSubAccount(memberId: string, type: string): { number: string; confirmation: string; effective: string } {
  const member = findMember(memberId)!;
  const seq = String(member.accounts.length + opened.size + 1).padStart(4, '0');
  const record = {
    number: `${seq}-${memberId}`,
    // Deterministic so replay evidence is diffable: derived from inputs, not random.
    confirmation: `SA-${memberId}-${type.replace(/\W/g, '').slice(0, 4).toUpperCase()}`,
    effective: new Date().toISOString().slice(0, 10),
  };
  opened.set(record.number, record);
  return record;
}
