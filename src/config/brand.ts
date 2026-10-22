// Central brand configuration for this deployment.
// Every user-visible brand string should be sourced from here rather than
// hard-coded, so the identity can be changed in one place.

export const BRAND = {
  name: 'Westfield Trust',
  shortName: 'Westfield',
  domain: 'westfieldtrustbnk.com',
  url: 'https://westfieldtrustbnk.com',
  tagline: 'Premium Digital Banking',
  description:
    'Westfield Trust — premium digital banking. Accounts, transfers, deposits, withdrawals, debit cards and investments.',
  email: {
    support: 'support@westfieldtrustbnk.com',
    security: 'security@westfieldtrustbnk.com',
    noreply: 'noreply@westfieldtrustbnk.com',
  },
  address: 'Bahnhofstrasse 1, 8001 Zürich, Switzerland',
  accountPrefix: 'CXT',
  social: {
    twitter: 'https://twitter.com/westfieldtrust',
    facebook: 'https://facebook.com/westfieldtrust',
    instagram: 'https://instagram.com/westfieldtrust',
    youtube: 'https://youtube.com/@westfieldtrust',
    linkedin: 'https://linkedin.com/company/westfieldtrust',
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
