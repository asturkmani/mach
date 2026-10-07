import { describe, expect, it } from "vitest";

import { companyDomainFromEmail, websiteFromEmail } from "./website";

describe("companyDomainFromEmail", () => {
  it("returns the lowercased domain of a work email", () => {
    expect(companyDomainFromEmail("ahmed@CedarLegacy.com")).toBe("cedarlegacy.com");
    expect(companyDomainFromEmail("lina@farmlend.co.uk")).toBe("farmlend.co.uk");
  });

  it("returns null for personal providers and malformed addresses", () => {
    expect(companyDomainFromEmail("ahmed@gmail.com")).toBeNull();
    expect(companyDomainFromEmail("ahmed@hotmail.co.uk")).toBeNull();
    expect(companyDomainFromEmail("ahmed@localhost")).toBeNull();
    expect(companyDomainFromEmail("not-an-email")).toBeNull();
  });

  it("drives the website guess", () => {
    expect(websiteFromEmail("ahmed@cedarlegacy.com")).toBe("https://cedarlegacy.com");
    expect(websiteFromEmail("ahmed@icloud.com")).toBeNull();
  });
});
