// Helpers for the company website we use as background context, and the
// work email domain that identifies a company.

const PERSONAL_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "hotmail.co.uk",
  "live.com",
  "live.co.uk",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "yahoo.com",
  "yahoo.co.uk",
  "ymail.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "zoho.com",
  "fastmail.com",
  "hey.com",
  "yandex.com",
  "btinternet.com",
  "sky.com",
  "virginmedia.com",
]);

/** The company domain for a work email ("ahmed@CedarLegacy.com" → "cedarlegacy.com"); null for personal email providers. */
export function companyDomainFromEmail(email: string): string | null {
  const domain = email.split("@")[1]?.toLowerCase().trim();
  if (!domain || !domain.includes(".") || PERSONAL_EMAIL_DOMAINS.has(domain)) return null;
  return domain;
}

/** Guesses a company website from a work email address; null for personal email providers. */
export function websiteFromEmail(email: string): string | null {
  const domain = companyDomainFromEmail(email);
  return domain ? `https://${domain}` : null;
}

/** Accepts "acme.com", "www.acme.com/about" or a full URL; returns a normalized https URL or null. */
export function normalizeWebsite(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (!url.hostname.includes(".")) return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}
