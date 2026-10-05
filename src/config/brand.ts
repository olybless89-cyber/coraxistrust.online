// Central brand configuration for this deployment.
// Every user-visible brand string should be sourced from here rather than
// hard-coded, so the identity can be changed in one place.

export const BRAND = {
  name: 'Coraxis Trust',
  shortName: 'Coraxis',
  domain: 'coraxistrust.online',
  url: 'https://coraxistrust.online',
  tagline: 'Premium Digital Banking',
  description:
    'Coraxis Trust — premium digital banking. Accounts, transfers, deposits, withdrawals, debit cards and investments.',
  email: {
    support: 'support@coraxistrust.online',
    security: 'security@coraxistrust.online',
    noreply: 'noreply@coraxistrust.online',
  },
  address: 'Bahnhofstrasse 1, 8001 Zürich, Switzerland',
  accountPrefix: 'CXT',
  social: {
    twitter: 'https://twitter.com/coraxistrust',
    facebook: 'https://facebook.com/coraxistrust',
    instagram: 'https://instagram.com/coraxistrust',
    youtube: 'https://youtube.com/@coraxistrust',
    linkedin: 'https://linkedin.com/company/coraxistrust',
  },
} as const;

export type Brand = typeof BRAND;

// Account types offered when opening an account. Kept in one place so the
// register form, the admin create-user dialog and the API stay in step.
export const ACCOUNT_TYPES = [
  'savings',
  'checking',
  'corporate',
  'student',
  'joint',
  'fixed',
  'crypto',
  'investment',
  'trust',
] as const;

export const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  savings: 'Savings',
  checking: 'Checking',
  corporate: 'Corporate',
  student: 'Student',
  joint: 'Joint',
  fixed: 'Fixed',
  crypto: 'Crypto',
  investment: 'Investment',
  trust: 'Trust',
};
