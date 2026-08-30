/**
 * Two tenants running the SAME vendor product (CU-Core 8.2), configured and
 * branded differently -- the stand-in for "hundreds of tenants, many on the same
 * underlying product". Tenant B is what the TenantOverlay has to absorb.
 */

export type TenantConfig = {
  id: string;
  institution: string;
  /** Which release of the vendor product this instance is running. Overridable
   *  with --version, so the "this tenant upgraded ahead of the others" case can
   *  actually be demonstrated rather than described. */
  productVersion?: string;
  /** Labels an operator sees. Tenant B renames things, which is the whole point. */
  labels: {
    memberIdField: string;
    searchButton: string;
    newSubAccount: string;
    accountType: string;
    openingDeposit: string;
    submitReview: string;
    confirmOpen: string;
  };
  /** Tenant B interposes a compliance banner after login. */
  loginInterstitial: boolean;
  accent: string;
};

export const TENANTS: Record<string, TenantConfig> = {
  a: {
    id: 'riverbend-cu',
    institution: 'Riverbend Credit Union',
    labels: {
      memberIdField: 'Member No.',
      searchButton: 'Search',
      newSubAccount: 'New Sub-Account',
      accountType: 'Account Type',
      openingDeposit: 'Opening Deposit',
      submitReview: 'Continue',
      confirmOpen: 'Open Account',
    },
    loginInterstitial: false,
    accent: '#123f6d',
  },
  b: {
    id: 'northstar-fcu',
    institution: 'Northstar Federal Credit Union',
    labels: {
      memberIdField: 'Account Number',
      searchButton: 'Find Member',
      newSubAccount: 'Open Sub Account',
      accountType: 'Product',
      openingDeposit: 'Initial Deposit',
      submitReview: 'Next',
      confirmOpen: 'Submit Request',
    },
    loginInterstitial: true,
    accent: '#6d3312',
  },
};
